# Container Image

Build and smoke-test a resolved image configuration. Validation loads images
locally without registry credentials. Publication builds one GHCR candidate,
pulls its registry digest anonymously, runs each platform's smoke check, and
promotes the consumer tag only after all checks pass.

## Inputs

- `config`: JSON object shown below.
- `publish`: `false` by default.
- `token`: required only for publication; needs `packages: write`.

~~~json
{
  "image": "build-toolchain",
  "tag": "26.12.0-SNAPSHOT-cuda13.4.3-amd64",
  "version": "26.12.0-SNAPSHOT",
  "context": ".",
  "dockerfile": "ci/Dockerfile",
  "platforms": ["linux/amd64"],
  "build-args": {"CUDA_VERSION": "13.4.3"},
  "smoke-test": "ci/image-smoke.sh",
  "smoke-args": ["13.4.3"]
}
~~~

`version` defaults to the tag; `build-args` and `smoke-args` default empty.
A single `platform` string is accepted instead of `platforms`.
The smoke script receives the image reference, platform, then configured arguments.
Use resolved string/number/boolean build arguments, not toolchain references.

~~~yaml
- uses: NVIDIA/spark-rapids-common/container-image@main
  with:
    config: ${{ steps.image.outputs.config }}
    publish: 'false'
~~~

Check out the consumer and set up Docker Buildx first. The Linux host needs Bash,
jq and timeout. Multiple platforms require native support or caller-configured
emulation. Validation builds/loads platforms sequentially; publication builds a
multi-platform candidate once.

## Publication Boundary

Only set `publish: 'true'` in a trusted worker, passing its scoped GitHub token.
The caller owns source/branch authorization, approved PR handling, runner choice,
queue fallback, concurrency and job timeouts. Do not expose publishing credentials
to PR-controlled scripts. This action does not decide whether a source is trusted.

Publication uses temporary Docker credentials without logging in or out of the
caller's GHCR account. Existing Buildx, Docker context and other registry settings
are retained; temporary credentials are removed on exit.

Images publish under `ghcr.io/<owner>/<repository>/<image>`.
The package must permit public anonymous pulls. A new package may require a
one-time visibility change before promotion succeeds. Never mirror private
contents merely because the destination is public.

Read retries are bounded to three 300-second attempts per platform with
15-second waits. Build, push and smoke failures are not retried. Reserve enough
time in the caller's worker for publication and verification. Publisher-local
anonymous pulls do not replace a clean-consumer download/performance check.

## Tests

Run `node --test container-image/test/*.test.js` with Node.js 24, Bash 4+
and jq. The tests execute the shell entry point with fake Docker/clock commands;
they need no Docker daemon, registry credentials or network access.
