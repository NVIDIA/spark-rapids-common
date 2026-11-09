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
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import resource
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "sonar_preflight", Path(__file__).resolve().parents[1] / "preflight.py"
)
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)

CLEAN_WORKFLOW = """name: Check
on: pull_request
permissions:
  contents: read
jobs:
  inspect:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo checked
"""

LOCAL_ACTION = """name: Local check
description: Fixture action
runs:
  using: composite
  steps:
    - shell: bash
      run: echo checked
"""


def finding(severity="High", **overrides):
    return {
        "ident": "template-injection",
        "determinations": {
            "severity": severity,
            "confidence": "High",
            "persona": "Regular",
        },
        "locations": [],
        **overrides,
    }


def location(path, row=7):
    return {
        "symbolic": {"key": {"Local": {"verbatim_path": str(path)}}},
        "concrete": {"location": {"start_point": {"row": row}}},
        "annotation": "PRIVATE_ANNOTATION\n::warning::injected",
    }


class GitFixture(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.git_environment = {
            "PATH": os.defpath,
            "HOME": str(self.root),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_DEFAULT_HASH": "sha1",
            "LC_ALL": "C",
        }
        self.git("init", "--quiet")
        self.write(".github/workflows/check.yml", CLEAN_WORKFLOW)
        self.sha = self.commit()

    def git(self, *arguments):
        return subprocess.check_output(
            ["git", "-C", str(self.source), *arguments],
            env=self.git_environment,
            stderr=subprocess.PIPE,
            text=True,
        ).strip()

    def write(self, name, text):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def commit(self):
        self.git("add", "--all", "--force")
        self.git(
            "-c",
            "user.name=Test Author",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "Fixture snapshot",
        )
        return self.git("rev-parse", "HEAD")

    def snapshot(self):
        destination = Path(tempfile.mkdtemp(dir=self.root))
        return destination, preflight.snapshot_inputs(
            self.source, self.sha, destination
        )


class GitCheckoutTests(GitFixture):

    def test_checkout_requires_the_approved_commit_and_repository_root(self):
        self.assertEqual(preflight.checkout_sha(self.source, self.sha), self.sha)
        for expected in ("a" * 40, "HEAD", self.sha[:12], "-" + self.sha[1:]):
            with self.subTest(expected=expected):
                with self.assertRaises(preflight.PreflightError):
                    preflight.checkout_sha(self.source, expected)
        with self.assertRaises(preflight.PreflightError):
            preflight.checkout_sha(self.source / ".github", self.sha)

    def test_snapshot_reads_committed_workflows_and_actions_despite_ignore_files(self):
        self.write(".github/workflows/other.yaml", CLEAN_WORKFLOW)
        self.write("tools/check/action.yml", LOCAL_ACTION)
        self.write("action.yaml", LOCAL_ACTION)
        self.write(".gitignore", "*\n")
        self.write(".ignore", ".github\ntools\n")
        self.write("zizmor.yml", "rules:\n  template-injection:\n    disable: true\n")
        self.write("build.sh", "touch NEVER_EXECUTE_THIS_FILE\n")
        self.sha = self.commit()

        self.write(".github/workflows/check.yml", "not the committed workflow")
        self.write("untracked/action.yml", LOCAL_ACTION)
        destination, inputs = self.snapshot()

        self.assertEqual(
            {path.relative_to(destination).as_posix() for path in inputs},
            {
                ".github/workflows/check.yml",
                ".github/workflows/other.yaml",
                "tools/check/action.yml",
                "action.yaml",
            },
        )
        self.assertEqual(
            (destination / ".github/workflows/check.yml").read_text(), CLEAN_WORKFLOW
        )
        self.assertFalse((destination / "zizmor.yml").exists())
        self.assertFalse((self.source / "NEVER_EXECUTE_THIS_FILE").exists())

    def test_snapshot_rejects_symlink_action_instead_of_reading_its_target(self):
        outside = self.root / "outside.yml"
        outside.write_text(LOCAL_ACTION)
        link = self.source / "action.yml"
        link.symlink_to(outside)
        self.sha = self.commit()

        with self.assertRaises(preflight.PreflightError):
            self.snapshot()

    def test_snapshot_rejects_symlink_workflow_directory(self):
        (self.source / ".github/workflows/check.yml").unlink()
        (self.source / ".github/workflows").rmdir()
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "check.yml").write_text(CLEAN_WORKFLOW)
        (self.source / ".github/workflows").symlink_to(outside)
        self.sha = self.commit()

        with self.assertRaises(preflight.PreflightError):
            self.snapshot()

    def test_snapshot_rejects_empty_audit_and_input_size_limits(self):
        for limit in ("MAX_INPUTS", "MAX_FILE_BYTES", "MAX_TOTAL_BYTES"):
            with self.subTest(limit=limit), patch.object(preflight, limit, 0):
                with self.assertRaises(preflight.PreflightError):
                    self.snapshot()
        (self.source / ".github/workflows/check.yml").unlink()
        self.write("README.md", "No auditable files\n")
        self.sha = self.commit()
        with self.assertRaises(preflight.PreflightError):
            self.snapshot()

    def test_changed_head_during_scan_cannot_produce_a_success(self):
        def change_head(*_arguments):
            self.write("README.md", "New commit during preflight\n")
            self.commit()
            return []

        workdir = self.root / "work"
        workdir.mkdir()
        with patch.object(
            preflight, "install_scanner", return_value=self.root / "zizmor"
        ), patch.object(preflight, "scan", side_effect=change_head):
            with self.assertRaises(preflight.PreflightError):
                preflight.run(self.source, self.sha, workdir)

    def test_snapshot_rejects_paths_that_escape_or_inject_diagnostics(self):
        for name in ("../action.yml", "/action.yml", "bad\naction/action.yml"):
            record = f"100644 blob {'a' * 40}\t{name}\0".encode()
            with self.subTest(name=name):
                with patch.object(preflight, "git_output", return_value=record):
                    with self.assertRaises(preflight.PreflightError):
                        self.snapshot()

    def test_git_and_scanner_output_are_bounded_before_writing_to_disk(self):
        temporary_file = tempfile.TemporaryFile
        sizes = []

        @contextlib.contextmanager
        def measured_output():
            with temporary_file() as output:
                try:
                    yield output
                finally:
                    sizes.append(os.fstat(output.fileno()).st_size)

        binary = self.root / "oversized-scanner"
        binary.write_text("#!/bin/sh\nprintf '%4096s' x\n")
        binary.chmod(0o700)
        parent_limit = resource.getrlimit(resource.RLIMIT_FSIZE)
        limit = 32
        for tool in ("git", "scanner"):
            with self.subTest(tool=tool):
                sizes.clear()
                with patch.object(preflight.tempfile, "TemporaryFile", measured_output):
                    with self.assertRaises(preflight.PreflightError):
                        if tool == "git":
                            preflight.git_output(
                                self.source,
                                ["show", f"{self.sha}:.github/workflows/check.yml"],
                                limit=limit,
                            )
                        else:
                            with patch.object(preflight, "MAX_REPORT_BYTES", limit):
                                preflight.scan(binary, [], self.root)
                self.assertEqual(len(sizes), 1)
                self.assertGreater(sizes[0], 0)
                self.assertLessEqual(sizes[0], limit + 1)
                self.assertEqual(
                    resource.getrlimit(resource.RLIMIT_FSIZE), parent_limit
                )


class ScannerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.input = self.root / "workflow.yml"
        self.input.write_text(CLEAN_WORKFLOW)
        self.binary = self.root / "zizmor"

    def scan(self, payload, code=0):
        def complete(command, **options):
            options["stdout"].write(payload)
            return subprocess.CompletedProcess(command, code)

        with patch.object(preflight.subprocess, "run", side_effect=complete) as run:
            result = preflight.scan(self.binary, [self.input], self.root)
        return result, run.call_args

    def test_scanner_uses_fixed_offline_policy_and_no_credentials(self):
        environment = {
            "GH_TOKEN": "PRIVATE_TOKEN",
            "GITHUB_TOKEN": "PRIVATE_TOKEN",
            "ZIZMOR_CONFIG": "/untrusted/policy.yml",
            "ZIZMOR_OFFLINE": "false",
            "ZIZMOR_GITHUB_TOKEN": "PRIVATE_TOKEN",
            "PYTHONPATH": "/untrusted/imports",
        }
        with patch.dict(os.environ, environment):
            findings, invocation = self.scan(b"[]")

        self.assertEqual(findings, [])
        command = invocation.args[0]
        for flag in (
            "--offline",
            "--no-config",
            "--no-ignores",
            "--strict-collection",
        ):
            self.assertIn(flag, command)
        self.assertIn("--", command)
        for flag, value in (
            ("--collect", "all"),
            ("--persona", "regular"),
            ("--min-severity", "medium"),
            ("--format", "json-v1"),
        ):
            self.assertEqual(command[command.index(flag) + 1], value)
        self.assertNotIn("--no-exit-codes", command)
        self.assertNotIn("--fix", command)
        self.assertNotIn("sarif", command)
        self.assertFalse(invocation.kwargs.get("shell", False))
        self.assertGreater(invocation.kwargs["timeout"], 0)
        for key in environment:
            self.assertNotIn(key, invocation.kwargs["env"])

    def test_inline_ignored_findings_are_still_returned_for_blocking(self):
        expected = [finding(ignored=True)]
        findings, _ = self.scan(json.dumps(expected).encode(), code=14)
        self.assertEqual(findings, expected)

    def test_scanner_rejects_errors_and_inconsistent_success(self):
        cases = (
            (b"[]", 1),
            (b"[]", 2),
            (b"[]", 3),
            (b"[]", 14),
            (b"not-json", 0),
            (b"{}", 0),
            (b"[null]", 0),
            (b"[{}]", 14),
            (json.dumps([finding(severity="unexpected")]).encode(), 14),
            (json.dumps([finding(ident="bad\n::warning::injected")]).encode(), 14),
        )
        for payload, code in cases:
            with self.subTest(payload=payload, code=code):
                with self.assertRaises(
                    (preflight.PreflightError, json.JSONDecodeError)
                ):
                    self.scan(payload, code=code)

    def test_report_size_is_bounded(self):
        with patch.object(preflight, "MAX_REPORT_BYTES", 1):
            with self.assertRaises(preflight.PreflightError):
                self.scan(b"[]")

    def test_summary_shows_bounded_locations_without_echoing_source_content(self):
        findings = [
            finding(locations=[location(self.input)], feature="PRIVATE_SOURCE")
            for _ in range(25)
        ]
        preflight.add_locations(findings, [self.input], self.root)
        summary = preflight.summary(findings)
        self.assertEqual(summary.count("workflow.yml:8"), 20)
        self.assertNotIn("PRIVATE", summary)
        self.assertNotIn("::warning::", summary)

        marked_path = self.root / "check[link]<tag>.yml"
        marked_path.write_text(CLEAN_WORKFLOW)
        findings = [finding(locations=[location(marked_path)])]
        preflight.add_locations(findings, [marked_path], self.root)
        summary = preflight.summary(findings)
        self.assertIn(":8", summary)
        self.assertNotIn("[link]", summary)
        self.assertNotIn("<tag>", summary)

    def test_summary_does_not_trust_unknown_paths_or_invalid_line_numbers(self):
        for unsafe in (
            location(self.root / "PRIVATE_OUTSIDE.yml"),
            location(self.input, row="7\n::warning::injected"),
            location(self.input, row=-1),
            location(self.input, row=999),
            location(self.input, row=True),
        ):
            with self.subTest(location=unsafe):
                findings = [
                    finding(
                        locations=[unsafe], _audited_location=("PRIVATE_LOCATION", 1)
                    )
                ]
                preflight.add_locations(findings, [self.input], self.root)
                summary = preflight.summary(findings)
                self.assertIn("Location unavailable", summary)
                self.assertNotIn("PRIVATE", summary)
                self.assertNotIn("::warning::", summary)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def archive(self, name="zizmor", kind=tarfile.REGTYPE, contents=b"scanner"):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:gz") as archive:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.size = len(contents) if kind == tarfile.REGTYPE else 0
            member.linkname = "../outside"
            archive.addfile(member, io.BytesIO(contents))
        return data.getvalue()

    def install(self, data, code=0, checksum=None):
        def download(command, **_options):
            target = Path(command[command.index("--output") + 1])
            target.write_bytes(data)
            return subprocess.CompletedProcess(command, code)

        digest = checksum or hashlib.sha256(data).hexdigest()
        with patch.object(preflight, "ARCHIVE_SHA256", digest):
            with patch.object(preflight.subprocess, "run", side_effect=download) as run:
                binary = preflight.install_scanner(self.root)
        return binary, run.call_args

    def test_verified_regular_binary_is_installed_without_archive_permissions(self):
        binary, invocation = self.install(self.archive())
        self.assertEqual(binary.read_bytes(), b"scanner")
        self.assertEqual(binary.stat().st_mode & 0o777, 0o700)
        command = invocation.args[0]
        self.assertEqual(command[-1], preflight.ARCHIVE_URL)
        self.assertIn("--max-filesize", command)
        self.assertEqual(command[command.index("--proto") + 1], "=https")
        self.assertGreater(invocation.kwargs["timeout"], 0)

    def test_download_failure_checksum_and_archive_size_fail_closed(self):
        archive = self.archive()
        for options in ({"code": 22}, {"checksum": "0" * 64}):
            with self.subTest(options=options):
                with self.assertRaises(preflight.PreflightError):
                    self.install(archive, **options)
        with patch.object(preflight, "MAX_ARCHIVE_BYTES", len(archive) - 1):
            with self.assertRaises(preflight.PreflightError):
                self.install(archive)
        self.assertFalse((self.root / "zizmor").exists())

    def test_archive_paths_links_and_empty_binaries_are_rejected(self):
        cases = (
            {"name": "../outside"},
            {"name": "/tmp/zizmor"},
            {"kind": tarfile.SYMTYPE},
            {"kind": tarfile.LNKTYPE},
            {"kind": tarfile.DIRTYPE},
            {"contents": b""},
        )
        for options in cases:
            with self.subTest(options=options):
                with self.assertRaises(preflight.PreflightError):
                    self.install(self.archive(**options))
        self.assertFalse((self.root / "zizmor").exists())
        with patch.object(preflight, "MAX_BINARY_BYTES", 1):
            with self.assertRaises(preflight.PreflightError):
                self.install(self.archive())


class EntrypointTests(GitFixture):
    def setUp(self):
        super().setUp()
        self.output = self.root / "output"
        self.summary = self.root / "summary"
        self.environment = {
            "GITHUB_WORKSPACE": str(self.source),
            "RUNNER_TEMP": str(self.root),
            "RUNNER_ENVIRONMENT": "github-hosted",
            "INPUT_SOURCE_DIRECTORY": ".",
            "INPUT_EXPECTED_SHA": self.sha,
            "GITHUB_OUTPUT": str(self.output),
            "GITHUB_STEP_SUMMARY": str(self.summary),
        }

    def main(self, **environment):
        stdout = io.StringIO()
        with patch.dict(os.environ, {**self.environment, **environment}, clear=True):
            with patch.object(preflight.platform, "system", return_value="Linux"):
                with patch.object(preflight.platform, "machine", return_value="x86_64"):
                    with contextlib.redirect_stdout(stdout):
                        result = preflight.main()
        return result, stdout.getvalue()

    def test_success_outputs_bind_to_the_verified_commit(self):
        with patch.object(
            preflight, "install_scanner", return_value=self.root / "zizmor"
        ):
            with patch.object(preflight, "scan", return_value=[]):
                code, _ = self.main(INPUT_EXPECTED_SHA=self.sha.upper())
        self.assertEqual(code, 0)
        self.assertEqual(self.output.read_text(), f"passed=true\nsha={self.sha}\n")
        self.assertIn("PASS", self.summary.read_text())

    def test_findings_have_safe_summary_and_never_create_success_outputs(self):
        issue = finding(ignored=True, message="PRIVATE\n::warning::injected")
        with patch.object(
            preflight, "install_scanner", return_value=self.root / "zizmor"
        ):
            with patch.object(preflight, "scan", return_value=[issue]):
                code, stdout = self.main()
        self.assertEqual(code, 1)
        self.assertFalse(self.output.exists())
        self.assertIn("template-injection", stdout)
        self.assertNotIn("PRIVATE", stdout + self.summary.read_text())
        self.assertNotIn("::warning::", stdout + self.summary.read_text())

    def test_runtime_errors_fail_without_echoing_diagnostics_or_success_outputs(self):
        failures = (
            json.JSONDecodeError("PRIVATE_JSON", "", 0),
            subprocess.TimeoutExpired("PRIVATE_COMMAND", 1),
            OSError("PRIVATE_PATH"),
            tarfile.ReadError("PRIVATE_ARCHIVE"),
        )
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                with patch.object(preflight, "run", side_effect=failure):
                    code, stdout = self.main()
                self.assertEqual(code, 1)
                self.assertFalse(self.output.exists())
                self.assertNotIn("PRIVATE", stdout)

    def test_wrong_runner_or_source_fails_before_scanner_installation(self):
        cases = (
            {"RUNNER_ENVIRONMENT": "self-hosted"},
            {"INPUT_SOURCE_DIRECTORY": ".."},
            {"INPUT_EXPECTED_SHA": "a" * 40},
        )
        for environment in cases:
            with self.subTest(environment=environment):
                with patch.object(preflight, "install_scanner") as install:
                    code, _ = self.main(**environment)
                self.assertEqual(code, 1)
                install.assert_not_called()
                self.assertFalse(self.output.exists())


@unittest.skipUnless(
    os.environ.get("SONAR_PREFLIGHT_REAL_SCANNER") == "1",
    "Enable the pinned scanner smoke test explicitly",
)
class RealScannerTests(GitFixture):
    @classmethod
    def setUpClass(cls):
        cls.scanner_directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.scanner_directory.cleanup)
        binary = os.environ.get("SONAR_PREFLIGHT_TEST_BINARY")
        cls.binary = (
            Path(binary).resolve()
            if binary
            else preflight.install_scanner(Path(cls.scanner_directory.name))
        )

    def audit(self):
        destination, inputs = self.snapshot()
        return preflight.scan(self.binary, inputs, destination)

    def test_clean_workflow_has_no_findings(self):
        self.assertEqual(self.audit(), [])

    def test_config_inline_suppression_and_ignore_files_cannot_hide_injection(self):
        self.write(
            ".github/workflows/check.yml",
            CLEAN_WORKFLOW.replace(
                "run: echo checked",
                "run: echo '${{ github.event.pull_request.title }}' "
                "# zizmor: ignore[template-injection]",
            ),
        )
        self.write(".gitignore", "*\n")
        self.write(
            ".github/zizmor.yml", "rules:\n  template-injection:\n    disable: true\n"
        )
        self.sha = self.commit()
        findings = self.audit()
        self.assertIn("template-injection", {item["ident"] for item in findings})

    def test_malformed_yaml_is_an_error_instead_of_an_empty_report(self):
        self.write(".github/workflows/check.yml", "jobs: [unterminated\n")
        self.sha = self.commit()
        with self.assertRaises(preflight.PreflightError):
            self.audit()


if __name__ == "__main__":
    unittest.main()
