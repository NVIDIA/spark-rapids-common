# GHCR Cleanup

Delete build-only package versions and unreferenced untagged manifests older than
seven days, not individual tags.
Set `retention-days` to choose a different period for your repository. A version sharing
`build-*` with `main-*`, release tags or `v1` is kept. All platform and attestation
manifests referenced by retained versions or protected digests are also kept,
including dependencies of recent untagged indexes.
Detached OCI attestations or signatures with a `subject` pointing to an image
retained by tag, age, `keep-latest` or explicit digest protection are also kept.

## Usage

Use a trusted scheduled or manual workflow, not PR code. Deletion requires
`packages: write` and package admin access for the workflow repository.

```yaml
permissions:
  contents: read
  packages: write

# Share this package-wide group with every publisher, including release branches.
concurrency:
  group: build-image-maintenance
  cancel-in-progress: false
  queue: max

jobs:
  cleanup:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: NVIDIA/spark-rapids-common/ghcr-cleanup@main
        with:
          package: my-project/build-image
          retention-days: '7'
          dry-run: 'true'
```

For tagged versions, every tag must match `build-*` by default. For both tagged
and untagged versions, creation and last update must be older than the retention
period. No minimum number of builds is kept; `keep-latest` applies only to matching
tagged versions, not their untagged manifests.

Delete indexes before their children, and OCI referrers before their subjects.
A child is eligible only after all referencing manifests have been selected for
earlier deletion. At most 20 versions are deleted per package per run, counting
indexes, platforms and attestations separately. A cap leaves the remaining
dependencies intact for later runs. Set `dry-run: 'false'` to delete.

Deletion is sequential, not atomic. An expired disposable image may lose a
detached attestation before the image itself is removed if the cap or an error
ends the batch. Images retained by policy are excluded from this process.

See [action.yml](action.yml) for optional tag patterns, protected references,
deletion limits and the `candidates`/`deleted` outputs.
No checkout, Docker daemon or build metadata is required.

## Safety

- Do not overlap cleanup with publishing or tag promotion. GitHub concurrency
  only locks within one repository; coordinate external writers separately.
- Keep retention longer than running builds and digest consumers need. Protect
  longer-lived digests explicitly or give them a non-disposable tag.
- Untagged does not mean unused. External digest-only consumers cannot be discovered;
  list their digests in `protected-digests`. Cyclic manifest references are retained.
- Incomplete or changed metadata stops cleanup. Uncertain deletions are not retried.

This repository runs cleanup daily with the defaults above and deletion enabled.
The daily cadence keeps the 20-version cap ahead of routine multi-platform publication.
Higher-volume consumers should adjust their schedule or cap; retention is a minimum
age, not a promise that every expired version is removed immediately.
Manual runs default to dry-run; cleanup shares the publisher's concurrency group.

## Tests

```sh
node --test ghcr-cleanup/test/*.test.js
```

CPU CI runs these tests with mocked APIs; no images are published or deleted.
