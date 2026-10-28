# Runner queue fallback

Use a preferred CPU or GPU pool, then try the next compatible pool **only when a runner
has not been acquired within the queue deadline**. Each repository keeps its own
workload commands; this action owns dispatch, queue monitoring, cancellation and results.
No Spark, JNI, cuML or NVFlare build logic is embedded here.

## Consumer setup

Add two small workflows in the consuming repository:

1. A trusted CPU coordinator calls `NVIDIA/spark-rapids-common/runner-queue-fallback`.
2. A dedicated `workflow_dispatch` child contains exactly one job named `worker`.
   It accepts the seven inputs below and uses the shared guard before workload code.

No copied polling scripts, GitHub App or PAT are needed. The coordinator uses its
repository's `GITHUB_TOKEN` with `actions: write`; test children use only read access.
Runner access belongs to the **consuming repository**, not to common. All selected
groups must already be granted to that repository. Having access to a general pool
does not grant access to the memory-optimized CPU or GPU-specific groups.

The examples below are a manually triggered, one-worker CPU sanity pilot. They do not
enable automatic PR runs. Install both workflow files on the default branch before
dispatching. Pin both common actions to the same reviewed commit in production;
`@main` is shown for readability. Use only trusted workflow definitions, never
dispatch the child definition from an untrusted PR branch.

### Coordinator: `.github/workflows/runner-check.yml`

```yaml
name: Runner check
on:
  workflow_dispatch:
    inputs:
      source-ref:
        description: Full approved source ref, such as refs/pull/123/merge
        required: true
        type: string
      source-sha:
        description: Full approved SHA matching source-ref
        required: true
        type: string
permissions:
  contents: read
concurrency:
  group: runner-pilot
  cancel-in-progress: false
jobs:
  runner-check:
    runs-on: ubuntu-latest
    timeout-minutes: 65
    permissions:
      contents: read
      actions: write
    steps:
      - uses: NVIDIA/spark-rapids-common/runner-queue-fallback@main
        with:
          workflow: runner-worker.yml
          workflow-ref: main
          source-ref: ${{ inputs.source-ref }}
          source-sha: ${{ inputs.source-sha }}
          queue-timeout-minutes: '10'
          execution-timeout-minutes: '15'
          runners: >-
            [
              {"group":"nv-cpu-general","labels":"linux-amd64-cpu16"},
              {"group":"nv-cpu-general","labels":"linux-amd64-cpu32"}
            ]
```

The CPU coordinator does not check out or execute workload code and does not hold
a managed CPU-pool runner. Keep this stable parent check as the required check:
the dispatched child's check belongs to the trusted workflow ref, not the tested
source SHA. When adding PR integration, retain the existing full-SHA approval gate
and attach the parent result to the intended source revision. This action does not
implement approval or post commit statuses. A read-only fork PR token cannot dispatch.

### Child: `.github/workflows/runner-worker.yml`

```yaml
name: Runner worker
run-name: ${{ inputs.request-id }}
on:
  workflow_dispatch:
    inputs:
      request-id:
        required: true
        type: string
      parent-run-id:
        required: true
        type: string
      parent-run-attempt:
        required: true
        type: string
      source-ref:
        required: true
        type: string
      source-sha:
        required: true
        type: string
      runner:
        required: true
        type: string
      workload:
        required: true
        type: string
permissions:
  contents: read
  actions: read
jobs:
  worker:
    name: worker
    runs-on: ${{ fromJSON(inputs.runner) }}
    timeout-minutes: 15
    steps:
      - uses: NVIDIA/spark-rapids-common/runner-queue-fallback/guard@main
        with:
          request-id: ${{ inputs.request-id }}
          parent-run-id: ${{ inputs.parent-run-id }}
          parent-run-attempt: ${{ inputs.parent-run-attempt }}
          source-ref: ${{ inputs.source-ref }}
          source-sha: ${{ inputs.source-sha }}
      - uses: NVIDIA/spark-rapids-common/checkout@main
        with:
          ref: ${{ inputs.source-sha }}
          persist-credentials: false
      - name: Workload
        run: node -p "process.platform + '/' + process.arch"
```

Replace only `Workload` with the repository's existing workload steps. No child
matrix, `needs`, environment approvals, job-level conditional skips, or concurrency
queue: this workflow isolates exactly one worker allocation so cancelling it cannot
cancel upstream builds or unrelated jobs. Do not rerun a child directly; rerun its parent.

### Choosing CPU or GPU labels

The CPU example tries `linux-amd64-cpu16`, then `linux-amd64-cpu32` in
`nv-cpu-general`. CPU sizes may differ because each candidate is explicitly chosen
by the caller. Memory-optimized labels such as `linux-amd64-cpu16m` require the
matching `nv-cpu-memory` group and separate access. Nothing silently adds a larger
instance or a memory-optimized pool.

For a GPU workload, use the same action and worker contract, replacing `runners`
with an approved GPU sequence, for example:

```json
[
  {"group":"nv-gpu-amd64-rtxpro6000-1gpu","labels":"linux-amd64-gpu-rtxpro6000-latest-1"},
  {"group":"nv-gpu-amd64-h100-1gpu","labels":"linux-amd64-gpu-h100-latest-1"},
  {"group":"nv-gpu-general","labels":"linux-amd64-gpu-l4-latest-1"}
]
```

Replace `Workload` with the GPU workload steps; `nvidia-smi` can be the initial GPU
sanity check. Never mix CPU and GPU candidates in one sequence. A CPU-only job and
a GPU job each use their own coordinator invocation and workload workflow.

For real workloads, prepare any upstream artifacts **before** the coordinator. Pass an
immutable artifact producer run ID, artifact name and public GHCR image digest in
the optional `workload` JSON object. Decode it using `fromJSON(inputs.workload)` in
the child to download that exact artifact or select the image. Common forwards the
object unchanged; it neither executes commands from it nor reads artifacts. Do not
pass secrets in dispatch inputs. The child must verify artifact/source provenance,
keep publishing credentials out of the worker job, and not use `continue-on-error` to
turn required test failures into success. Public GHCR images need no registry login.

### Daily image build

The repository's [daily image workflow](../.github/workflows/image-build.yml) reads
its image matrix from the [image catalog](../.github/image-builds.json), currently
containing the signoff image. It tries `linux-amd64-cpu16`, `cpu8`, `cpu4`, then
`cpu32`, all in `nv-cpu-general`, with a **10-minute queue timeout per candidate**.
Only one managed worker runs at a time. Memory-optimized groups are not enabled for
this repository, and ARM runners are intentionally excluded from this sequence.

The [image worker](../.github/workflows/image-build-worker.yml) retains the existing
30-minute build limit. It builds the configured platforms on the same x86 node
using Buildx and QEMU, checks anonymous pulls and runs the image's smoke script,
then promotes the verified digest to its configured tag. The signoff entry retains
both `linux/amd64` and `linux/arm64`, its two CLI checks, and the `v1` tag.
Emulated compilation is supported but may be
much slower than native compilation; a future heavy build can use separate native
architecture workers without relaxing the shared action's architecture checks.

To add an image, add a catalog entry with its build context, Dockerfile, supported
platforms (`linux/amd64` and/or `linux/arm64`), tag, and smoke-test script. The catalog
key becomes `ghcr.io/<owner>/<repository>/<key>` (lowercase). No workflow edits are
needed. The smoke script receives the immutable image reference and platform as
its two arguments and must fail on a failed check. Image-specific checks belong
beside that image, not in the generic worker. Only the image key is dispatched;
the worker reads build paths, tags, and scripts from its trusted checkout, not from
arbitrary dispatch inputs. The parent matrix is serialized to avoid flooding pools.

Unlike a PR test worker, this is a trusted publishing workload: it checks out only
the dispatch's `main` SHA, rejects any different source, and uses `packages: write`
only in the worker. The hosted coordinator has no package-write permission. Do not
reuse this privileged worker for PR code. The daily schedule and manual parent
trigger are unchanged; rerun the parent, not the dispatched worker.

## Behavior and limits

- One to four candidates, in the supplied order, never concurrent. Default queue
  deadline: 10 minutes each. Override from 1 to 30 minutes. The queue clock starts
  when the single worker job is first observed queued, not during upstream preparation.
- NVIDIA runner labels must preserve OS, architecture and CPU/GPU family. GPU
  candidates must also preserve GPU count. CPU core counts may differ. The caller
  must ensure **every** candidate meets its minimum CPU, RAM and disk requirements,
  including any smaller fallback size. For GPUs, additionally validate VRAM,
  CUDA/driver compatibility and compiled GPU architectures. Hardware-specific checks
  and benchmarks should use one candidate, not fallback to different hardware.
- Once runner allocation or step execution is observed, fallback is disabled.
  Container setup, GPU initialization, compilation, tests and execution timeouts
  are **not retried**. No skipped, missing, cancelled or unsuccessful required job
  can produce a successful coordinator.
- A queue timeout triggers a fresh state read, cancellation and completion
  confirmation before another dispatch. If the job acquires a runner during
  cancellation, stop with an explicit race error rather than run the workload again.
  GitHub has no atomic cancel-only-if-queued operation: that race can interrupt a
  just-started job, but cannot silently cause a fallback retry.
- Source changes, parent attempt changes and API/contract errors stop the sequence
  and clean up the active child. The workflow-definition SHA is checked for each
  dispatch. Keep `workflow-ref` stable during a sequence; a protected tag can avoid
  failures caused by unrelated changes to `main`.
- A newly dispatched child gets a two-minute startup window for run identity and
  job metadata to become visible. The first check waits fifteen seconds, counted within
  that window; pending metadata is then checked every five seconds. Temporary child/job
  HTTP 404 responses are retried only during startup. Identity must match exactly
  before accepting any result; later identity changes fail immediately. Expiry
  reports the last API error or expected/actual fields and cleans up, without
  dispatching another worker. In-flight requests can extend the observation window.
- Normal errors clean up immediately. A JavaScript post action also cancels the
  active child on parent cancellation. The child's startup guard rejects stale
  source, a completed parent or a rerun. Abrupt coordinator runner loss or GitHub
  API outages can prevent cleanup; a child already executing then relies on its
  own `timeout-minutes`. Check the reported run ID if cleanup cannot be confirmed.
- Set the parent timeout above all queue budgets, one execution budget and cleanup
  time. The example allows 65 minutes for up to 40 minutes of queueing, 15 minutes of
  execution and overhead. Defaults allow 180 minutes of execution; a longer real
  workload needs correspondingly larger parent and child timeouts.
- Logs and the parent step summary report candidates, observed waits, child links
  and outcomes, including the primary error and confirmed/unconfirmed cleanup.
  Success, failure and cleanup messages repeat an explicit "View worker logs and
  artifacts here" link to the child run; worker output is not copied into the parent.
  Outputs `run-id`, `run-url`, `runner` and `attempts` identify the last dispatch.
  All exhausted queues fail the parent check.
- Poll once per minute while queued or executing: approximately 240 read requests/hour
  per coordinator, plus dispatch/cleanup overhead. Each waiting round logs its number,
  child ID, observed status, elapsed time since dispatch and next polling interval;
  completion logs explicitly say polling has finished. Keep the example's single active
  coordinator per repo initially; tokens share a repository API quota. Reads and cancellation honor
  rate-limit reset/Retry-After headers with at most two retries of at most one minute
  each. Network/timeouts, malformed JSON, HTTP 408 and HTTP 5xx responses also get
  at most two retries for reads/cancellation, normally after 5s and 10s. Dispatch
  POSTs are never retried; authentication/permission failures fail immediately.
  Persistent errors report the method, API path, attempts and status/request ID
  or transport error. Longer outages fail closed and can prevent cleanup. Polling
  and API delays mean queue deadlines are not exact wall-clock caps.

This uses GitHub's `2026-03-10` REST API, including the dispatch response run ID.
GitHub Enterprise Server versions without that API contract are not supported.
Dispatch POSTs are not automatically retried; an ambiguous response is recovered
by the unique `run-name` for cancellation, never by dispatching a duplicate.

## Validation before rollout

Run the functional suite with Node.js 24:

```sh
node --test runner-queue-fallback/test/*.test.js
```

It exercises the coordinator, post cleanup and child guard using a fake GitHub
API and clock. No real API calls, credentials, sleeps or worker allocations are used.
The hosted-CPU test workflow runs only for PRs changing `runner-queue-fallback/**` or
`.github/workflows/runner-queue-fallback-test.yml`. Keep this path-filtered workflow
non-required globally so unrelated PRs are not blocked by an absent check.

Do not enable broad PR traffic until a bounded pilot proves primary success, queue
fallback, exhaustion, product failure without retry, parent cancellation and the
queue/start race on actual runners. The daily image build is the first consumer;
no other repository workflows are migrated, and there is no cross-repository
concurrency cap.

References:
- [Workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
- [Workflow cancellation API](https://docs.github.com/en/rest/actions/workflow-runs#cancel-a-workflow-run)
- [JavaScript action post hooks](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax#runspost)
