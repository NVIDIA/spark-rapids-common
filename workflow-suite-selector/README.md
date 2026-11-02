# Workflow suite selector

Select test suites from the full PR diff and output the jobs that must pass.

**Supported workflow:** a `push` event on `pull-request/<number>` in the PR's base
repository. The pushed commit must equal that open PR's current head, and the PR
must target the supplied `base-branch`. Other events, including `pull_request`,
`pull_request_target`, `workflow_dispatch`, and `merge_group`, are not supported.

This action does not check PR review approvals, `/ok to test` comments, or who
pushed the branch. The caller must enforce CI execution authorization beforehand;
for example, copy-pr-bot can push the PR head after a maintainer approves
`/ok to test <full-head-SHA>`. That is permission to run CI, not review approval.

## Usage

Keep the path catalog in the consumer repository, for example `.github/ci-suites.json`:

```json
{
  "shared_paths": [".github/workflows/ci.yml"],
  "suites": {
    "unit": {
      "enabled": true,
      "comment": "Unit tests for source changes.",
      "paths": ["src/"],
      "jobs": ["build", "test"]
    }
  }
}
```

Paths are exact filenames or directory prefixes ending in `/`, not globs.
Changed files matching `shared_paths` select every enabled suite, so list paths that affect all workloads.
The catalog itself is not automatically a trigger. Renames check both old and new paths.

To temporarily pause a suite, set its `enabled` to `false` and replace `comment`
with the reason (for example, a tracking issue and the condition for re-enabling).
Disabled suites are excluded even when a shared path changes, and their reasons
are printed in the selection log. The selector and final gate still run; jobs used
by another selected suite remain required. Restore `enabled: true` to resume.
Omitting `enabled` defaults to `true` for existing catalogs. Non-boolean values or
a disabled suite without a nonempty `comment` fail selection.

Configure the supported trigger and selector job:

```yaml
on:
  push:
    branches:
      - 'pull-request/[0-9]+'

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
