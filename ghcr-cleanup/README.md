# GHCR Cleanup

Delete build-only package versions older than seven days, not individual tags.
Set `retention-days` to choose a different period for your repository. A version sharing
`build-*` with `main-*`, release tags or `v1` is kept. Untagged versions and
platform/attestation manifests referenced by retained images are also kept.

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

By default, every tag must match `build-*`, and both creation and last update must
be older than the retention period. No minimum number of builds is kept.
At most 20 versions are deleted per package per run. Set `dry-run: 'false'` to delete.

See [action.yml](action.yml) for optional tag patterns, protected references,
deletion limits and the `candidates`/`deleted` outputs.
No checkout, Docker daemon or build metadata is required.

## Safety

- Do not overlap cleanup with publishing or tag promotion. GitHub concurrency
  only locks within one repository; coordinate external writers separately.
- Keep retention longer than running builds and digest consumers need. Protect
  longer-lived digests explicitly or give them a non-disposable tag.
- Incomplete or changed metadata stops cleanup. Uncertain deletions are not retried.

This repository runs cleanup weekly with the defaults above and deletion enabled.
Manual runs default to dry-run; cleanup shares the publisher's concurrency group.

## Tests

```sh
node --test ghcr-cleanup/test/*.test.js
```

CPU CI runs these tests with mocked APIs; no images are published or deleted.
