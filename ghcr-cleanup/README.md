# GHCR Cleanup

Delete old build-only package versions, not individual tags. A version sharing
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

jobs:
  cleanup:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: NVIDIA/spark-rapids-common/ghcr-cleanup@main
        with:
          package: my-project/build-image
          tag-patterns: '["build-*"]'
          retention-days: '30'
          keep-latest: '5'
          max-delete: '20'
          dry-run: 'true'
```

The example shows the defaults: keep five newest matching versions and delete
at most 20 eligible versions per package per run, only when both creation and
last update are older than 30 days. Set `dry-run: 'false'` to enable deletion.

Every tag on a version must match `tag-patterns` (`*` wildcard only). Keep patterns
narrow; optional `protected-tag-patterns` and `protected-digests` add exceptions.
See [action.yml](action.yml) for all inputs and the `candidates`/`deleted` outputs.
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
