# Workflow result gate

Aggregate conditional jobs into one stable required check, without API polling,
status-write permissions, a checkout, or a separate privileged workflow. The
caller owns path selection, workloads, and runner choices.

## Usage

```yaml
jobs:
  # select emits required-jobs=["select"] for an unaffected change, or
  # ["select","build","test"] when the suite needs to run.
  # Define the select, build, and test jobs above this gate.
  gate:
    name: CI gate
    if: always()
    needs: [select, build, test]
    runs-on: ubuntu-slim
    timeout-minutes: 5
    permissions: {}
    steps:
      - uses: NVIDIA/spark-rapids-common/workflow-result-gate@main
        with:
          needs: ${{ toJSON(needs) }}
          required-jobs: ${{ needs.select.outputs.required-jobs }}
```

- `needs` must be a nonempty JSON object from the calling job's `needs` context.
- `required-jobs` is an explicit JSON array of workflow **job IDs**, not display
  names. Missing, skipped, failed, or cancelled required jobs fail the gate.
- All other dependencies must succeed or skip. A failure or cancellation still
  fails the gate, even when that job was not selected.
- Invalid or missing inputs fail the gate. An explicit `[]` allows dependencies
  to skip; a missing selector output is not treated as `[]`.

Always require the selector itself. Include every build/test job directly in
the gate's `needs`: GitHub does not include transitive dependencies in that
context. When adding a suite, update the caller's selection and dependency list;
no changes to this action are needed. A CPU-only workflow can use the same gate
with, for example, `needs: [lint, package]` and `required-jobs: '["lint","package"]'`.

## Required-check setup

Keep the gate unconditional with `if: always()`, and apply path conditions to
individual workloads rather than filtering out the whole workflow. Configure the
gate's unique display name as the required GitHub Actions check after verifying
it on the intended branch. Use an eligible event such as `pull_request`, `push`,
or `merge_group`; dispatched worker jobs alone do not satisfy a required check.

This action trusts GitHub's job results. It cannot recover failures hidden by
`continue-on-error` or scripts that exit successfully after failed tests. Do not
mask failures in jobs required by the gate. It does not approve PR code, enforce
branch protection, or validate independent workflow runs; those remain caller
responsibilities.
