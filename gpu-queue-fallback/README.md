# GPU queue fallback

Use a preferred GPU pool, then try the next compatible pool **only when a runner
has not been acquired within the queue deadline**. Each repository keeps its own
GPU commands; this action owns dispatch, queue monitoring, cancellation and results.
No Spark, JNI, cuML or NVFlare build logic is embedded here.

## Consumer setup

Add two small workflows in the consuming repository:

1. A trusted CPU coordinator calls `NVIDIA/spark-rapids-common/gpu-queue-fallback`.
2. A dedicated `workflow_dispatch` child contains exactly one job named `gpu`.
   It accepts the seven inputs below and uses the shared guard before workload code.

No copied polling scripts, GitHub App or PAT are needed. The coordinator uses its
repository's `GITHUB_TOKEN` with `actions: write`; the child uses only read access.
Runner access belongs to the **consuming repository**, not to common. All selected
groups must already be granted to that repository. Common and tools currently
have the general pool only; they can start with a single candidate.

The examples below are a manually triggered, one-GPU sanity pilot. They do not
enable automatic PR runs. Install both workflow files on the default branch before
dispatching. Pin both common actions to the same reviewed commit in production;
`@main` is shown for readability. Use only trusted workflow definitions, never
dispatch the child definition from an untrusted PR branch.

### Coordinator: `.github/workflows/gpu-check.yml`

```yaml
name: GPU check
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
  group: gpu-pilot
  cancel-in-progress: false
jobs:
  gpu-check:
    runs-on: ubuntu-latest
    timeout-minutes: 55
    permissions:
      contents: read
      actions: write
    steps:
      - uses: NVIDIA/spark-rapids-common/gpu-queue-fallback@main
        with:
          workflow: gpu-worker.yml
          workflow-ref: main
          source-ref: ${{ inputs.source-ref }}
          source-sha: ${{ inputs.source-sha }}
          queue-timeout-minutes: '10'
          execution-timeout-minutes: '15'
          runners: >-
            [
              {"group":"nv-gpu-amd64-rtxpro6000-1gpu","labels":"linux-amd64-gpu-rtxpro6000-latest-1"},
              {"group":"nv-gpu-amd64-h100-1gpu","labels":"linux-amd64-gpu-h100-latest-1"},
              {"group":"nv-gpu-general","labels":"linux-amd64-gpu-l4-latest-1"}
            ]
```

The CPU coordinator does not check out or execute workload code and does not hold
a managed CPU-pool runner. Keep this stable parent check as the required check:
the dispatched child's check belongs to the trusted workflow ref, not the tested
source SHA. When adding PR integration, retain the existing full-SHA approval gate
and attach the parent result to the intended source revision. This action does not
implement approval or post commit statuses. A read-only fork PR token cannot dispatch.

### Child: `.github/workflows/gpu-worker.yml`

```yaml
name: GPU worker
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
  gpu:
    name: gpu
    runs-on: ${{ fromJSON(inputs.runner) }}
    timeout-minutes: 15
    steps:
      - uses: NVIDIA/spark-rapids-common/gpu-queue-fallback/guard@main
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
      - name: GPU sanity
        run: nvidia-smi
```

Replace only `GPU sanity` with the repository's existing workload steps. No child
matrix, `needs`, environment approvals, job-level conditional skips, or concurrency
queue: this workflow isolates exactly one GPU allocation so cancelling it cannot
cancel CPU builds or unrelated jobs. Do not rerun a child directly; rerun its parent.

For real workloads, prepare CPU artifacts **before** the coordinator. Pass an
immutable artifact producer run ID, artifact name and public GHCR image digest in
the optional `workload` JSON object. Decode it using `fromJSON(inputs.workload)` in
the child to download that exact artifact or select the image. Common forwards the
object unchanged; it neither executes commands from it nor reads artifacts. Do not
pass secrets in dispatch inputs. The child must verify artifact/source provenance,
keep publishing credentials out of the GPU job, and not use `continue-on-error` to
turn required test failures into success. Public GHCR images need no registry login.

## Behavior and limits

- One to three candidates, in the supplied order, never concurrent. Default queue
  deadline: 10 minutes each. Override from 1 to 30 minutes. The queue clock starts
  when the single GPU job is first observed queued, not during CPU preparation.
- NVIDIA runner labels must preserve OS, architecture and GPU count. The caller
  must additionally validate VRAM, CUDA/driver compatibility and compiled GPU
  architectures across candidates. Hardware-specific checks and benchmarks should
  use one candidate, not fallback to a different GPU.
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
- Normal errors clean up immediately. A JavaScript post action also cancels the
  active child on parent cancellation. The child's startup guard rejects stale
  source, a completed parent or a rerun. Abrupt coordinator runner loss or GitHub
  API outages can prevent cleanup; a child already executing then relies on its
  own `timeout-minutes`. Check the reported run ID if cleanup cannot be confirmed.
- Set the parent timeout above all queue budgets, one execution budget and cleanup
  time. The example allows 55 minutes for 30 minutes of queueing, 15 minutes of
  execution and overhead. Defaults allow 180 minutes of execution; a longer real
  workload needs correspondingly larger parent and child timeouts.
- Logs and the parent step summary report candidates, observed waits, child links
  and outcomes. Outputs `run-id`, `run-url`, `runner` and `attempts` identify the last
  dispatch. All exhausted queues fail the parent check.
- Poll once per minute while queued and once per two minutes while executing:
  approximately 240 or 120 read requests/hour per coordinator, respectively, plus
  dispatch/cleanup overhead. Keep the example's single active coordinator per repo
  initially; tokens share a repository API quota. Reads and cancellation honor
  rate-limit reset/Retry-After headers with at most two retries of at most one minute
  each. Longer quota exhaustion fails closed and can prevent cleanup, like an API
  outage. Polling and API delays mean queue deadlines are not exact wall-clock caps.

This uses GitHub's `2026-03-10` REST API, including the dispatch response run ID.
GitHub Enterprise Server versions without that API contract are not supported.
Dispatch POSTs are not automatically retried; an ambiguous response is recovered
by the unique `run-name` for cancellation, never by dispatching a duplicate.

## Validation before rollout

Do not enable broad PR traffic until a bounded pilot proves primary success, queue
fallback, exhaustion, product failure without retry, parent cancellation and the
queue/start race on actual runners. This implementation alone does not migrate any
consumer, change its existing CI, or establish a cross-repository concurrency cap.

References:
- [Workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
- [Workflow cancellation API](https://docs.github.com/en/rest/actions/workflow-runs#cancel-a-workflow-run)
- [JavaScript action post hooks](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax#runspost)
