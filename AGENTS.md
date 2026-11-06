# Agent Guide

## Repository and Ownership

- This repository provides shared GitHub Actions, reusable workflows, and scripts.
  Read the affected component's `action.yml` and README, then trace its callers
  before changing inputs, outputs, runtime versions, or defaults.
- `workflow-suite-selector/` selects affected suites; `workflow-result-gate/`
  checks job results; `runner-queue-fallback/` owns worker acquisition and cleanup.
  Keep repository-specific paths, workload commands, and approval policy in callers.
- `shimpler-source-tools/` and `spark-home-deps/` are also used outside this repo.
  Preserve local and CI entry points; state any consumer migration and merge order.
- Prefer the smallest change at the owning layer. Reuse existing actions and
  workflows instead of copying orchestration into another script or workflow.
  New shared actions need a README with inputs, outputs, permissions, and usage.
- `container-image/metadata.py` owns portable recipe hashing, not project tags,
  CUDA policies or registry access. Keep its standalone Python API/CLI usable by
  GHA and internal CI. Consumers must explicitly list all local COPY/ADD inputs
  in `recipe-inputs`, including requirements files and context controls such as
  `.dockerignore`; do not introduce a Dockerfile parser. File-content-only and
  copied-file-permission-only changes must change the fingerprint. Preserve the
  no-input hash format and maintain the existing container-image functional tests
  for this contract.

## Workflow and Suite Changes

- Before adding CI, inspect `.github/workflows/`, `.github/cpu-ci-suites.json`,
  and existing tests for the same workload. Extend `cpu-ci.yml` for compatible
  CPU checks; do not recreate separate workflows for suites it already runs.
- When adding, renaming, moving, or removing a gated suite, update these together:
  its catalog paths and `jobs`, workflow job definitions and selection conditions,
  and the final gate's direct `needs`. Catalog `jobs` are job IDs, not display
  names, and the catalog does not create jobs. Include the selector in the gate.
- Check source, test, build-script, and workflow paths, not just the edited YAML.
  `exclude_paths` applies only within that suite's `paths`; it is not global.
  `shared_paths` selects all enabled suites despite exclusions, so reserve it for
  genuinely shared inputs. Do not add the catalog or bot config there by default.
  Use `enabled: false` with a reason in `comment` for an intentional suite pause.
- Keep selection and the final gate running for unaffected PRs. Do not add
  event-level path filters to a gate workflow. Keep `if: always()` on the gate;
  selected jobs must succeed, while legitimately unselected jobs may skip.
  Failed selection, missing results, and skipped required jobs must fail closed.
- The result gate sees only its direct `needs` in the same workflow. Hosted,
  self-hosted, and reusable-workflow caller jobs can share a gate when their
  trigger and trust policies match. Keep distinct gates for independently
  triggered workflows or different approval policies; do not invent cross-run
  polling just to combine them. Keep trusted image publishing separate from PR CI.
- Preserve stable gate check names. Repository rules are a separate rollout step:
  do not claim a gate blocks merging until its required-check setting is verified.
  Retain existing required checks when proposing that rollout.

## Execution Safety

- CPU CI uses ordinary `pull_request` events, read-only tokens, and local actions
  from the checked-out `github.sha` to validate changes before merge. Do not replace
  those local calls with `@main` and accidentally test the old implementation.
- The selector verifies PR identity, not permission to execute code. Preserve
  caller approval boundaries, exact source revisions, and minimal permissions;
  do not execute untrusted PR code with publishing credentials or a write token.
- Runner fallback is for queue acquisition, not retrying failed tests. Preserve
  bounded deadlines, worker identity checks, and confirmed cleanup before fallback.
  Consumers must specify `runner-type`; custom lists override shared defaults.
- When runner access changes, reconcile defaults with both the enterprise runner
  catalog and Spark project grants. Check architecture and GPU count; another
  project's runner access is not evidence that Spark can use that pool.
- Keep optional caches separate from required artifacts. Preserve source/run
  identity in artifact handoffs; cache or image availability must not hide failures.

## Validation and Handoff

Run affected existing suites from the repository root (Node.js 24 and Python 3):

```sh
node --test runner-queue-fallback/test/*.test.js
python3 -m unittest discover -s shimpler-source-tools/tests -p 'test_*.py' -v
python3 -m unittest discover -s spark-home-deps/tests -p 'test_*.py' -v
```

- On macOS, Shimpler path assertions may need a canonical temporary directory:
  prefix its command with `TMPDIR="$(realpath "${TMPDIR:-/tmp}")"`.
- Maintain affected existing tests. For infrastructure scripts without a suite,
  use focused checks or safe dry runs; do not add a new harness without a request.
  Lint changed workflows with `actionlint` and run `git diff --check`.
- For selector/gate changes, validate affected, unaffected, docs-only, rename,
  deletion, disabled-suite, failure, cancellation, and missing/skipped required-job
  paths. Also verify stale PR metadata and incomplete detection fail closed.
  Distinguish mocked checks from live worker, cache, or publication validation.
- Inspect the final diff for duplicate execution, missing gate dependencies, and
  unintended permission or resource changes. Do not trigger GPU jobs, publish
  images, merge PRs, or alter repository rules without authorization.
- Follow `CONTRIBUTING.md` for commit signoff. Keep PR descriptions concise and
  current: behavior, compatibility/rollout, validation revision, and remaining gaps.
  Preserve explicitly requested draft/review status and keep internal data out of
  public logs and comments.
