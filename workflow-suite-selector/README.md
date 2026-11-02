# Workflow suite selector

Select test suites from the full PR diff and output the jobs that must pass.
Use this in a workflow triggered by an approved `push` to `pull-request/<number>`.
The caller owns approval; this action verifies the open PR's current head and target.

## Usage

Keep the path catalog in the consumer repository, for example `.github/ci-suites.json`:

```json
{
  "shared_paths": [".github/ci-suites.json", ".github/workflows/ci.yml"],
  "suites": {
    "unit": {"paths": ["src/"], "jobs": ["build", "test"]}
  }
}
```

Paths are exact filenames or directory prefixes ending in `/`, not globs.
Changes to `shared_paths` select every suite. Renames check both old and new paths.

Add this job to the approved-push workflow:

```yaml
permissions:
  contents: read
  pull-requests: read

jobs:
  select:
    runs-on: ubuntu-slim
    timeout-minutes: 5
    outputs:
      suites: ${{ steps.select.outputs.suites }}
      required-jobs: ${{ steps.select.outputs.required-jobs }}
    steps:
      - uses: NVIDIA/spark-rapids-common/checkout@main
        with:
          ref: ${{ github.sha }}
          persist-credentials: false
      - uses: NVIDIA/spark-rapids-common/workflow-suite-selector@main
        id: select
        with:
          catalog-path: .github/ci-suites.json
          base-branch: main
          selector-job: select
```

The three shown inputs are required. `selector-job` is the caller's job ID, not its
display name. Optional `github-token` defaults to `github.token` and needs PR read access.

Outputs are JSON arrays: `suites` contains selected names; `required-jobs` contains
the selector and the selected suites' job IDs. No matching path produces `[]` and
`["select"]` for this example. API errors, incomplete file lists, or changed PR identity
fail selection rather than skipping tests.

Use `suites` to conditionally run the consumer's build/test jobs, then pass
`required-jobs` to the [workflow result gate](../workflow-result-gate/README.md).
The shared actions must be available at the chosen ref before running the consumer.
