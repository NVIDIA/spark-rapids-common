# GHCR Cleanup

Remove old **build-only package versions**, not individual tags. A version carrying
both `build-*` and a live alias such as `main-*`, `26.12-*` or `v1` is retained.
Untagged versions are always retained. This action does not prune all registry
storage or remove the build alias from a retained version.

## Consumer Configuration

Run from a trusted scheduled or manual workflow, not PR code. Consumers own the
package, retention period and tag patterns. The action defaults to dry-run mode.

```yaml
permissions:
  contents: read
  packages: write

# ALL workflows publishing this package must use this same concurrency group.
# Use a package-wide group, not a branch-specific group.
concurrency:
  group: build-image-maintenance
  cancel-in-progress: false

jobs:
  cleanup:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: NVIDIA/spark-rapids-common/ghcr-cleanup@main
        with:
          package: my-project/build-image
          tag-patterns: '["build-*"]'
          protected-tag-patterns: '["build-pinned-*"]'
          retention-days: '30'
          keep-latest: '5'
          max-delete: '20'
          dry-run: 'true'
```

Set `dry-run: 'false'` only after reviewing the plan and coordinating publishers.
No checkout, Docker daemon or build metadata is required by the action. Pass
literal inputs or plain output references in `with`; an optional caller can put
`if` on this step. JSON validation runs inside the selected action, not inside
step `env` expressions. Missing or malformed inputs fail when cleanup is selected
rather than turning into an empty successful cleanup.

Use a read-only package token for dry runs. Deletion requires `packages: write`
and the workflow repository must have **admin access to the package**; a package
published by that repository normally has it. See [GitHub's package permission
requirements](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-in-a-github-actions-workflow).

| Input | Default | Meaning |
| --- | --- | --- |
| `package` | Required | Package name without owner, e.g. `my-project/build-image` |
| `owner` | Repository owner | Organization or user owning the package |
| `owner-type` | `organization` | `organization` or `user` |
| `tag-patterns` | `["build-*"]` | JSON array; **all** tags must match one of these patterns |
| `protected-tag-patterns` | `[]` | JSON array; any match prevents deletion |
| `protected-digests` | `[]` | JSON array of pinned `sha256:...` digests to retain |
| `retention-days` | `30` | Both creation and last update must be older than this |
| `keep-latest` | `5` | Retain this many newest otherwise matching versions |
| `max-delete` | `20` | Maximum candidate versions per invocation, oldest first |
| `dry-run` | `true` | Report only; no DELETE requests |
| `github-token` | `github.token` | GitHub/registry token with the required package access |

Patterns support literal tag characters and `*` only. Broad patterns can make
consumer tags eligible: keep the disposable namespace narrow and use protection
patterns for additional exceptions. Minimum history and protected digests are
optional consumer policies, not project-version or branch-name inference.

## Safety And Limits

- The complete active version inventory is checked before planning. Missing or
  inconsistent metadata, permissions, manifests or unsupported manifest formats
  stop cleanup; they are not treated as an empty registry.
- Every retained version is a graph root, including untagged images, recent
  builds and versions outside the deletion batch. Nested indexes, platform and
  attestation manifests referenced by retained roots are protected transitively.
  Registry content is checked against its SHA-256 digest.
- The inventory is read again before deletion and each candidate is rechecked
  immediately before its DELETE. Reads have bounded retries/timeouts; DELETE
  is single-shot, with explicit diagnostics for uncertain outcomes.
- These checks are not an atomic registry transaction. Serialize **all** writers
  with cleanup, including release publishers and external promotion tools.
  Cross-repository publishers need external coordination; GitHub concurrency
  groups only lock within one repository. Do not enable deletion otherwise.
- Keep retention longer than any in-flight build or downstream digest consumer.
  Pin longer-lived digests using `protected-digests` or a non-disposable tag.
  Cleanup cannot discover external consumers of unaliased build digests.
- A scan is bounded to 10,000 versions/manifests; exceeding the limit stops it.
  The batch limit may result in fewer deletions when references protect candidates.
  Untagged garbage collection is deliberately outside this action's scope.

The action logs candidates and confirmed deletions and writes a job summary.
Outputs `candidates` and `deleted` are counts; a failed invocation is not a
successful cleanup even when earlier deletions completed.

This repository's weekly workflow uses the image catalog, 30 days, five retained
build versions and at most 20 deletions per package. Manual runs default to a dry
run. It shares `daily-image-build` concurrency with the publisher and does not
change image builds or GPU CI.

## Validation

```sh
node --test ghcr-cleanup/test/*.test.js
```

Tests use fake package APIs and registry responses. They do not delete or publish
images and run in the existing CPU CI image-tooling suite.
