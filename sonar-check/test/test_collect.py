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
        for status, expected in ((429, 3), (503, 3), (403, 1)):
            sonar = collector.Sonar(HOST, "secret")
            error = urllib.error.HTTPError(HOST, status, "secret", {}, None)
            with patch.object(
                sonar.opener, "open", side_effect=error
            ) as opening, patch.object(collector.time, "sleep"):
                with self.assertRaises(urllib.error.HTTPError):
                    sonar.get("ce/task", id="task-1")
            self.assertEqual(opening.call_count, expected)

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
