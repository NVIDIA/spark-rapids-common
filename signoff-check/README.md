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

The `Publish signoff image` workflow builds on `linux-amd64-cpu16` using only the
repository's built-in `GITHUB_TOKEN` with `packages: write`. It accepts manual
dispatches from `main`; nightly publishing at 02:17 UTC is enabled by setting
the repository variable `SIGNOFF_IMAGE_PUBLISH_ENABLED=true` after runner access
is granted. Production `v1` publication is restricted to `main` and requires
anonymous pulls to succeed. Fork workflows cannot publish.

The PR workflow also calls this publisher after both runner smoke jobs pass.
Reviewed `pull-request/<number>` branches publish an amd64/arm64 preview as
`ghcr.io/nvidia/spark-rapids-common/signoff-check:pr-<number>`, without changing
`v1`. Both platforms pass CLI smoke checks before the preview tag is updated.
If the new package is still private, the preview uses authenticated pulls for
validation and reports a warning; consumers still need the package made Public.

For initial setup (skip package creation if a PR preview already created it):

1. Merge the workflow and confirm CPU runner access for this repository.
2. Dispatch `Publish signoff image` on `main` to create the GHCR package.
3. Set the package's visibility to **Public** in its GitHub package settings.
   GHCR packages start private even when the source repository is public.
4. Rerun the workflow. It verifies anonymous pulls and the CLI on both platforms
   before promoting the candidate digest to `v1`.
5. Enable the nightly publishing variable.

A failed build, anonymous pull, or smoke check leaves the previous `v1` tag
untouched. The workflow summary records the published digest. Existing signoff
workflows retain their current runner selection; moving PR jobs to the managed
CPU pool is separate from building their reusable runtime image.

## Validate runner access on a pull request

The `Runner pool smoke test` workflow runs two independent jobs:

- `nv-cpu-general`: `linux-amd64-cpu16`.
- `nv-gpu-general`: `linux-amd64-gpu-l4-latest-1`, including host and Docker GPU access.

Both build the signoff runtime locally and check its CLI and stdin-based script
execution, with read-only repository permissions. After both pass, a separate
CPU job publishes the PR preview using only the built-in `GITHUB_TOKEN` with
`packages: write`; no PAT or additional secret is required.

The workflow runs on `pull-request/<number>` branches in the NVIDIA repository,
using the exact reviewed PR-head commit. GitHub attaches the resulting CPU and
GPU checks to that PR, so validation does not require merging the PR or the
workflow into `main`.

Normally, the platform's `copy-pr-bot` creates and updates these branches. Until
that app is enabled for this repository, a maintainer can use the documented
manual equivalent. For PR #65, from its reviewed checkout:

```sh
git push https://github.com/NVIDIA/spark-rapids-common.git HEAD:refs/heads/pull-request/65
```

Read `nv-cpu-general` and `nv-gpu-general` in the PR's Checks tab. Each new PR-head
commit needs to be reviewed and mirrored again until the bot is enabled.
Managed runners reject `pull_request` and `pull_request_target` events; this
trusted-commit process is the platform's supported PR-testing mechanism.

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
