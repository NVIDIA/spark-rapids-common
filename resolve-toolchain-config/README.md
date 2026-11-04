# Resolve Toolchain Config

Select one project's requirements from a shared JSON file and return the selected
configuration as JSON, without installing tools or running builds. An exact version
entry always wins. Missing versions may use `default` only when the caller
explicitly allows it; malformed explicit entries never fall back.

~~~json
{
  "default": {"cuda12": "12.9.1", "cuda13": "13.4.3"},
  "26.10": {"cuda12": "12.9.1", "cuda13": "13.3.0"}
}
~~~

Inputs: `config` (JSON file), `version-key` (e.g. `26.12`),
`allow-default` (default `false`).
Outputs: `toolchains` (JSON map), `selected-key`.
No token or network access is required; check out the consumer configuration first.

~~~yaml
- uses: NVIDIA/spark-rapids-common/resolve-toolchain-config@main
  id: toolchains
  with:
    config: ci/toolchains.json
    version-key: ${{ steps.version.outputs.release-line }}
    allow-default: ${{ github.ref == 'refs/heads/main' }}
~~~

For copied PR branches, derive the target branch from validated PR metadata,
not from the copied branch name. Allow the default only for main-target PRs.
Release publication should require explicit requirements. Version-key extraction,
branch policy, approval and build commands belong to the caller.

## Tests

Run `node --test resolve-toolchain-config/test/*.test.js` with Node.js 24.
Tests cover selection, invalid input, CLI outputs and escaped error annotations.
