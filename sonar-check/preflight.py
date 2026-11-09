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

"""Audit committed workflow definitions before allocating an internal runner."""

from functools import partial
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import resource
import subprocess
import tarfile
import tempfile

VERSION = "1.32.0"
ARCHIVE_URL = (
    "https://github.com/zizmorcore/zizmor/releases/download/v1.32.0/"
    "zizmor-x86_64-unknown-linux-gnu.tar.gz"
)
# Official immutable v1.32.0 release asset digest, verified against the download.
ARCHIVE_SHA256 = "bb110cc765eca9cd7efb2e284a956be5974c60027b0970f16397d86208a9957b"
MAX_INPUTS = 1000
MAX_FILE_BYTES = 1024 * 1024
MAX_TOTAL_BYTES = 16 * 1024 * 1024
MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
MAX_BINARY_BYTES = 64 * 1024 * 1024
MAX_REPORT_BYTES = 16 * 1024 * 1024


class PreflightError(RuntimeError):
    """A safe diagnostic that does not contain target source or tool output."""


def require(condition, message):
    if not condition:
        raise PreflightError(message)


def tool_environment():
    # Target configuration, tokens and Python imports must not reach the tools.
    return {
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_NO_REPLACE_OBJECTS": "1",
    }


def bounded_output(limit):
    # This single-threaded CLI caps child file writes before exec, including stdout.
    # Retain one extra byte so a complete over-limit response is rejected on read.
    return partial(resource.setrlimit, resource.RLIMIT_FSIZE, (limit + 1, limit + 1))


def git_output(source, args, limit=MAX_TOTAL_BYTES):
    with tempfile.TemporaryFile() as output:
        result = subprocess.run(
            [
                "/usr/bin/git",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.hooksPath=/dev/null",
                *args,
            ],
            cwd=source,
            env=tool_environment(),
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.DEVNULL,
            preexec_fn=bounded_output(limit),
            timeout=30,
            check=False,
        )
        require(result.returncode == 0, "Could not read the approved Git snapshot")
        output.seek(0)
        data = output.read(limit + 1)
    require(len(data) <= limit, "Git snapshot exceeds the preflight size limit")
    return data


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
        "Checkout does not match the approved commit",
    )
    return expected.lower()


def snapshot_inputs(source, sha, destination):
    """Read immutable blobs, without checkout filters, hooks or ignore rules."""
    entries = git_output(source, ["ls-tree", "-rz", "--full-tree", sha])
    inputs = []
    total = 0
    for entry in entries.split(b"\0"):
        if not entry:
            continue
        metadata, raw_path = entry.split(b"\t", 1)
        mode, kind, object_id = metadata.split()
        if raw_path in (b".github", b".github/workflows"):
            require(mode != b"120000", "Workflow directories must not be symlinks")
        is_workflow = (
            raw_path.startswith(b".github/workflows/")
            and raw_path.count(b"/") == 2
            and raw_path.endswith((b".yml", b".yaml"))
        )
        is_action = raw_path.rsplit(b"/", 1)[-1] in (b"action.yml", b"action.yaml")
        if not (is_workflow or is_action):
            continue
        require(
            kind == b"blob" and mode in (b"100644", b"100755"),
            "Audited definitions must be regular committed files",
        )
        path = raw_path.decode("utf-8")
        parts = PurePosixPath(path).parts
        require(
            parts
            and "/".join(parts) == path
            and all(part not in (".", "..", ".git") for part in parts)
            and not path.startswith("/")
            and "\\" not in path
            and re.search(r"[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]", path) is None,
            "Unsupported definition path",
        )
        require(len(inputs) < MAX_INPUTS, "Too many workflow or action definitions")
        data = git_output(
            source, ["cat-file", "blob", object_id.decode()], MAX_FILE_BYTES
        )
        total += len(data)
        require(total <= MAX_TOTAL_BYTES, "Definitions exceed the total size limit")
        target = destination.joinpath(*parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        inputs.append(target)
    require(inputs, "No committed workflows or action definitions were found")
    return inputs


def install_scanner(directory):
    archive = directory / "zizmor.tar.gz"
    result = subprocess.run(
        [
            "/usr/bin/curl",
            "-q",
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--proto",
            "=https",
            "--max-time",
            "60",
            "--max-filesize",
            str(MAX_ARCHIVE_BYTES),
            "--output",
            str(archive),
            ARCHIVE_URL,
        ],
        env=tool_environment(),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=70,
        check=False,
    )
    require(result.returncode == 0, "Could not download the pinned security scanner")
    require(archive.stat().st_size <= MAX_ARCHIVE_BYTES, "Scanner archive is too large")
    require(
        hashlib.sha256(archive.read_bytes()).hexdigest() == ARCHIVE_SHA256,
        "Security scanner checksum does not match the pinned release",
    )
    binary = directory / "zizmor"
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        require(
            len(members) == 1
            and members[0].name == "zizmor"
            and members[0].isfile()
            and 0 < members[0].size <= MAX_BINARY_BYTES,
            "Unexpected security scanner archive contents",
        )
        with bundle.extractfile(members[0]) as source:
            binary.write_bytes(source.read(MAX_BINARY_BYTES + 1))
    binary.chmod(0o700)
    return binary


def scan(binary, inputs, cwd):
    command = [
        str(binary),
        "--offline",
        "--no-config",
        "--no-ignores",
        "--strict-collection",
        "--collect",
        "all",
        "--persona",
        "regular",
        "--min-severity",
        "medium",
        "--format",
        "json-v1",
        "--no-progress",
        "--color",
        "never",
        "--cache-dir",
        str(cwd / "cache"),
        "--",
        *(str(path) for path in inputs),
    ]
    with tempfile.TemporaryFile() as output:
        result = subprocess.run(
            command,
            cwd=cwd,
            env=tool_environment(),
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.DEVNULL,
            preexec_fn=bounded_output(MAX_REPORT_BYTES),
            timeout=120,
            check=False,
        )
        require(
            result.returncode in (0, 11, 12, 13, 14),
            "Security scanner failed to audit every selected definition",
        )
        output.seek(0)
        data = output.read(MAX_REPORT_BYTES + 1)
    require(len(data) <= MAX_REPORT_BYTES, "Security scanner report is too large")
    findings = json.loads(data)
    require(isinstance(findings, list), "Security scanner returned an invalid report")
    for finding in findings:
        require(
            isinstance(finding, dict)
            and isinstance(finding.get("ident"), str)
            and re.fullmatch(r"[a-z][a-z0-9-]{0,79}", finding["ident"])
            and isinstance(finding.get("determinations"), dict)
            and finding["determinations"].get("severity") in ("Medium", "High"),
            "Security scanner returned an invalid finding",
        )
    require(
        result.returncode == 0 or findings,
        "Security scanner failed without a usable finding",
    )
    # --no-ignores can retain ignored=true in JSON. Never filter those findings.
    return findings


def add_locations(findings, inputs, snapshot):
    """Keep only locations that refer to the exact immutable input files."""
    known = {
        str(path): (
            path.relative_to(snapshot).as_posix(),
            len(path.read_bytes().splitlines()),
        )
        for path in inputs
    }
    for finding in findings:
        finding["_audited_location"] = None
        locations = finding.get("locations", [])
        if not isinstance(locations, list):
            continue
        for location in locations:
            try:
                raw_path = location["symbolic"]["key"]["Local"]["verbatim_path"]
                row = location["concrete"]["location"]["start_point"]["row"]
                path, line_count = known[raw_path]
            except (KeyError, TypeError):
                continue
            if type(row) is int and 0 <= row < line_count:
                finding["_audited_location"] = (path, row + 1)
                break


def summary(findings):
    report = (
        f"Pre-Sonar workflow security: {'FAIL' if findings else 'PASS'}. "
        f"Medium/High findings: {len(findings)}. Scanner: zizmor {VERSION}."
    )
    if not findings:
        return report
    rows = [report, "", "| Rule | Severity | Definition |", "| --- | --- | --- |"]
    for finding in findings[:20]:
        location = finding.get("_audited_location")
        definition = "Location unavailable"
        if location:
            path, line = location
            # Encode Markdown/HTML punctuation and controls; never render source text.
            display = f"{path[:256]}:{line}"
            escaped = "".join(
                (
                    character
                    if character.isalnum() or character in ".-/: "
                    else f"&#{ord(character)};"
                )
                for character in display
            )
            definition = f"<code>{escaped}</code>"
        severity = finding["determinations"]["severity"]
        rows.append(f"| {finding['ident']} | {severity} | {definition} |")
    if len(findings) > 20:
        rows.append(f"\nShowing the first 20 of {len(findings)} findings.")
    return "\n".join(rows)


def run(source, expected, workdir):
    sha = checkout_sha(source, expected)
    snapshot = workdir / "source"
    snapshot.mkdir()
    inputs = snapshot_inputs(source, sha, snapshot)
    binary = install_scanner(workdir)
    findings = scan(binary, inputs, workdir)
    add_locations(findings, inputs, snapshot)
    checkout_sha(source, sha)
    return findings


def main():
    try:
        require(
            os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
            and platform.system() == "Linux"
            and platform.machine() == "x86_64",
            "Run preflight in a separate GitHub-hosted Linux x64 job",
        )
        workspace = Path(os.environ["GITHUB_WORKSPACE"]).resolve()
        source = (workspace / os.environ.get("INPUT_SOURCE_DIRECTORY", ".")).resolve()
        require(
            source.is_relative_to(workspace),
            "Source must be within the checkout workspace",
        )
        expected = os.environ.get("INPUT_EXPECTED_SHA", "")
        with tempfile.TemporaryDirectory(
            prefix="sonar-preflight-", dir=os.environ["RUNNER_TEMP"]
        ) as directory:
            findings = run(source, expected, Path(directory))
        report = summary(findings)
        print(report)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
                output.write(report + "\n")
        if findings:
            return 1
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"passed=true\nsha={expected.lower()}\n")
        return 0
    except Exception as error:
        message = (
            str(error)
            if isinstance(error, PreflightError)
            else "Pre-Sonar security verification could not complete"
        )
        print("::error::" + message)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
