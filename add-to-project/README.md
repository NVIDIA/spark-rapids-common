# add-to-project

This composite action to add new issue and pull request to the project.

## Inputs

- `token` (required): GitHub token that has write access to the project

## Usage

```yaml
jobs:
  Add-to-project:
    # ...
    if: github.repository_owner == 'NVIDIA' # (optional)
    steps:
    # ...
      - name: add-to-project
        uses: NVIDIA/spark-rapids-common/add-to-project@main
        with:
          token: ${{ secrets.PROJECT_TOKEN }}
    # ...
```
