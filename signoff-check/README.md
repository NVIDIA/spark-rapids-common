# signoff-check

This composite action to check if a PR got sign-off.

## Inputs

- `owner` (required): Repo owner
- `repo` (required): Repo name
- `pull_number` (required): pull request number
- `token` (required): GitHub token that has read access to repo
- `image` (optional): Public runtime image. Defaults to
  `ghcr.io/nvidia/spark-rapids-common/signoff-check:v1`; a digest can be supplied
  for a fixed runtime version.

## Runtime image

The action pulls the runtime anonymously from GHCR and runs the signoff script
from the selected action revision. It does not check out or overwrite the caller's
workspace. Existing inputs, signoff rules, and failure exit codes are unchanged.

Consumers do not need a registry login, PAT, extra secret, or `packages: read`.
The existing `token` input is used only to read the pull request through the
GitHub API. The image supports Linux amd64 and arm64 with Docker available.

If the default image is not yet public or cannot be pulled, the action warns and
builds its runtime locally, preserving the existing path during initial rollout
or registry outages. Explicit image overrides fail if unavailable rather than
silently using a different runtime. Once the public image is available, ordinary
checks pull it without rebuilding.

## Publishing

The repository's `Daily image build` workflow (`.github/workflows/image-build.yml`)
runs daily at 02:17 UTC and can also be dispatched manually on `main`. It
currently contains one job, `Signoff check image`; other images can be added as
separate jobs. No enablement variable is required.

The signoff job builds Linux amd64 and arm64 images on `linux-amd64-cpu16`, using
only the repository's built-in `GITHUB_TOKEN` with `packages: write`. It pushes a
uniquely tagged candidate, verifies anonymous pulls and CLI execution on both
architectures, then promotes the verified digest to
`ghcr.io/nvidia/spark-rapids-common/signoff-check:v1`. Publishing is restricted to
`main` in the NVIDIA repository; PR branches and forks cannot publish.

For initial setup:

1. Merge the workflow and confirm CPU runner access for this repository.
2. Dispatch `Daily image build` on `main`, or wait for the daily schedule.
3. If anonymous validation fails because a newly created package is private,
   set its visibility to **Public** in GitHub package settings and rerun.
   GHCR packages start private even when the source repository is public.

A failed build, anonymous pull, or smoke check leaves the previous `v1` tag
untouched. The workflow summary records the published digest. Consumers use
`v1`, not a PR preview tag; the local-build fallback keeps existing checks working
until the first successful publication or during a registry outage. Existing
signoff workflows retain their current runner selection.

## Usage

```yaml
jobs:
  signoff-check:
    # ...
    steps:
      # ...
      - name: signoff
        uses: NVIDIA/spark-rapids-common/signoff-check@main
        with: # The following can all be modified to the necessary values.
          owner: ${{ github.repository_owner }}
          repo: # repo name
          pull_number: ${{ github.event.number }}
          token: ${{ secrets.GITHUB_TOKEN }}
    # ...
```
