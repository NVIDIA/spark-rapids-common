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

## Optional Build Cache

`cache-from` and `cache-to` are optional arrays of Buildx cache specifications.
Omitting them preserves the existing behavior without external cache configuration.
For example:

~~~json
{
  "cache-from": ["type=gha,version=2,scope=toolchain-cuda12-amd64,timeout=2m"],
  "cache-to": ["type=gha,version=2,scope=toolchain-cuda12-amd64,mode=max,timeout=2m,ignore-error=true"]
}
~~~

Add these fields to the image config above. Give independent image variants
separate scopes to avoid overwriting each other's cache. Validation builds can
reuse cached layers; publishing still uses `--pull --no-cache` and can export a
fresh baseline for subsequent PR builds. Multiple validation platforms build
sequentially; use separate per-platform calls/scopes when exporting their caches.

Use bounded timeouts and `ignore-error=true` for optional cache exports. The action
does not retry builds or publications after cache or workload failures. GitHub's
branch-scoped cache access rules apply; PR caches must not be used as trusted
publication inputs. No additional registry credentials are needed for `type=gha`.
The Node.js 24 entry point passes GitHub's cache runtime credentials directly to
the existing shell builder, without writing them to job-wide environment files.
Calling `image.sh` directly still works; standalone callers using GHA caches must
supply the cache runtime environment themselves. See the
[Docker GHA cache requirements](https://docs.docker.com/build/cache/backends/gha/),
including driver compatibility and runtime authentication.

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
and jq. The tests execute both action and shell entry points with fake Docker/clock commands;
they need no Docker daemon, registry credentials or network access.
