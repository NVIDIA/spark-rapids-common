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

import contextlib
import copy
from email.utils import formatdate
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

SPEC = importlib.util.spec_from_file_location(
    "sonar_collect", Path(__file__).resolve().parents[1] / "collect.py"
)
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)
SHA = "a" * 40
BASE_REF = "release/26.12"
HOST = "https://sonar.example.com"


def result():
    return {
        "schema": 2,
        "repository": "example/project",
        "sha": SHA,
        "baseRef": BASE_REF,
        "pr": 42,
        "project": "project",
        "runId": "100",
        "runAttempt": "2",
        "complete": False,
        "passed": False,
        "detailsComplete": False,
        "issues": [],
        "totalIssues": None,
        "detailsScope": None,
        "detailsCapturedAt": None,
    }


class FakeSonar:
    host = HOST
    deadline = float("inf")

    def __init__(self):
        self.calls = []
        self.task = {
            "id": "task-1",
            "componentKey": "project",
            "pullRequest": "42",
            "status": "SUCCESS",
            "analysisId": "analysis-1",
            "scannerContext": (
                "Project scanner properties:\n"
                "  - sonar.projectKey=project\n"
                "  - sonar.pullrequest.key=42\n"
                f"  - sonar.pullrequest.base={BASE_REF}\n"
                f"  - sonar.scm.revision={SHA}\n"
                "  - sonar.token=NEVER_SERIALIZE_CONTEXT\n"
            ),
        }
        self.statuses = []
        self.gate = {
            "status": "OK",
            "conditions": [
                {
                    "metricKey": "new_software_quality_" + severity + "_issues",
                    "comparator": "GT",
                    "errorThreshold": "0",
                    "actualValue": "0",
                }
                for severity in ("high", "blocker")
            ],
        }
        self.current = {
            "id": "task-1",
            "analysisId": "analysis-1",
            "status": "SUCCESS",
            "pullRequest": "42",
        }
        self.current_reads = []
        self.issue_pages = [{"paging": {"total": 0}, "issues": []}]

    def get(self, endpoint, **params):
        self.calls.append((endpoint, params))
        if endpoint == "ce/task":
            assert params == {"id": "task-1", "additionalFields": "scannerContext"}
            task = copy.deepcopy(self.task)
            if self.statuses:
                task["status"] = self.statuses.pop(0)
            return {"task": task}
        if endpoint == "qualitygates/project_status":
            assert params == {"analysisId": "analysis-1"}
            return {"projectStatus": copy.deepcopy(self.gate)}
        if endpoint == "ce/component":
            assert params == {"component": "project"}
            return {
                "current": (
                    self.current_reads.pop(0) if self.current_reads else self.current
                )
            }
        if endpoint == "issues/search":
            assert params["pullRequest"] == "42" and params["components"] == "project"
            response = self.issue_pages.pop(0)
            if isinstance(response, Exception):
                raise response
            return response
        raise AssertionError("Unexpected API endpoint")


def issue(key="issue-1", severity="MEDIUM"):
    return {
        "key": key,
        "project": "project",
        "pullRequest": "42",
        "component": "project:src/a.py",
        "line": 7,
        "rule": "python:rule",
        "message": "An issue",
        "severity": "MAJOR",
        "type": "BUG",
        "impacts": [{"severity": severity, "softwareQuality": "RELIABILITY"}],
    }


class CollectionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.task_file = Path(self.directory.name) / "report-task.txt"
        self.task_file.write_text(
            f"projectKey=project\nserverUrl={HOST}\n"
            f"dashboardUrl={HOST}/dashboard?id=project&pullRequest=42\nceTaskId=task-1\n"
        )

    def collect(self, sonar=None, outcome="success"):
        evidence = result()
        with patch.object(collector.time, "sleep"), contextlib.redirect_stderr(
            io.StringIO()
        ):
            collector.collect(sonar or FakeSonar(), evidence, self.task_file, outcome)
        return evidence

    def test_exact_analysis_and_context_are_verified_without_serializing_secrets(self):
        sonar = FakeSonar()
        sonar.statuses = ["PENDING", "IN_PROGRESS", "SUCCESS"]
        evidence = self.collect(sonar)
        self.assertTrue(
            evidence["complete"] and evidence["passed"] and evidence["detailsComplete"]
        )
        self.assertEqual(evidence["analysisId"], "analysis-1")
        self.assertEqual(evidence["detailsScope"], "current-pr")
        self.assertRegex(
            evidence["detailsCapturedAt"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$"
        )
        self.assertNotIn("NEVER_SERIALIZE_CONTEXT", json.dumps(evidence))
        self.assertEqual(sum(endpoint == "ce/task" for endpoint, _ in sonar.calls), 3)

    def test_high_and_blocker_counts_fail_even_if_server_gate_says_ok(self):
        for index in (0, 1):
            with self.subTest(index=index):
                sonar = FakeSonar()
                sonar.gate["conditions"][index]["actualValue"] = "1"
                evidence = self.collect(sonar)
                self.assertTrue(evidence["complete"])
                self.assertFalse(evidence["passed"])

    def test_gate_or_scanner_failure_fails(self):
        for status in ("ERROR", "WARN", "NONE"):
            sonar = FakeSonar()
            sonar.gate["status"] = status
            self.assertFalse(self.collect(sonar)["passed"])
        for outcome in ("failure", "cancelled", "skipped"):
            self.assertFalse(self.collect(outcome=outcome)["passed"])

    def test_wrong_or_missing_task_and_scanner_identity_fail(self):
        for key, value in (
            ("id", "wrong"),
            ("componentKey", "other"),
            ("pullRequest", "43"),
            ("analysisId", ""),
            ("status", "FAILED"),
            ("scannerContext", None),
            (
                "scannerContext",
                FakeSonar().task["scannerContext"].replace(SHA, "b" * 40),
            ),
        ):
            with self.subTest(key=key, value=value):
                sonar = FakeSonar()
                sonar.task[key] = value
                with self.assertRaises(collector.ValidationError):
                    self.collect(sonar)

    def test_conflicting_context_and_task_properties_fail(self):
        sonar = FakeSonar()
        sonar.task["scannerContext"] += "  - sonar.pullrequest.key=43\n"
        with self.assertRaises(collector.ValidationError):
            self.collect(sonar)
        with self.task_file.open("a") as output:
            output.write("projectKey=other\n")
        with self.assertRaises(collector.ValidationError):
            self.collect()

    def test_root_identity_accepts_different_server_and_module_properties(self):
        sonar = FakeSonar()
        sonar.task["scannerContext"] = (
            "Plugins:\nGlobal server settings:\n"
            "  - sonar.projectKey=global\n"
            "Project server settings:\n"
            "  - sonar.projectKey=server\n"
            + sonar.task["scannerContext"]
            + "Scanner properties of module: child\n"
            "  - sonar.projectKey=child\n"
            "  - sonar.pullrequest.key=99\n"
            "  - sonar.pullrequest.base=main\n"
            f"  - sonar.scm.revision={'b' * 40}\n"
        )
        evidence = self.collect(sonar)
        self.assertTrue(evidence["complete"] and evidence["passed"])
        self.assertEqual(evidence["baseRef"], BASE_REF)

    def test_module_properties_cannot_supply_missing_root_identity(self):
        for property_line in (
            "  - sonar.projectKey=project\n",
            "  - sonar.pullrequest.key=42\n",
            f"  - sonar.pullrequest.base={BASE_REF}\n",
            f"  - sonar.scm.revision={SHA}\n",
        ):
            sonar = FakeSonar()
            sonar.task["scannerContext"] = (
                sonar.task["scannerContext"].replace(property_line, "")
                + "Scanner properties of module: child\n"
                + property_line
            )
            with self.subTest(property=property_line), self.assertRaises(
                collector.ValidationError
            ):
                self.collect(sonar)

    def test_missing_and_duplicate_root_sections_are_rejected(self):
        context = FakeSonar().task["scannerContext"]
        for invalid_context in (
            context.replace("Project scanner properties:\n", ""),
            context.replace("Project scanner properties:", "Project server settings:"),
            context + context,
            context
            + context.replace("sonar.projectKey=project", "sonar.projectKey=other"),
        ):
            sonar = FakeSonar()
            sonar.task["scannerContext"] = invalid_context
            with self.subTest(context=invalid_context), self.assertRaises(
                collector.ValidationError
            ):
                self.collect(sonar)

    def test_duplicate_root_identity_is_rejected_even_when_values_match(self):
        sonar = FakeSonar()
        sonar.task["scannerContext"] += "  - sonar.projectKey=project\n"
        with self.assertRaises(collector.ValidationError):
            self.collect(sonar)

    def test_wrong_or_missing_scanner_target_branch_is_rejected(self):
        for base_line in ("  - sonar.pullrequest.base=main\n", ""):
            sonar = FakeSonar()
            sonar.task["scannerContext"] = sonar.task["scannerContext"].replace(
                f"  - sonar.pullrequest.base={BASE_REF}\n", base_line
            )
            with self.subTest(base_line=base_line), self.assertRaises(
                collector.ValidationError
            ):
                self.collect(sonar)

    def test_missing_or_changed_quality_policy_and_counts_fail(self):
        mutations = [
            ("comparator", "LT"),
            ("errorThreshold", "1"),
            ("actualValue", "-1"),
            ("actualValue", "0.1"),
            ("actualValue", "9007199254740992"),
        ]
        for key, value in mutations:
            sonar = FakeSonar()
            sonar.gate["conditions"][0][key] = value
            with self.subTest(key=key), self.assertRaises(collector.ValidationError):
                self.collect(sonar)
        sonar = FakeSonar()
        sonar.gate["conditions"].pop()
        with self.assertRaises(collector.ValidationError):
            self.collect(sonar)

    def test_another_pr_before_collection_only_omits_details(self):
        sonar = FakeSonar()
        sonar.current = {"id": "other-task", "pullRequest": "99"}
        evidence = self.collect(sonar)
        self.assertTrue(evidence["complete"] and evidence["passed"])
        self.assertFalse(evidence["detailsComplete"])
        self.assertIsNone(evidence["totalIssues"])
        self.assertNotIn("issues/search", [endpoint for endpoint, _ in sonar.calls])

    def test_changed_analysis_during_collection_discards_details(self):
        sonar = FakeSonar()
        sonar.current_reads = [sonar.current, {"id": "other-task"}]
        sonar.issue_pages = [{"paging": {"total": 1}, "issues": [issue()]}]
        evidence = self.collect(sonar)
        self.assertTrue(evidence["passed"])
        self.assertEqual(evidence["issues"], [])
        self.assertFalse(evidence["detailsComplete"])

    def test_unavailable_or_malformed_issues_do_not_replace_exact_gate(self):
        for response in (
            RuntimeError("RAW_RESPONSE_MUST_NOT_LEAK"),
            *(
                {
                    "paging": {"total": 1},
                    "issues": [dict(issue(), component=component)],
                }
                for component in ("other", "other:file", "project-other:file")
            ),
            *(
                {
                    "paging": {"total": 1},
                    "issues": [dict(issue(), component="project:" + path)],
                }
                for path in (
                    "../secret",
                    "src/a\\b.py",
                    "src/./a.py",
                    "src/" + "a" * 2048,
                )
            ),
            {"paging": {"total": 1}, "issues": [dict(issue(), rule="r" * 401)]},
        ):
            sonar = FakeSonar()
            sonar.issue_pages = [response]
            evidence = self.collect(sonar)
            self.assertTrue(evidence["passed"])
            self.assertFalse(evidence["detailsComplete"])
            self.assertNotIn("RAW_RESPONSE", json.dumps(evidence))

    def test_project_and_file_details_are_preserved_without_changing_gate(self):
        sonar = FakeSonar()
        sonar.issue_pages = [
            {
                "paging": {"total": 2},
                "issues": [
                    dict(issue("project-issue"), component="project", line=None),
                    issue("file-issue"),
                ],
            }
        ]
        evidence = self.collect(sonar)
        self.assertTrue(evidence["complete"] and evidence["passed"])
        self.assertEqual((evidence["high"], evidence["blocker"]), (0, 0))
        self.assertTrue(evidence["detailsComplete"])
        self.assertEqual(evidence["totalIssues"], 2)
        self.assertEqual(
            [(row["key"], row["path"], row["line"]) for row in evidence["issues"]],
            [("project-issue", "", None), ("file-issue", "src/a.py", 7)],
        )

    def test_top_ten_details_and_medium_does_not_fail(self):
        sonar = FakeSonar()
        sonar.issue_pages = [
            {
                "paging": {"total": 12},
                "issues": [issue(str(index)) for index in range(12)],
            }
        ]
        evidence = self.collect(sonar)
        self.assertTrue(evidence["passed"] and evidence["detailsComplete"])
        self.assertEqual(len(evidence["issues"]), 10)
        self.assertEqual(evidence["totalIssues"], 12)

    def test_pagination_duplicates_are_rejected(self):
        sonar = FakeSonar()
        sonar.issue_pages = [{"paging": {"total": 2}, "issues": [issue()]}] * 2
        self.assertFalse(self.collect(sonar)["detailsComplete"])

    def test_main_always_writes_failure_evidence_after_analysis_error(self):
        output = Path(self.directory.name) / "evidence.json"
        outputs = Path(self.directory.name) / "outputs"
        environment = {
            "APPROVED_SHA": SHA,
            "APPROVED_BASE_REF": BASE_REF,
            "GITHUB_REPOSITORY": "example/project",
            "PR_NUMBER": "42",
            "SONAR_PROJECT_KEY": "project",
            "GITHUB_RUN_ID": "100",
            "GITHUB_RUN_ATTEMPT": "2",
            "SCANNER_OUTCOME": "success",
            "RESULT_PATH": str(output),
            "GITHUB_OUTPUT": str(outputs),
            "REPORT_TASK_PATH": str(self.task_file),
            "SONAR_URL": HOST,
            "SONAR_TOKEN": "PRIVATE_TOKEN",
        }
        error = urllib.error.HTTPError(HOST, 403, "PRIVATE_TOKEN", {}, None)
        stderr = io.StringIO()
        with patch.dict(os.environ, environment, clear=True), patch.object(
            collector, "Sonar", side_effect=error
        ), contextlib.redirect_stderr(stderr):
            self.assertEqual(collector.main(), 1)
        evidence = json.loads(output.read_text())
        self.assertFalse(evidence["complete"] or evidence["passed"])
        self.assertIn("source-attempt=2", outputs.read_text())
        self.assertNotIn("PRIVATE_TOKEN", output.read_text() + stderr.getvalue())

    def test_main_produces_versioned_evidence_and_action_outputs(self):
        output = Path(self.directory.name) / "evidence.json"
        outputs = Path(self.directory.name) / "outputs"
        environment = {
            "APPROVED_SHA": SHA,
            "APPROVED_BASE_REF": BASE_REF,
            "GITHUB_REPOSITORY": "example/project",
            "PR_NUMBER": "42",
            "SONAR_PROJECT_KEY": "project",
            "GITHUB_RUN_ID": "100",
            "GITHUB_RUN_ATTEMPT": "2",
            "SCANNER_OUTCOME": "success",
            "RESULT_PATH": str(output),
            "GITHUB_OUTPUT": str(outputs),
            "REPORT_TASK_PATH": str(self.task_file),
            "SONAR_URL": HOST,
            "SONAR_TOKEN": "PRIVATE_TOKEN",
        }
        with patch.dict(os.environ, environment, clear=True), patch.object(
            collector, "Sonar", return_value=FakeSonar()
        ):
            self.assertEqual(collector.main(), 0)
        evidence = json.loads(output.read_text())
        self.assertEqual(
            (
                evidence["schema"],
                evidence["repository"],
                evidence["sha"],
                evidence["baseRef"],
                evidence["runAttempt"],
            ),
            (2, "example/project", SHA, BASE_REF, "2"),
        )
        self.assertEqual(evidence["detailsScope"], "current-pr")
        self.assertIn(
            "passed=true\ncomplete=true\nsource-attempt=2", outputs.read_text()
        )
        self.assertNotIn("PRIVATE_TOKEN", output.read_text())

    def test_main_requires_valid_approved_target_branch(self):
        for base_ref in ("", "release candidate", "main\nother"):
            with patch.dict(
                os.environ,
                {"APPROVED_SHA": SHA, "APPROVED_BASE_REF": base_ref},
                clear=True,
            ), self.subTest(base_ref=base_ref), self.assertRaisesRegex(
                collector.ValidationError, "Invalid approved target branch"
            ):
                collector.main()

    def test_redirect_and_untrusted_service_urls_are_rejected(self):
        with self.assertRaises(collector.ValidationError):
            collector.NoRedirect().redirect_request(
                None, None, 302, "", {}, "https://other.example"
            )
        for host in (
            "http://sonar.example.com",
            "https://user:secret@sonar.example.com",
            HOST + "?token=secret",
            HOST + "#x",
        ):
            with self.subTest(host=host), self.assertRaises(collector.ValidationError):
                collector.Sonar(host, "secret")

    def test_safe_read_retries_are_bounded_and_auth_failures_are_not_retried(self):
        for status in (408, 429, 502, 503, 504, 401, 403, 404, 500):
            expected = 3 if status in (408, 429, 502, 503, 504) else 1
            responses = [io.BytesIO(b"PRIVATE_BODY") for _ in range(expected)]
            errors = [
                urllib.error.HTTPError(
                    HOST, status, "PRIVATE_MESSAGE", {"Retry-After": "10"}, response
                )
                for response in responses
            ]
            with self.subTest(status=status), patch.object(
                collector.time, "monotonic", return_value=0
            ), patch.object(collector.time, "sleep") as sleeping:
                sonar = collector.Sonar(HOST, "secret")
                with patch.object(
                    sonar.opener, "open", side_effect=errors
                ) as opening, self.assertRaises(urllib.error.HTTPError) as raised:
                    sonar.get("ce/task", id="task-1")
                self.assertIs(raised.exception, errors[-1])
                self.assertEqual(opening.call_count, expected)
                self.assertEqual(sleeping.call_count, expected - 1)
                self.assertTrue(all(response.closed for response in responses))

    def test_retry_after_seconds_recovers_at_the_requested_time(self):
        clock = [0]
        attempts = []
        rejected = io.BytesIO(b"PRIVATE_BODY")
        recovered = io.BytesIO(b'{"task": {"status": "SUCCESS"}}')
        error = urllib.error.HTTPError(
            HOST, 429, "PRIVATE_MESSAGE", {"Retry-After": "10"}, rejected
        )

        def open_request(request, timeout):
            attempts.append(clock[0])
            self.assertEqual(timeout, 30)
            if len(attempts) == 1:
                raise error
            return recovered

        def sleep(delay):
            self.assertTrue(rejected.closed)
            clock[0] += delay

        with patch.object(
            collector.time, "monotonic", side_effect=lambda: clock[0]
        ), patch.object(collector.time, "sleep", side_effect=sleep) as sleeping:
            sonar = collector.Sonar(HOST, "secret")
            with patch.object(sonar.opener, "open", side_effect=open_request):
                self.assertEqual(
                    sonar.get("ce/task", id="task-1"),
                    {"task": {"status": "SUCCESS"}},
                )
        self.assertEqual(attempts, [0, 10])
        sleeping.assert_called_once_with(10)
        self.assertTrue(rejected.closed and recovered.closed)

    def test_retry_after_dates_zero_and_invalid_headers_choose_safe_delays(self):
        wall_time = 1700000000
        cases = [
            (formatdate(wall_time + 12, usegmt=True), 12),
            (formatdate(wall_time - 12, usegmt=True), 0),
            ("0", 0),
            ("00010", 10),
            ("599", 599),
            (None, 3),
            ("PRIVATE_INVALID", 3),
            ("-10", 3),
            ("+10", 3),
            ("1.5", 3),
            ("\u0661\u0660", 3),
        ]
        for header, expected_delay in cases:
            clock = [0]
            attempts = []
            rejected = io.BytesIO(b"PRIVATE_BODY")
            headers = {} if header is None else {"Retry-After": header}
            error = urllib.error.HTTPError(
                HOST, 503, "PRIVATE_MESSAGE", headers, rejected
            )

            def open_request(request, timeout):
                attempts.append(clock[0])
                self.assertEqual(timeout, min(30, 600 - clock[0]))
                if len(attempts) == 1:
                    raise error
                return io.BytesIO(b"{}")

            def sleep(delay):
                self.assertTrue(rejected.closed)
                clock[0] += delay

            with self.subTest(header=header), patch.object(
                collector.time, "monotonic", side_effect=lambda: clock[0]
            ), patch.object(
                collector.time, "time", return_value=wall_time
            ), patch.object(collector.time, "sleep", side_effect=sleep):
                sonar = collector.Sonar(HOST, "secret")
                with patch.object(sonar.opener, "open", side_effect=open_request):
                    self.assertEqual(sonar.get("ce/task", id="task-1"), {})
            self.assertEqual(attempts, [0, expected_delay])
            self.assertTrue(rejected.closed)

    def test_retry_after_must_fit_strictly_inside_the_remaining_budget(self):
        wall_time = 1700000000
        cases = [
            ("601", 0),
            ("600", 0),
            ("10", 590),
            ("10", 591),
            ("0", 600),
            ("0", 601),
            (formatdate(wall_time + 600, usegmt=True), 0),
            ("9" * 5000, 0),
        ]
        for header, response_time in cases:
            clock = [0]
            rejected = io.BytesIO(b"PRIVATE_BODY")
            error = urllib.error.HTTPError(
                HOST, 429, "PRIVATE_MESSAGE", {"Retry-After": header}, rejected
            )

            def open_request(request, timeout):
                clock[0] = response_time
                raise error

            with self.subTest(
                header=header[:80], response_time=response_time
            ), patch.object(
                collector.time, "monotonic", side_effect=lambda: clock[0]
            ), patch.object(
                collector.time, "time", return_value=wall_time
            ), patch.object(collector.time, "sleep") as sleeping:
                sonar = collector.Sonar(HOST, "secret")
                with patch.object(
                    sonar.opener, "open", side_effect=open_request
                ) as opening, self.assertRaises(collector.ValidationError) as raised:
                    sonar.get("ce/task", id="task-1")
                self.assertEqual(opening.call_count, 1)
                sleeping.assert_not_called()
                self.assertTrue(rejected.closed)
                self.assertNotIn("PRIVATE", str(raised.exception))

    def test_expired_budget_does_not_start_a_request_or_sleep(self):
        with patch.object(collector.time, "monotonic", return_value=0), patch.object(
            collector.time, "sleep"
        ) as sleeping:
            sonar = collector.Sonar(HOST, "secret")
            sonar.deadline = 0
            with patch.object(sonar.opener, "open") as opening, self.assertRaises(
                collector.ValidationError
            ):
                sonar.get("ce/task", id="task-1")
            opening.assert_not_called()
            sleeping.assert_not_called()

    def test_network_read_failures_keep_the_existing_retry_limit_and_fallback(self):
        for error in (urllib.error.URLError("PRIVATE"), TimeoutError("PRIVATE")):
            with self.subTest(error=type(error).__name__), patch.object(
                collector.time, "monotonic", return_value=0
            ), patch.object(collector.time, "sleep") as sleeping:
                sonar = collector.Sonar(HOST, "secret")
                with patch.object(
                    sonar.opener, "open", side_effect=error
                ) as opening, self.assertRaises(type(error)):
                    sonar.get("ce/task", id="task-1")
                self.assertEqual(opening.call_count, 3)
                self.assertEqual(
                    [call.args for call in sleeping.call_args_list], [(3,), (3,)]
                )

    def test_disconnect_and_body_reset_recover_after_closing_the_response(self):
        for phase, error in (
            ("open", http.client.RemoteDisconnected("PRIVATE")),
            ("read", ConnectionResetError("PRIVATE")),
        ):
            clock = [0]
            attempts = []
            rejected = io.BytesIO(b"PRIVATE_BODY")
            recovered = io.BytesIO(b"{}")

            def open_request(request, timeout):
                attempts.append(clock[0])
                if len(attempts) == 1:
                    if phase == "open":
                        raise error
                    return rejected
                return recovered

            def sleep(delay):
                if phase == "read":
                    self.assertTrue(rejected.closed)
                clock[0] += delay

            with self.subTest(phase=phase), patch.object(
                collector.time, "monotonic", side_effect=lambda: clock[0]
            ), patch.object(
                collector.time, "sleep", side_effect=sleep
            ) as sleeping, patch.object(rejected, "read", side_effect=error):
                sonar = collector.Sonar(HOST, "secret")
                with patch.object(sonar.opener, "open", side_effect=open_request):
                    self.assertEqual(sonar.get("ce/task", id="task-1"), {})
                self.assertEqual(attempts, [0, 3])
                sleeping.assert_called_once_with(3)
                self.assertTrue(recovered.closed)
            rejected.close()

    def test_disconnect_and_body_reset_exhaust_after_three_attempts(self):
        for phase, error in (
            ("open", http.client.RemoteDisconnected("PRIVATE")),
            ("read", ConnectionResetError("PRIVATE")),
        ):
            responses = [io.BytesIO(b"PRIVATE_BODY") for _ in range(3)]
            attempts = []

            def open_request(request, timeout):
                response = responses[len(attempts)]
                attempts.append(response)
                if phase == "open":
                    raise error
                return response

            def sleep(delay):
                if phase == "read":
                    self.assertTrue(attempts[-1].closed)

            with self.subTest(phase=phase), contextlib.ExitStack() as stack:
                stack.enter_context(
                    patch.object(collector.time, "monotonic", return_value=0)
                )
                sleeping = stack.enter_context(
                    patch.object(collector.time, "sleep", side_effect=sleep)
                )
                for response in responses:
                    stack.enter_context(patch.object(response, "read", side_effect=error))
                sonar = collector.Sonar(HOST, "secret")
                with patch.object(
                    sonar.opener, "open", side_effect=open_request
                ) as opening, self.assertRaises(type(error)):
                    sonar.get("ce/task", id="task-1")
                self.assertEqual(opening.call_count, 3)
                self.assertEqual(
                    [call.args for call in sleeping.call_args_list], [(3,), (3,)]
                )
                if phase == "read":
                    self.assertTrue(all(response.closed for response in responses))
            for response in responses:
                response.close()

    def test_unrelated_http_protocol_errors_are_not_retried(self):
        with patch.object(collector.time, "monotonic", return_value=0), patch.object(
            collector.time, "sleep"
        ) as sleeping:
            sonar = collector.Sonar(HOST, "secret")
            with patch.object(
                sonar.opener, "open", side_effect=http.client.BadStatusLine("PRIVATE")
            ) as opening, self.assertRaises(http.client.BadStatusLine):
                sonar.get("ce/task", id="task-1")
            opening.assert_called_once()
            sleeping.assert_not_called()

    def test_truncated_chunked_http_response_recovers_or_stops_after_three_attempts(self):
        class MemorySocket:
            def makefile(self, mode):
                self.stream = io.BytesIO(
                    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nabc"
                )
                return self.stream

        for failures in (1, 3):
            clock = [0]
            attempts = []
            responses = []
            sockets = []
            for _ in range(failures):
                socket = MemorySocket()
                response = http.client.HTTPResponse(socket)
                response.begin()
                sockets.append(socket)
                responses.append(response)

            def open_request(request, timeout):
                attempts.append(clock[0])
                if len(attempts) <= failures:
                    return responses[len(attempts) - 1]
                return io.BytesIO(b"{}")

            def sleep(delay):
                self.assertTrue(responses[len(attempts) - 1].closed)
                self.assertTrue(sockets[len(attempts) - 1].stream.closed)
                clock[0] += delay

            with self.subTest(failures=failures), patch.object(
                collector.time, "monotonic", side_effect=lambda: clock[0]
            ), patch.object(collector.time, "sleep", side_effect=sleep):
                sonar = collector.Sonar(HOST, "secret")
                with patch.object(sonar.opener, "open", side_effect=open_request):
                    if failures == 1:
                        self.assertEqual(sonar.get("ce/task", id="task-1"), {})
                    else:
                        with self.assertRaises(http.client.IncompleteRead):
                            sonar.get("ce/task", id="task-1")
            self.assertEqual(attempts, [0, 3] if failures == 1 else [0, 3, 6])
            self.assertTrue(all(response.closed for response in responses))
            self.assertTrue(all(socket.stream.closed for socket in sockets))

    def test_cancellation_propagates_from_request_or_retry_wait(self):
        for phase in ("request", "wait"):
            rejected = io.BytesIO(b"PRIVATE_BODY")
            error = urllib.error.HTTPError(
                HOST, 429, "PRIVATE_MESSAGE", {"Retry-After": "10"}, rejected
            )

            def sleep(delay):
                self.assertTrue(rejected.closed)
                raise KeyboardInterrupt()

            with self.subTest(phase=phase), patch.object(
                collector.time, "monotonic", return_value=0
            ), patch.object(collector.time, "sleep", side_effect=sleep) as sleeping:
                sonar = collector.Sonar(HOST, "secret")
                with patch.object(
                    sonar.opener,
                    "open",
                    side_effect=KeyboardInterrupt() if phase == "request" else error,
                ) as opening, self.assertRaises(KeyboardInterrupt):
                    sonar.get("ce/task", id="task-1")
                self.assertEqual(opening.call_count, 1)
                self.assertEqual(sleeping.call_count, 0 if phase == "request" else 1)
            rejected.close()

    def test_late_response_is_not_accepted_after_polling_budget(self):
        sonar = collector.Sonar(HOST, "secret")
        sonar.deadline = 10
        with patch.object(
            sonar.opener, "open", return_value=io.BytesIO(b"{}")
        ) as opening, patch.object(collector.time, "monotonic", side_effect=[0, 11]):
            with self.assertRaises(collector.ValidationError):
                sonar.get("ce/task", id="task-1")
        self.assertEqual(opening.call_count, 1)


if __name__ == "__main__":
    unittest.main()
