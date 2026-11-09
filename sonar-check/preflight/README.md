# Pre-Sonar workflow security check

Run this action in a **separate GitHub-hosted job before allocating a self-hosted
runner**. It reads workflow and local-action YAML from the expected Git commit as
data, then runs checksum-pinned zizmor 1.32.0. It never executes the checked-out
workflow, build scripts or local actions.

The check fails on medium/high findings, invalid YAML, no auditable inputs,
unexpected scanner output, incomplete reads or tool errors. It uses offline
regular mode, ignores PR-controlled scanner configuration and suppression comments,
and audits tracked inputs regardless of `.gitignore` or uncommitted edits.

Inputs are `source-directory` (default `.`) and the required full `expected-sha`.
The checkout must match that SHA. The action requires a GitHub-hosted Linux x64
runner with Git and Python 3, plus access to GitHub release downloads. It needs no
Sonar or runner-administration token. Outputs `passed` and `sha` are available
only after a successful check.

## Add it before the internal scan

This job fragment assumes an existing trusted `approve` job that authorizes the
current PR commit. Pin both actions to reviewed full commit SHAs.

```yaml
security:
  needs: approve
  runs-on: ubuntu-latest
  timeout-minutes: 10
  permissions:
    contents: read
  outputs:
    sha: ${{ steps.preflight.outputs.sha }}
  steps:
    - uses: actions/checkout@<reviewed-checkout-commit>
      with:
        ref: ${{ needs.approve.outputs.sha }}
        persist-credentials: false
        path: source
    - name: Check workflow security before internal execution
      id: preflight
      uses: NVIDIA/spark-rapids-common/sonar-check/preflight@<reviewed-common-commit>
      with:
        source-directory: source
        expected-sha: ${{ needs.approve.outputs.sha }}
```

In the existing internal Sonar job, require `needs: [approve, security]` and
`if: ${{ needs.security.result == 'success' }}`, then check out
`${{ needs.security.outputs.sha }}`. Do not use `continue-on-error` for the check.
A failed, cancelled or skipped security job must prevent internal allocation.
The Sonar result remains a separate check; this action adds no general CPU gate
policy. Its functional tests run in the existing Sonar CPU test suite.

## Security boundary

This is workflow static analysis, not a sandbox or malware detector. It does not
inspect arbitrary shell/source code, execute or attest build plugins, follow
submodules or remote action implementations, or run online advisory checks. A
clean result cannot prove that PR code is safe to execute internally.

Keep the action, workflow and approval policy outside the PR author's control.
For hostile workflow authors, enforce runner access using a restricted runner group
and a trusted reusable workflow, or a locked orchestration repository. An editable
workflow can otherwise omit this check and request the same repository runner.
The expected SHA verifies the snapshot, not the authority of its approver.

Build untrusted code without privileged credentials or broad internal access.
Use fresh trusted scan/collection and reporting environments; carrying files or
processes from an untrusted build into a later secret-bearing step breaks that
separation. See [GitHub's runner security guidance](https://docs.github.com/en/actions/reference/security/secure-use)
and [zizmor's audit coverage](https://docs.zizmor.sh/audits/).
