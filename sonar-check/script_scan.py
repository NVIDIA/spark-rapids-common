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

"""Inspect an approved source snapshot without executing its build or scripts."""

from functools import partial
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import resource
import shutil
import signal
import subprocess
import tempfile
import time
import uuid

IMAGE = (
    "cgr.dev/chainguard/malcontent@sha256:"
    "98734fbb8de4510ac4f5b6e820b74e38d5bd528884e579a2c44afa57aeba0fcf"
)
SCANNER_VERSION = "1.28.1"
DOCKER_HOST = "unix:///var/run/docker.sock"
OWNER_LABEL = "com.nvidia.script-scan.owner"
TOOL_PATH = "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
MAX_FILES = 20000
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024
MAX_REPORT_BYTES = 32 * 1024 * 1024
RISK_LEVELS = {0: "NONE", 1: "LOW", 2: "MEDIUM", 3: "HIGH", 4: "CRITICAL"}

# The pinned rules also match prefixes such as "| sha224sum". Confirm a complete
# literal shell command in the immutable blob before blocking these indicators.
DOWNLOAD_PIPE = {"exec/shell/pipe_sh", "c2/tool_transfer/shell"}
SHELL_PIPE = re.compile(
    rb"(?<!\|)\|[ \t]*(?:/bin/)?(?:bash|sh)(?=$|[ \t\r\n;|&<>()\"'])"
)
CREDENTIAL_UPLOAD = {"credential/cloud/aws", "exfil/curl_post"}


class ScanError(RuntimeError):
    """A diagnostic that contains no scanned source or raw tool output."""


def require(condition, message):
    if not condition:
        raise ScanError(message)


def has_shell_pipe(data):
    """Confirm supported literal shell tokens; this is not a shell interpreter."""
    return SHELL_PIPE.search(data) is not None


def tool_environment():
    return {
        "PATH": TOOL_PATH,
        "LANG": "C.UTF-8",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_NO_REPLACE_OBJECTS": "1",
    }


def command_output(
    command,
    *,
    cwd=None,
    env=None,
    limit=MAX_REPORT_BYTES,
    timeout=30,
    phase="Source scan",
):
    # The CLI is single-threaded. Bound child file writes as well as parser reads.
    file_limit = partial(
        resource.setrlimit, resource.RLIMIT_FSIZE, (limit + 1, limit + 1)
    )
    with tempfile.TemporaryFile() as output:
        try:
            result = subprocess.run(
                command,
                cwd=cwd,
                env=tool_environment() if env is None else env,
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.DEVNULL,
                preexec_fn=file_limit,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise ScanError(f"{phase} timed out") from error
        except OSError as error:
            raise ScanError(f"Could not start {phase.lower()}") from error
        require(result.returncode == 0, f"{phase} failed (exit {result.returncode})")
        output.seek(0)
        data = output.read(limit + 1)
    require(len(data) <= limit, f"{phase} output exceeds its size limit")
    return data


def git_output(source, arguments, limit=MAX_REPORT_BYTES):
    return command_output(
        [
            "/usr/bin/git",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            *arguments,
        ],
        cwd=source,
        limit=limit,
        phase="Git snapshot read",
    )


def checkout_sha(source, expected):
    require(
        isinstance(expected, str) and re.fullmatch(r"[a-fA-F0-9]{40}", expected),
        "Expected SHA must be a full commit SHA",
    )
    require(source.is_dir(), "Source directory is unavailable")
    top = git_output(source, ["rev-parse", "--show-toplevel"], 4096).decode().strip()
    require(
        Path(top).resolve() == source.resolve(), "Source must be a Git worktree root"
    )
    actual = git_output(source, ["rev-parse", "--verify", "HEAD^{commit}"], 128)
    require(
        actual.decode().strip().lower() == expected.lower(),
        "Checkout differs from the approved commit",
    )
    return expected.lower()


def snapshot_inputs(source, sha, destination):
    """Copy committed regular blobs, without checkout filters or ignore settings."""
    entries = git_output(source, ["ls-tree", "-rlz", "--full-tree", sha])
    manifest = {}
    total = 0
    deadline = time.monotonic() + 120
    destination.mkdir(exist_ok=True)
    destination.chmod(0o755)
    for entry in entries.split(b"\0"):
        if not entry:
            continue
        require(time.monotonic() < deadline, "Source snapshot exceeded its time limit")
        metadata, raw_path = entry.split(b"\t", 1)
        mode, kind, object_id, size = metadata.split()
        path = raw_path.decode("utf-8")
        parts = PurePosixPath(path).parts
        require(
            parts
            and "/".join(parts) == path
            and all(part not in (".", "..", ".git") for part in parts)
            and not path.startswith("/")
            and "\\" not in path
            and re.search(r"[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]", path) is None,
            "Unsupported source path",
        )
        require(len(manifest) < MAX_FILES, "Source snapshot contains too many files")
        if kind == b"commit" and mode == b"160000":
            manifest[path] = {"gitlink": object_id.decode()}
            continue
        require(
            kind == b"blob" and mode in (b"100644", b"100755"),
            "Source scan does not support symlinks",
        )
        size = int(size)
        require(0 <= size <= MAX_FILE_BYTES, "A source file exceeds the size limit")
        total += size
        require(
            total <= MAX_TOTAL_BYTES, "Source snapshot exceeds the total size limit"
        )
        data = git_output(
            source, ["cat-file", "blob", object_id.decode()], MAX_FILE_BYTES
        )
        require(
            len(data) == size, "Source blob size changed while preparing the snapshot"
        )
        manifest[path] = {
            "sha256": hashlib.sha256(data).hexdigest(),
            "size": size,
            "shell_pipe": has_shell_pipe(data),
        }
        # Empty files contain no commands. The scanner otherwise calls them skipped.
        if size == 0:
            continue
        target = destination.joinpath(*parts)
        require(not target.exists(), "Source paths collide on this filesystem")
        target.parent.mkdir(parents=True, exist_ok=True)
        parent = target.parent
        while parent != destination:
            parent.chmod(0o755)
            parent = parent.parent
        target.write_bytes(data)
        target.chmod(0o444)
    require(
        any(entry.get("size", 0) > 0 for entry in manifest.values()),
        "No nonempty committed source files were found",
    )
    return manifest


def docker_command(workdir):
    binary = shutil.which("docker", path=TOOL_PATH)
    require(binary, "Docker is required on the hosted scan runner")
    config = workdir / "docker-config"
    config.mkdir(mode=0o700, exist_ok=True)
    return [binary, "--config", str(config), "--host", DOCKER_HOST]


def cleanup_container(prefix, name):
    """Remove only containers carrying this invocation's random ownership label."""
    listing = (
        command_output(
            [
                *prefix,
                "container",
                "ls",
                "--all",
                "--no-trunc",
                "--filter",
                f"label={OWNER_LABEL}={name}",
                "--format",
                "{{.ID}}",
            ],
            limit=4096,
            timeout=15,
            phase="Scan container inventory",
        )
        .decode()
        .splitlines()
    )
    require(len(listing) <= 1, "Could not establish unique scan-container ownership")
    for container_id in listing:
        require(
            re.fullmatch(r"[a-f0-9]{64}", container_id),
            "Invalid scan-container identity",
        )
        command_output(
            [*prefix, "container", "rm", "--force", container_id],
            limit=4096,
            timeout=15,
            phase="Scan container cleanup",
        )


def scan(snapshot, workdir):
    prefix = docker_command(workdir)
    command_output(
        [*prefix, "pull", "--quiet", IMAGE],
        limit=1024 * 1024,
        timeout=180,
        phase="Scanner image pull",
    )
    name = "script-scan-" + uuid.uuid4().hex
    source = str(snapshot.resolve())
    require(
        "," not in source and "\n" not in source,
        "Unsupported temporary directory for the scanner mount",
    )
    command = [
        *prefix,
        "run",
        "--rm",
        "--name",
        name,
        "--label",
        f"{OWNER_LABEL}={name}",
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
        "--cpus",
        "2",
        "--memory",
        "2g",
        "--memory-swap",
        "2g",
        "--pids-limit",
        "128",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=256m",
        "--mount",
        f"type=bind,source={source},target=/source,readonly",
        IMAGE,
        "--include-data-files",
        "--format",
        "json",
        "--stats",
        "--min-risk",
        "any",
        "--min-file-risk",
        "any",
        "--exit-extraction",
        "--exit-on-extractor-panic",
        "--max-depth",
        "4",
        "--max-files",
        str(MAX_FILES),
        "--max-archive-bytes",
        str(MAX_TOTAL_BYTES),
        "--max-archive-ratio",
        "64",
        "--jobs",
        "2",
        "analyze",
        "/source",
    ]
    try:
        data = command_output(command, timeout=180, phase="Scanner analysis")
    finally:
        cleanup_container(prefix, name)
    try:
        return json.loads(data)
    except (ValueError, UnicodeError) as error:
        raise ScanError("Scanner returned invalid JSON") from error


def evaluate(report, manifest):
    """Validate complete source evidence before applying the trusted rule policy."""
    require(
        isinstance(report, dict) and set(report) == {"Files", "Stats"},
        "Scanner returned an invalid analysis report",
    )
    files = report.get("Files")
    require(isinstance(files, dict), "Scanner report does not contain a file inventory")
    require(
        all(
            "gitlink" in entry or type(entry.get("shell_pipe")) is bool
            for entry in manifest.values()
        ),
        "Source manifest does not contain verified shell-token evidence",
    )
    expected = {
        "/source/" + path: entry
        for path, entry in manifest.items()
        if entry.get("size", 0) > 0
    }
    require(
        set(files) == set(expected), "Scanner did not report every approved source file"
    )
    stats = report.get("Stats")
    require(
        isinstance(stats, dict)
        and type(stats.get("ProcessedFiles")) is int
        and stats["ProcessedFiles"] == len(expected)
        and type(stats.get("SkippedFiles", 0)) is int
        and stats.get("SkippedFiles", 0) == 0,
        "Scanner skipped files or did not complete the approved source inventory",
    )
    findings = []
    for name, record in files.items():
        entry = expected[name]
        require(isinstance(record, dict), "Scanner returned invalid file evidence")
        no_findings = (
            record == {"Path": name, "SHA256": "", "Size": 0, "RiskScore": 0}
            and type(record.get("Size")) is int
            and type(record.get("RiskScore")) is int
        )
        require(
            record.get("Path") == name
            and (
                no_findings
                or (
                    record.get("SHA256") == entry["sha256"]
                    and type(record.get("Size")) is int
                    and record["Size"] == entry["size"]
                )
            )
            and not record.get("Skipped")
            and not record.get("Error"),
            "Scanner file evidence differs from the approved source",
        )
        behaviors = record.get("Behaviors", [])
        require(
            isinstance(behaviors, list), "Scanner returned invalid behavior evidence"
        )
        file_score = record.get("RiskScore")
        require(
            no_findings
            or (
                type(file_score) is int
                and file_score in RISK_LEVELS
                and record.get("RiskLevel") == RISK_LEVELS[file_score]
                and behaviors
            ),
            "Scanner returned invalid file risk evidence",
        )
        categories = set()
        blocking = []
        for behavior in behaviors:
            require(isinstance(behavior, dict), "Scanner returned an invalid behavior")
            category, rule = behavior.get("ID"), behavior.get("RuleName")
            score = behavior.get("RiskScore")
            severity = behavior.get("RiskLevel")
            require(
                isinstance(category, str)
                and re.fullmatch(r"[a-zA-Z0-9_./-]{1,200}", category)
                and isinstance(rule, str)
                and re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]{0,127}", rule)
                and type(score) is int
                and score in RISK_LEVELS
                and severity == RISK_LEVELS[score],
                "Scanner returned invalid rule or severity evidence",
            )
            categories.add(category)
            if score == 4:
                blocking.append((category + "/" + rule, severity))
        if DOWNLOAD_PIPE <= categories and entry["shell_pipe"]:
            blocking.append(("download-with-direct-shell-pipe", "MEDIUM"))
        if CREDENTIAL_UPLOAD <= categories:
            blocking.append(("credential-access-with-upload", "MEDIUM"))
        if file_score == 4 and not any(
            severity == "CRITICAL" for _, severity in blocking
        ):
            blocking.append(("critical-file-risk", "CRITICAL"))
        for rule, severity in blocking:
            findings.append(
                {"path": name[len("/source/") :], "rule": rule, "severity": severity}
            )
    return findings


def summary(result):
    findings = result["findings"]
    report = f"Script security: {'FAIL' if findings else 'PASS'}. Blocking findings: {len(findings)}."
    rows = [
        report,
        f"Scanner: Malcontent {SCANNER_VERSION}. Policy: Critical, download/direct-shell pipes, AWS credential access with upload.",
        f"Root-repository files: {result['file_count']}; verified empty files: {result['empty_files']}.",
    ]
    if findings:
        rows.extend(["", "| File | Rule | Severity |", "| --- | --- | --- |"])
    for finding in findings[:20]:
        path = "".join(
            (
                character
                if character.isalnum() or character in ".-/: "
                else f"&#{ord(character)};"
            )
            for character in finding["path"][:256]
        )
        rows.append(
            f"| <code>{path}</code> | {finding['rule']} | {finding['severity']} |"
        )
    if len(findings) > 20:
        rows.append(f"\nShowing the first 20 of {len(findings)} findings.")
    dependencies = result["submodules"]
    if dependencies:
        rows.extend(["", "External submodule contents were not scanned:"])
        for dependency in dependencies[:20]:
            path = "".join(
                (
                    character
                    if character.isalnum() or character in ".-/: "
                    else f"&#{ord(character)};"
                )
                for character in dependency["path"][:256]
            )
            rows.append(f"- <code>{path}</code> at {dependency['sha']}")
        if len(dependencies) > 20:
            rows.append(f"Showing the first 20 of {len(dependencies)} submodules.")
    return "\n".join(rows)


def run(source, expected, workdir):
    sha = checkout_sha(source, expected)
    snapshot = workdir / "source"
    manifest = snapshot_inputs(source, sha, snapshot)
    findings = evaluate(scan(snapshot, workdir), manifest)
    checkout_sha(source, sha)
    return {
        "sha": sha,
        "findings": findings,
        "file_count": sum("gitlink" not in entry for entry in manifest.values()),
        "empty_files": sum(entry.get("size") == 0 for entry in manifest.values()),
        "submodules": [
            {"path": path, "sha": entry["gitlink"]}
            for path, entry in manifest.items()
            if "gitlink" in entry
        ],
    }


def cancelled(_signal, _frame):
    raise KeyboardInterrupt


def main():
    previous_handler = signal.signal(signal.SIGTERM, cancelled)
    try:
        require(
            os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
            and platform.system() == "Linux",
            "Run script scanning in a separate GitHub-hosted Linux job",
        )
        workspace = Path(os.environ["GITHUB_WORKSPACE"]).resolve()
        source = (workspace / os.environ.get("INPUT_SOURCE_DIRECTORY", ".")).resolve()
        require(
            source.is_relative_to(workspace),
            "Source must be inside the checkout workspace",
        )
        expected = os.environ.get("INPUT_EXPECTED_SHA", "")
        with tempfile.TemporaryDirectory(
            prefix="script-scan-", dir=os.environ["RUNNER_TEMP"]
        ) as directory:
            result = run(source, expected, Path(directory))
        report = summary(result)
        print(report)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
                output.write(report + "\n")
        if result["findings"]:
            return 1
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"passed=true\nsha={expected.lower()}\n")
        return 0
    except KeyboardInterrupt:
        print("::error::Script security scan was cancelled")
        return 130
    except Exception as error:
        message = (
            str(error)
            if isinstance(error, ScanError)
            else "Script security verification could not complete"
        )
        print("::error::" + message)
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous_handler)


if __name__ == "__main__":
    raise SystemExit(main())
