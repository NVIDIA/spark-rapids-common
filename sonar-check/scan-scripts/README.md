# Script security before Sonar

Run this action in a separate **GitHub-hosted Linux job before the internal Sonar
job**. It reads the approved commit's files as data and scans them with a pinned
[Malcontent image](https://github.com/chainguard-dev/malcontent). The image contains
the scanner and rules; the action does not install binaries or fetch rules at run
time. It never executes source scripts, build tools or plugins.

The scanner container has no network access or credentials. Its source mount and
root filesystem are read-only, with bounded resources and temporary storage.
Only the scan's own container is cleaned up after completion or failure.

## Blocking policy

The policy fails on:

- Critical findings from the pinned scanner.
- Command text piped into a shell (`exec/shell/pipe_sh`).
- AWS credential-path and curl-upload indicators in the same file
  (`credential/cloud/aws` with `exfil/curl_post`). This is suspicious co-occurrence,
  not proof that the credentials flow to the upload.

Other High/Medium findings do not automatically block: benign builds can produce
those ratings. The image and policy come from the reviewed common action, with no
PR-controlled suppression settings. Findings show paths and rule IDs, never source
snippets. Timeouts, tool errors, malformed reports and incomplete scans fail.

## Inputs and use

`source-directory` defaults to `.`. `expected-sha` is the required full approved
commit SHA, which must match the checkout. Outputs `passed` and `sha` appear only
when scanning completes and the policy passes. The hosted runner needs Git,
Python 3, Docker and access to the public image registry.

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
