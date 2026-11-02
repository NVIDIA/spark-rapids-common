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
      "comment": "Test all changes except documentation.",
      "exclude_paths": ["docs/", "**/*.md"],
      "jobs": ["build", "test"]
    }
  }
}
```

Omit a suite's `paths` to include **all changed files**, including hidden files.
To limit it to a subtree instead, set `"paths": ["src/"]`. Include paths and
`shared_paths` remain exact filenames or directory prefixes ending in `/`, not globs.
An empty `paths` list is invalid; use `enabled: false` to pause a suite.

Optional `exclude_paths` filters individual files for that suite:

- `docs/` excludes that directory and its contents.
- `LICENSE` excludes one exact file.
- `**/*.md` excludes Markdown files at the root and in non-hidden directories.
- `**/*.{png,jpg}` excludes those file types.

Globs use Node.js `path.matchesGlob`. Wildcards do not match hidden path segments;
use an explicit exclusion such as `.github/` or `.github/**/*.md` when needed.
Glob case sensitivity follows the coordinator OS (case-sensitive on Linux).
Patterns must be repository-relative, without `..`, backslashes or a leading `!`.
Omitting `exclude_paths` or using `[]` excludes nothing. Code plus excluded docs
still selects the suite; only changes entirely excluded from its included paths skip it.

Changed files matching `shared_paths` select every enabled suite **even if excluded**,
so list only paths that affect all workloads. `shared_paths` may be omitted or `[]`.
Renames check both old and new paths independently, so moving code into an excluded
directory still selects the suite. File deletions are matched normally.
The catalog is not implicitly shared: it triggers a suite only when covered by its
include/exclude rules or explicitly listed in `shared_paths`.

`jobs` lists existing workflow job IDs, not display names or runner types. When a
suite is selected, every listed job must succeed for the final gate to pass. This
list does not create jobs; define them in the workflow and include them in the gate's `needs`.

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
