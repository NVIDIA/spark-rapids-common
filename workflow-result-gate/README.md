# Workflow result gate

Provide one final check for a workflow with conditional jobs. Required jobs must
succeed; other jobs may succeed or skip. Failures, cancellations, invalid inputs,
and missing or skipped required jobs fail the gate.

The gate is independent of runner type and does not require runner fallback or
the suite selector. It can combine ordinary GitHub-hosted CPU jobs, self-hosted
jobs, and reusable-workflow caller jobs in the same workflow. Independently
triggered workflows are not visible through `needs`; give separate CPU/GPU
workflows distinct gates when they have different approval or trigger policies.

## Usage

After the [suite selector](../workflow-suite-selector/README.md) and the consumer's
`build` and `test` jobs, add:

```yaml
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

Both inputs are required. `needs` is the JSON dependency-result object;
`required-jobs` is a JSON array of job IDs, which may also be supplied directly.
List every checked job directly in the gate's `needs`, including the selector.
`always()` ensures the gate runs when prerequisites fail or skip.

An unaffected PR passes after successful selection even when build/test jobs skip.
An affected PR requires every selected job to succeed. No checkout or token permissions
are needed; the action reports pass/fail through its exit status, with no outputs.
After rollout validation, make this stable gate check required in repository rules,
not the conditional workload checks.

For example, this repository's [CPU CI](../.github/workflows/cpu-ci.yml) runs the
existing runner-fallback, Shimpler, and Spark-home suites as parallel conditional
jobs and reports `CPU CI gate`. It checks out the PR merge commit and calls
`./workflow-result-gate` to validate the PR implementation before merge. Unlike
the published action example above, that local invocation needs checkout and
`contents: read`. It allocates no GPUs and does not publish images.
