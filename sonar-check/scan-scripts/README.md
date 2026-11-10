# Script security before Sonar

Run this action in a separate **GitHub-hosted AMD64 Linux job before the internal
Sonar job**. It reads the approved commit's files as data and scans them with our
prebuilt [Malcontent](https://github.com/chainguard-dev/malcontent) runtime. The image
contains the scanner and rules; the action does not build images, install binaries
or fetch rules at run time. It never executes source scripts, build tools or plugins.

The scanner container has no network access or credentials. Its source mount and
root filesystem are read-only, with bounded resources and temporary storage.
Only the scan's own container is cleaned up after completion or failure.

## Blocking policy

The policy fails on:

- Critical findings from the supported scanner.
- Download/dropper indicators and a literal shell pipeline in the same committed
  file. This includes `sh`/`bash` under `/bin` or `/usr/bin`, and multiline
  pipelines. Command boundaries distinguish shells from tools such as `sha224sum`.
- AWS credential-path and curl-upload indicators in the same file
  (`credential/cloud/aws` with `exfil/curl_post`). This is suspicious co-occurrence,
  not proof that the credentials flow to the upload.

Other High/Medium findings do not automatically block: benign builds can produce
those ratings. The image and policy come from the trusted workflow and common
action, with no PR-controlled suppression settings. Findings show paths and rule
IDs, never source snippets. Timeouts, tool errors, malformed reports and incomplete
scans fail.

## Inputs and use

`source-directory` defaults to `.`. `expected-sha` is the required full approved
commit SHA, which must match the checkout. Outputs `passed` and `sha` appear only
when scanning completes and the policy passes. The hosted runner needs Git,
Python 3, Docker and access to the public image registry.

`image` defaults to
`ghcr.io/nvidia/spark-rapids-common/sonar-script-scan:main`.
Consumers can omit this input; the shared action and image own scanner upgrades.
Only trusted workflows should set this input; pin the published digest when an
immutable runtime is required, retaining it with a non-`build-*` tag to protect it
from cleanup. The action checks the image's compatibility contract and engine
version metadata, then runs the pulled image by its local immutable ID. Compatible
engine upgrades keep the same contract so actions pinned to reviewed commits keep
working with `main`. A missing or incompatible image fails the scan, with no
local-build fallback.

This fragment belongs in the Sonar workflow after its existing trusted approval
job. Pin both actions to reviewed full commit SHAs.

```yaml
security:
  needs: approve
  runs-on: ubuntu-latest
  timeout-minutes: 10
  permissions:
    contents: read
  outputs:
    sha: ${{ steps.scan.outputs.sha }}
  steps:
    - uses: actions/checkout@<reviewed-checkout-commit>
      with:
        ref: ${{ needs.approve.outputs.sha }}
        persist-credentials: false
        path: source
    - uses: NVIDIA/spark-rapids-common/sonar-check/scan-scripts@<reviewed-common-commit>
      id: scan
      with:
        source-directory: source
        expected-sha: ${{ needs.approve.outputs.sha }}
```

Require `needs: [approve, security]` and
`if: ${{ needs.security.result == 'success' }}` on the internal job; check out
`${{ needs.security.outputs.sha }}` there. No consumer is enabled by this change.

## Image maintenance

The Dockerfile uses the public upstream `malcontent:latest` image. The existing
daily publisher builds `sonar-script-scan` from `.github/image-builds.json` for
AMD64, checks the binary's version against the engine version declared
in the Dockerfile label and runs real fixtures, then promotes the version tag and
stable `main` alias to the same anonymously verified image.
The same catalog includes it in existing image cleanup. The first publication
must finish before enabling consumers. An unsupported upstream version fails the
smoke checks before promotion; update the catalog version tag and Dockerfile's
engine-version label together. Keep contract `1` only while the scanner's JSON
report and rule behavior remain compatible with existing action revisions;
validate those revisions when upgrading the engine. An incompatible contract
needs a consumer migration before replacing `main`. The consumer alias stays
`main`.

CPU CI builds the proposed Dockerfile locally and tests that image before merge;
it never publishes PR images. The publisher's `smoke-test.sh` reuses those fixtures.

## Coverage

The snapshot contains every tracked regular file in the current repository,
including hidden and extensionless scripts, XML/POM and other build files.
Uncommitted edits and ignore files cannot change its contents. Empty files are
recorded separately. Symlinks and archive-expanded reports are unsupported and
fail explicitly. Submodule pointers are reported as external dependencies; their
contents, Git LFS objects and downloaded build plugins are not scanned.

This is heuristic detection. Indirect commands and generic environment-token
uploads can be missed; examples in documentation or tests can also trigger rules.
A passing result does not prove code safe to execute internally. Keep runner
admission restricted to trusted workflows and isolate untrusted build execution
from Sonar credentials and the internal network.
