# signoff-check

This composite action to check if a PR got sign-off.

## Inputs

- `owner` (required): Repo owner
- `repo` (required): Repo name
- `pull_number` (required): pull request number
- `token` (required): GitHub token that has read access to repo

## Usage

```yaml
jobs:
  signoff-check:
    # ...
    steps:
      # ...
      - name: signoff
        uses: NVIDIA/spark-rapids-common/signoff-check@main
        with:
          owner: ${{ github.repository_owner }} # could change to a specific owner
          repo: ${{ github.repository }} # could change to a specific repo name
          pull_number: ${{ github.event.number }} # could change to a specific pr number
          token: ${{ secrets.GITHUB_TOKEN }} # could change to a specific token
    # ...
```
