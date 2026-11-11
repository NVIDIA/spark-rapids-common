#!/usr/bin/env python3
# Copyright (c) 2026, NVIDIA CORPORATION.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Collect an exact Sonar analysis without coupling unrelated pull requests."""

import base64
from datetime import timezone
from email.utils import parsedate_to_datetime
from http.client import IncompleteRead
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class ValidationError(ValueError):
    """Locally constructed diagnostics that never contain response bodies."""


def require(condition, message):
    if not condition:
        raise ValidationError(message)


def safe_text(value, maximum, empty=False):
    return (
        isinstance(value, str)
        and (empty or bool(value))
        and len(value) <= maximum
        and re.search(r"[\x00-\x1f\x7f]", value) is None
    )


def service_url(value):
    url = urllib.parse.urlsplit(value)
    require(
        url.scheme == "https"
        and url.hostname
        and not url.username
        and not url.password
        and not url.query
        and not url.fragment
        and not any(c.isspace() for c in value),
        "Invalid Sonar service URL",
    )
    return value.rstrip("/")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise ValidationError("Sonar API redirected; credentials were not forwarded")


def retry_delay(value):
    """Honor server delays; malformed or absent hints keep the existing backoff."""
    if not isinstance(value, str):
        return 3
    value = value.strip()
    if re.fullmatch(r"[0-9]+", value):
        # Oversized delays become infinity and fail the remaining-budget check.
        return float(value)
    try:
        date = parsedate_to_datetime(value)
        if date.tzinfo is None:
            date = date.replace(tzinfo=timezone.utc)
        return max(0, date.timestamp() - time.time())
    except (TypeError, ValueError, OverflowError):
        return 3


class Sonar:
    def __init__(self, host, token):
        self.host = service_url(host)
        require(bool(token), "A Sonar token is required")
        self.authorization = (
            "Basic " + base64.b64encode((token + ":").encode()).decode()
        )
        self.opener = urllib.request.build_opener(NoRedirect())
        self.deadline = time.monotonic() + 600

    def get(self, endpoint, **params):
        url = self.host + "/api/" + endpoint + "?" + urllib.parse.urlencode(params)
        request = urllib.request.Request(
            url, headers={"Authorization": self.authorization}
        )
        for attempt in range(3):
            remaining = self.deadline - time.monotonic()
            require(remaining > 0, "Sonar result collection timed out")
            delay = 3
            try:
                with self.opener.open(request, timeout=min(30, remaining)) as response:
                    body = response.read(8 * 1024 * 1024 + 1)
                    require(
                        time.monotonic() <= self.deadline,
                        "Sonar result collection timed out",
                    )
                    require(
                        len(body) <= 8 * 1024 * 1024,
                        "Sonar response exceeds the size limit",
                    )
                    return json.loads(body)
            except urllib.error.HTTPError as error:
                try:
                    if error.code not in (408, 429, 502, 503, 504) or attempt == 2:
                        raise
                    delay = retry_delay((error.headers or {}).get("Retry-After"))
                finally:
                    error.close()
            except (
                urllib.error.URLError,
                TimeoutError,
                ConnectionError,
                IncompleteRead,
            ):
                if attempt == 2:
                    raise
            require(
                delay < self.deadline - time.monotonic(),
                "Sonar retry delay does not fit the remaining collection budget",
            )
            print(
                f"Retrying Sonar read ({attempt + 2}/3) after {delay:g}s.",
                file=sys.stderr,
            )
            time.sleep(delay)
        raise ValidationError("Sonar request did not complete")


def validate_context(context, result):
    require(
        isinstance(context, str),
        "Scanner context is unavailable; check Sonar analysis permissions",
    )
    expected = {
        "sonar.projectKey": result["project"],
        "sonar.pullrequest.key": str(result["pr"]),
        "sonar.pullrequest.base": result["baseRef"],
        "sonar.scm.revision": result["sha"],
    }
    # Module sections have their own project keys; only the root binds this scan.
    observed = {}
    root_seen = False
    in_root = False
    for line in context.splitlines():
        if line == "Project scanner properties:":
            require(not root_seen, "Duplicate root scanner properties section")
            root_seen = True
            in_root = True
            continue
        if line and not line[0].isspace():
            in_root = False
        if not in_root:
            continue
        match = re.fullmatch(
            r"  - (sonar\.projectKey|sonar\.pullrequest\.(?:key|base)|sonar\.scm\.revision)=(.*)",
            line,
        )
        if match:
            require(
                match[1] not in observed, "Duplicate root scanner identity property"
            )
            value = match[2]
            observed[match[1]] = (
                value.lower() if match[1] == "sonar.scm.revision" else value
            )
    require(
        root_seen and observed == expected,
        "Root scanner project, pull request, target branch or revision does not match approval",
    )


def issue_details(sonar, result):
    """Best-effort current PR details; these APIs have no analysis-ID filter."""

    def still_current():
        current = sonar.get("ce/component", component=result["project"]).get(
            "current", {}
        )
        require(
            current.get("id") == result["taskId"]
            and current.get("analysisId") == result["analysisId"]
            and current.get("status") == "SUCCESS"
            and str(current.get("pullRequest")) == str(result["pr"]),
            "Issue details are no longer current",
        )

    still_current()
    issues, seen, total = [], set(), None
    severity_order = {"BLOCKER": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "INFO": 4}
    for page in range(1, 21):
        response = sonar.get(
            "issues/search",
            components=result["project"],
            pullRequest=str(result["pr"]),
            inNewCodePeriod="true",
            issueStatuses="OPEN,CONFIRMED",
            p=page,
            ps=500,
        )
        count = response["paging"]["total"]
        require(type(count) is int and 0 <= count <= 10000, "Unsupported issue count")
        require(
            total is None or count == total, "Issue count changed during collection"
        )
        total = count
        rows = response.get("issues", [])
        require(isinstance(rows, list) and len(rows) <= 500, "Invalid issue page")
        for issue in rows:
            require(
                issue.get("project") == result["project"]
                and str(issue.get("pullRequest")) == str(result["pr"]),
                "Unexpected issue identity",
            )
            key = issue["key"]
            require(
                safe_text(key, 400) and key not in seen, "Invalid or duplicate issue"
            )
            seen.add(key)
            prefix = result["project"] + ":"
            component = issue["component"]
            require(
                isinstance(component, str)
                and (component == result["project"] or component.startswith(prefix)),
                "Unexpected issue component",
            )
            path = "" if component == result["project"] else component[len(prefix) :]
            require(
                safe_text(path, 2048, empty=True)
                and (
                    not path
                    or (
                        not path.startswith("/")
                        and "\\" not in path
                        and not any(part in (".", "..", "") for part in path.split("/"))
                    )
                ),
                "Invalid issue path",
            )
            line = issue.get("line")
            require(
                line is None or (type(line) is int and 0 < line <= 9007199254740991),
                "Invalid issue line",
            )
            impacts = issue.get("impacts", [])
            require(
                isinstance(impacts, list)
                and len(impacts) <= 10
                and all(
                    isinstance(item, dict)
                    and item.get("severity") in severity_order
                    and safe_text(item.get("softwareQuality"), 100)
                    for item in impacts
                ),
                "Invalid issue impacts",
            )
            require(
                safe_text(issue.get("rule"), 400)
                and isinstance(issue.get("message"), str),
                "Invalid issue description",
            )
            legacy_severity, legacy_type = issue.get("severity", ""), issue.get(
                "type", ""
            )
            require(
                safe_text(legacy_severity, 100, empty=True)
                and safe_text(legacy_type, 100, empty=True),
                "Invalid legacy issue details",
            )
            issues.append(
                {
                    "key": key,
                    "rule": issue["rule"],
                    "message": issue["message"][:500],
                    "path": path,
                    "line": line,
                    "impacts": impacts,
                    "legacySeverity": legacy_severity,
                    "legacyType": legacy_type,
                }
            )
            issues.sort(
                key=lambda row: min(
                    (severity_order[item["severity"]] for item in row["impacts"]),
                    default=5,
                )
            )
            del issues[10:]
        if len(seen) == total:
            break
        require(rows and len(seen) < total, "Incomplete issue pagination")
    require(len(seen) == total, "Incomplete issue pagination")
    still_current()
    return issues, total


def collect(sonar, result, task_file, scanner_outcome):
    project, pr = result["project"], str(result["pr"])
    require(task_file.stat().st_size <= 65536, "Scanner task file is too large")
    properties = {}
    for line in task_file.read_text().splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            require(
                key not in properties or properties[key] == value,
                "Conflicting scanner task properties",
            )
            properties[key] = value

    require(properties.get("projectKey") == project, "Unexpected scanner project")
    require(
        properties.get("serverUrl", "").rstrip("/") == sonar.host,
        "Unexpected scanner server",
    )
    dashboard = urllib.parse.urlsplit(properties.get("dashboardUrl", ""))
    expected = urllib.parse.urlsplit(sonar.host)
    query = urllib.parse.parse_qs(dashboard.query)
    require(
        (dashboard.scheme, dashboard.netloc, dashboard.path.rstrip("/"))
        == (expected.scheme, expected.netloc, expected.path.rstrip("/") + "/dashboard")
        and not dashboard.username
        and not dashboard.password
        and not dashboard.fragment
        and query.get("id") == [project]
        and query.get("pullRequest") == [pr],
        "Unexpected scanner pull request",
    )
    task_id = properties.get("ceTaskId", "")
    require(
        len(task_id) <= 200 and re.fullmatch(r"[A-Za-z0-9_-]+", task_id),
        "Missing or invalid CE task ID",
    )
    while True:
        task = sonar.get("ce/task", id=task_id, additionalFields="scannerContext")[
            "task"
        ]
        require(
            task.get("id") == task_id
            and task.get("componentKey") == project
            and str(task.get("pullRequest")) == pr,
            "Unexpected CE task identity",
        )
        if task.get("status") == "SUCCESS":
            break
        require(
            task.get("status") in ("PENDING", "IN_PROGRESS"),
            "Sonar analysis did not complete",
        )
        require(time.monotonic() < sonar.deadline, "Sonar analysis timed out")
        time.sleep(3)

    validate_context(task.get("scannerContext"), result)
    analysis_id = task.get("analysisId")
    require(
        safe_text(analysis_id, 200) and re.fullmatch(r"[A-Za-z0-9_-]+", analysis_id),
        "Missing analysis ID",
    )
    gate = sonar.get("qualitygates/project_status", analysisId=analysis_id)[
        "projectStatus"
    ]
    require(
        gate.get("status") in ("OK", "ERROR", "WARN", "NONE"),
        "Unknown quality gate result",
    )
    counts = {}
    for severity in ("high", "blocker"):
        conditions = [
            item
            for item in gate.get("conditions", [])
            if item.get("metricKey") == "new_software_quality_" + severity + "_issues"
        ]
        require(
            len(conditions) == 1
            and conditions[0].get("comparator") == "GT"
            and conditions[0].get("errorThreshold") == "0",
            "Expected High/Blocker quality gate policy is missing or changed",
        )
        value = conditions[0].get("actualValue", "")
        require(
            isinstance(value, str)
            and re.fullmatch(r"[0-9]+", value)
            and int(value) <= 9007199254740991,
            "Invalid quality gate issue count",
        )
        counts[severity] = int(value)

    result.update(
        complete=True,
        taskId=task_id,
        analysisId=analysis_id,
        gateStatus=gate["status"],
        high=counts["high"],
        blocker=counts["blocker"],
        reportUrl=(
            sonar.host
            + "/dashboard?"
            + urllib.parse.urlencode({"id": project, "pullRequest": pr})
        ),
    )
    result["passed"] = (
        scanner_outcome == "success"
        and gate["status"] == "OK"
        and counts["high"] == counts["blocker"] == 0
    )

    try:
        issues, total = issue_details(sonar, result)
        result.update(
            issues=issues,
            totalIssues=total,
            detailsComplete=True,
            detailsScope="current-pr",
            detailsCapturedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        )
    except Exception:
        # A newer analysis can make current details unhelpful. They are advisory,
        # never historical evidence and never a reason to fail the exact gate.
        print(
            "Issue details unavailable or changed; the exact analysis gate and counts remain valid.",
            file=sys.stderr,
        )


def main():
    environment = os.environ
    sha = environment.get("APPROVED_SHA", "")
    base_ref = environment.get("APPROVED_BASE_REF", "")
    repository = environment.get("GITHUB_REPOSITORY", "")
    pr = environment.get("PR_NUMBER", "")
    project = environment.get("SONAR_PROJECT_KEY", "")
    require(re.fullmatch(r"[a-fA-F0-9]{40}", sha), "Invalid approved SHA")
    require(
        safe_text(base_ref, 1024) and not any(c.isspace() for c in base_ref),
        "Invalid approved target branch",
    )
    require(
        re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository),
        "Invalid repository",
    )
    require(
        re.fullmatch(r"[1-9][0-9]*", pr) and int(pr) <= 9007199254740991,
        "Invalid pull request",
    )
    require(
        safe_text(project, 400) and not any(c.isspace() for c in project),
        "Invalid Sonar project",
    )
    for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"):
        require(
            re.fullmatch(r"[1-9][0-9]*", environment.get(key, "")),
            "Invalid GitHub run identity",
        )
    outcome = environment.get("SCANNER_OUTCOME", "")
    require(
        outcome in ("success", "failure", "cancelled", "skipped"),
        "Invalid scanner outcome",
    )
    output = Path(environment["RESULT_PATH"]).resolve()
    require(not any(c in str(output) for c in "\r\n"), "Invalid result path")
    result = {
        "schema": 2,
        "repository": repository,
        "sha": sha.lower(),
        "baseRef": base_ref,
        "pr": int(pr),
        "project": project,
        "runId": environment["GITHUB_RUN_ID"],
        "runAttempt": environment["GITHUB_RUN_ATTEMPT"],
        "complete": False,
        "passed": False,
        "detailsComplete": False,
        "totalIssues": None,
        "issues": [],
        "detailsScope": None,
        "detailsCapturedAt": None,
    }
    try:
        sonar = Sonar(
            environment.get("SONAR_URL", ""), environment.get("SONAR_TOKEN", "")
        )
        collect(sonar, result, Path(environment["REPORT_TASK_PATH"]), outcome)
    except Exception as error:
        detail = (
            str(error) if isinstance(error, ValidationError) else type(error).__name__
        )
        if isinstance(error, urllib.error.HTTPError):
            detail = f"HTTP {error.code}"
        print(f"Sonar result collection failed: {detail}.", file=sys.stderr)
        result["error"] = "Analysis could not be verified; see the collection step."

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result) + "\n")
    if environment.get("GITHUB_OUTPUT"):
        with open(environment["GITHUB_OUTPUT"], "a") as stream:
            stream.write(
                f"result-path={output}\npassed={str(result['passed']).lower()}\n"
                f"complete={str(result['complete']).lower()}\nsource-attempt={result['runAttempt']}\n"
            )
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(
            (
                str(error)
                if isinstance(error, ValidationError)
                else "Sonar collection could not write a result."
            ),
            file=sys.stderr,
        )
        sys.exit(1)
