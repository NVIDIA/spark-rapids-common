# add-to-project

This composite action adds new issues and pull requests to the project. For
merged pull requests in cudf-spark and cudf-spark-jni, it also sets an empty
Roadmap field from the target branch root `pom.xml`.

## Inputs

- `token` (required): GitHub token with project write and repository read access

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
