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
Bot-created `pull-request/<number>` branches publish an amd64/arm64 preview as
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

Both call the PR's local `signoff-check` action against the actual pull request,
using the already-published preview pinned by digest. The action pulls the image
anonymously and executes the signoff script from the mirrored checkout. These
checks do not rebuild the runtime or substitute a local build if the pull fails.
Only read access to repository contents and pull requests is needed. After both
pass, a separate CPU job publishes the PR preview using only the built-in
`GITHUB_TOKEN` with `packages: write`; no PAT or additional secret is required.

The workflow runs on `pull-request/<number>` branches in the NVIDIA repository,
using the exact PR-head commit. GitHub attaches the resulting CPU and
GPU checks to that PR, so validation does not require merging the PR or the
workflow into `main`.

Before validating the approval flow, ensure `copy-pr-bot` is installed for this
repository and `.github/copy-pr-bot.yaml` is present on `main`. A configuration
file on a PR does not activate the bot. The configuration-only setup can be
merged separately while the workflow change stays unmerged.

Trusted ready-for-review PRs sync automatically; draft auto-sync is disabled.
The bot's default trust and vetter rules apply: an organization member can
manually approve trusted PRs with `/ok to test`; untrusted changes always require
a vetter's approval with the full latest head SHA, including on ready PRs.
Trust depends on the PR author, committers, and verified commit signatures;
a DCO signoff alone does not make a commit trusted.

For manual approval, review the latest changes, then post this comment on the
PR, replacing the placeholder with its full 40-character head SHA:

```text
/ok to test <full 40-character head SHA>
```

The bot acknowledges a successful command with a thumbs-up reaction and mirrors
the latest PR head. Read `nv-cpu-general` and `nv-gpu-general` in the PR's Checks
tab. For untrusted changes, bare commands, abbreviated SHAs, and stale SHAs are
rejected; trusted PRs do not enforce SHA matching. New heads on draft PRs or PRs
with untrusted changes need another approval comment; trusted ready PRs sync
automatically. Manual branch pushes do not start the managed tests or PR
publication: both workflows require the push actor to be `copy-pr-bot[bot]`.

Existing GitHub-hosted lint and PR-metadata checks remain automatic. Managed
runners reject `pull_request` and `pull_request_target` events; the bot's
mirrored-head push is the supported trigger for these CPU/GPU checks.

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
