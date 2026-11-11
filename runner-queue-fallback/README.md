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
    timeout-minutes: 135
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
          runner-type: cpu
          queue-policy: extended
          queue-timeout-minutes: '10'
          execution-timeout-minutes: '15'
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

### Parallel workers

Run independent coordinator invocations in a parent matrix with a small
`strategy.max-parallel` limit, such as two, and `fail-fast: false` when independent
results are required. Each invocation has a unique request ID and action-local
cleanup state; it cancels only its own child. Pass a shard or task identifier in
`workload` and keep output artifact names distinct. The child still contains one
`worker` job, not a matrix. Candidate pools remain sequential within each invocation;
racing pools would allocate duplicate workers for the same task.

The parent matrix limit applies to that workflow run, not to all repositories or
simultaneous runs. Keep workflow concurrency and final result gates in the caller;
there is no shared task-claiming queue or cross-repository worker limit.

### Trusted cache preparation

The default `source-policy: current` stops workers when their source ref changes.
A trusted cache-preparation coordinator may set the literal
`source-policy: pinned-after-start` to let an allocated worker finish its original
SHA. Source checks remain required before dispatch, while queued, and in the
child's startup guard. Parent cancellation, identity checks and deadlines still apply.
Use `cancel-in-progress: false` in that coordinator to avoid canceling useful work
on a newer push. Keep PR validation on the default policy; do not derive this option
from PR code or dispatch inputs.

### Choosing CPU or GPU pools

Consumers **must** set `runner-type`, even with an explicit `runners` override.
`cpu` means `cpu-amd64`; `gpu` means `gpu-amd64`. Missing, blank or unknown types
fail before any API request. Omit `runners` (or leave it blank) to select the
profile's shared Linux defaults. `queue-policy: standard` is the default and
preserves the existing pool order and 10-minute omitted queue timeout. Existing
consumers need no changes. Explicit `queue-timeout-minutes` values still apply.

| `runner-type` | GPUs per worker | Standard order | Extra final queue with `extended` |
| --- | --- | --- | --- |
| `cpu` / `cpu-amd64` | None | 16 -> 8 -> 32 cores, amd64 | CPU32, 60 minutes |
| `cpu-arm64` | None | 16 -> 8 -> 32 cores, arm64 | CPU32, 60 minutes |
| `gpu` / `gpu-amd64` | 1 | RTX PRO 6000 -> H100 -> H200 -> A100 -> L40G -> L4 | RTX PRO 6000, 60 minutes |
| `gpu-arm64` | 1 | GB300 -> GH200 -> A100 -> L4 | None |
| `gpu-amd64-2gpu` | 2 | RTX PRO 6000 -> H100 -> H200 | RTX PRO 6000, 60 minutes |
| `gpu-arm64-2gpu` | 2 | L4 only; no alternative pool currently granted | None |

For example, set `runner-type: gpu-amd64-2gpu` for two GPUs on **one worker**,
not two independent workers. Queue exhaustion fails; it never downgrades GPU count
or switches architecture. Counts above two have no default profile yet.

The group/label pairs live in [index.js](index.js), based on the NVKS runner catalog
and Spark project grants in `nv-gha-runners/enterprise-runner-configuration`
(`docs/runner-groups.md` and `projects/spark.yaml`). GPU defaults use `latest` labels;
CPU defaults use `nv-cpu-general` and exclude 4-core instances. These are maintained
lists, not live discovery or a guarantee of queue availability.

Opt in to `queue-policy: extended` only after increasing the parent timeout.
Its normal queue defaults are **10 minutes for CPU** and **15 minutes for GPU**.
Its CPU profiles and the amd64 GPU profiles finish with a fresh 60-minute request
to the repeated pool. ARM GPU profiles have no RTX PRO 6000 pool and keep their
existing order without a repeated pool. Every earlier worker must be confirmed
cancelled without execution before another request, including the final re-wait.
The CPU32 final preference is based on a November 2026 cross-project scheduling
sample, not a capacity guarantee; the smaller ARM sample is less conclusive.

The consuming repository must have access to **every** selected pool, and its
workload must support their GPU architectures, driver, VRAM and minimum CPU/RAM/disk.
Repository-specific grants can be narrower than Spark's project defaults: common
and tools currently have only `nv-cpu-general` and `nv-gpu-general`. They must use
an explicit L4 list for GPU work instead of the broader default GPU profiles.

To restrict pools or change their order, replace the whole list with `runners`:

```yaml
runner-type: gpu
runners: '[{"group":"nv-gpu-general","labels":"linux-amd64-gpu-l4-latest-1"}]'
```

Overrides must match the selected CPU/GPU family, architecture and GPU count;
no default pools are appended. Malformed JSON or invalid candidates fail rather
than silently selecting defaults. Explicit lists can select another supported OS
or driver track. CPU sizes may differ; memory-optimized labels such as
`linux-amd64-cpu16m` require `nv-cpu-memory` and separate access.

A candidate may set a numeric `queue-timeout-minutes` from 1 to 60. It overrides
the action-level queue deadline. A duplicate label is accepted only as the final
candidate, with an explicit deadline and the same runner group:

```yaml
runner-type: cpu-amd64
queue-timeout-minutes: '10'
runners: >-
  [{"group":"nv-cpu-general","labels":"linux-amd64-cpu16"},
   {"group":"nv-cpu-general","labels":"linux-amd64-cpu32"},
   {"group":"nv-cpu-general","labels":"linux-amd64-cpu32","queue-timeout-minutes":60}]
```

The timeout property is coordinator policy only; the dispatched `runner` input
and output still contain just `group` and `labels`. Existing worker definitions
and explicit unique candidate lists remain compatible.

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

The repository's [daily image workflow](../.github/workflows/image-build.yml) now
uses [container-image](../container-image/README.md#daily-image-catalog) directly
on hosted `ubuntu-latest`, one image at a time. It no longer uses CPU queue
fallback. Its main-only schedule, manual trigger, signoff `v1` tag and amd64/arm64
checks are preserved.

Other consumers can use CPU or GPU fallback with their own workers; their queues
and policies are unaffected.

## Behavior and limits

- One to seven candidates, in the selected order, never concurrent. Standard
  policy retains 10-minute omitted deadlines and no automatic re-wait. Extended
  policy uses CPU 10 minutes, GPU 15 minutes, and final re-waits as listed above.
  Override from 1 to 60 minutes, with per-candidate overrides taking
  precedence over the action-level input. The queue clock starts
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
  confirmation before another dispatch. Run and job metadata are checked together
  every five seconds within one two-minute cancellation confirmation window; both
  must be completed/cancelled with no allocation or execution evidence. Each poll
  logs both states and runner allocation, tolerating delayed status/conclusion updates
  without relaxing identity validation. Expiry reports the last observation and stops
  without another dispatch. Queue-cancellation reads and their retries share that
  deadline; a response arriving after it cannot authorize fallback.
  If the job acquires a runner during
  cancellation, stop with an explicit race error rather than run the workload again.
  GitHub has no atomic cancel-only-if-queued operation: that race can interrupt a
  just-started job, but cannot silently cause a fallback retry.
- By default, source changes, parent attempt changes and API/contract errors stop the sequence
  and clean up the active child. The workflow-definition SHA is checked for each
  dispatch. Keep `workflow-ref` stable during a sequence; a protected tag can avoid
  failures caused by unrelated changes to `main`. `pinned-after-start` only exempts
  an allocated worker from later source-ref checks; it does not change approval,
  the startup guard, workflow-definition checks or cleanup.
- Before its first dispatch, the coordinator allows up to two minutes for the
  parent's initial queued/requested/pending state or HTTP 404 to become visible as
  active, polling every five seconds. The worker guard uses the same initial check
  before allowing workload code. Run ID and attempt must match; terminal or unknown
  states fail immediately. After confirmation, the coordinator never renews this
  grace. Requests and API retries share the startup deadline; logs show expected
  and observed fields. Expiry blocks dispatch or workload execution.
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
  time. The CPU example allows 135 minutes for up to 90 minutes of queueing, 15 minutes of
  execution and overhead. The extended amd64 single-GPU policy allows up to 150 minutes of
  queueing: six 15-minute queues plus a final 60-minute queue. A 15-minute worker
  should allow at least 195 minutes for its coordinator, including startup and
  cancellation overhead. Update existing coordinators before adopting longer queues;
  the action cannot extend the parent job's timeout.
  Defaults allow 180 minutes of execution; a longer real
  workload needs correspondingly larger parent and child timeouts.
- Logs and the parent step summary report candidates, observed waits, child links
  and outcomes, including the primary error and confirmed/unconfirmed cleanup.
  Success, failure and cleanup messages repeat an explicit "View worker job logs here"
  link directly to the worker job. The summary separately links to the run's artifacts.
  If neither a job URL nor job ID is available, the run link is labelled as a fallback.
  Worker output is not copied into the parent.
  Outputs `run-id`, `run-url`, `runner` and `attempts` identify the last dispatch.
  All exhausted queues fail the parent check.
- Poll once per minute while queued or executing: approximately 240 read requests/hour
  per coordinator, plus dispatch/cleanup overhead. Each waiting round logs its number,
  child ID, observed status, elapsed time since dispatch and next polling interval;
  completion logs explicitly say polling has finished. Keep the example's single active
  coordinator initially, or explicitly bound parallel coordinators as above; tokens
  share a repository API quota. Reads and cancellation honor
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
The [CPU CI workflow](../.github/workflows/cpu-ci.yml) selects this suite for runner,
image-coordinator, or shared CI changes. Unaffected jobs may skip; require only its
always-running `CPU CI gate` after rollout validation, not the individual suite job.

Do not enable broad PR traffic until a bounded pilot proves primary success, queue
fallback, exhaustion, product failure without retry, parent cancellation and the
queue/start race on actual runners. Each consumer owns its rollout and concurrency
limits; there is no cross-repository concurrency cap.

References:
- [Workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
- [Workflow cancellation API](https://docs.github.com/en/rest/actions/workflow-runs#cancel-a-workflow-run)
- [JavaScript action post hooks](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax#runspost)
