# Script security and Sonar reporting

Three actions share source inspection and reporting without owning builds, Sonar
scans, approval policy or runner management. No repository consumer is enabled by
this change.

- [`sonar-check/scan-scripts`](scan-scripts/README.md) inspects committed source and
  build files in an isolated, prebuilt Malcontent image on a GitHub-hosted runner.
  Its policy detects selected suspicious behaviors without executing PR code.
- `sonar-check/collect` runs beside the scanner with Python 3 and Sonar access.
  It verifies the CE task's project, PR, target branch and scanner revision, then
  retrieves the quality gate and High/Blocker counts by **analysis ID**.
- `sonar-check/report` runs with a GitHub token, comments on reportable findings and
  sets a **Sonar check / PR #N / scope** commit status. It needs no Sonar credential
  or network access to Sonar. Node 24 is supplied by its pinned GitHub Script action.

The Sonar result fails on a failed scanner, non-OK gate, or any new High/Blocker
issue. Missing or mismatched evidence also fails. Medium Sonar findings alone do
not fail this severity policy; other configured quality-gate conditions still apply.
The status and summary name the verified failure, for example
`Sonar failed: 2 High, 0 Blocker issues.` or `Sonar failed: scan was cancelled.`
Issue counts describe new issues in the exact analysis and include both severities.
Reporting failures identify the operation whose completion could not be confirmed.
Infrastructure and process failures publish a failed check with the reason and
retry guidance, without posting a PR comment. This includes failed/cancelled
server tasks, missing or invalid evidence, and changed targets. If Sonar rejects
an older concurrent analysis, the check asks the caller to serialize scans before
rerunning. Raw server error text and unverified issue counts are never published.
Clean passes publish only the successful check. Passing analyses with available
advisory findings receive a summary explaining why those findings do not block
the check. Verified High/Blocker or quality-gate failures also receive summaries.
Unavailable advisory details do not create a comment or invalidate an otherwise
verified passing analysis.

Issue APIs return mutable current PR data, not historical analysis snapshots.
When available, the summary labels these observations with their collection time
and links to the current Sonar view. They do not change the exact analysis result.
Concurrent analyses or unavailable issue APIs may omit this table without failing
an otherwise verified gate. The dashboard link is also a current PR view.

## Caller contract

Keep approval and trusted action revisions in the calling workflow. Remove stale
`report-task.txt` before scanning, pass the approved SHA as `sonar.scm.revision`,
explicitly pass the approved target branch as `sonar.pullrequest.base`, and pass
the expected project and PR to the scanner. Pass that same target branch to both
actions as `base-ref`; do not rely on scanner autodetection for this property.
The examples use `needs.approve.outputs.base-ref` from trusted approval metadata.
Use a fresh task file from that invocation; a matching older scan of the same SHA
is not a new invocation.
Call the report action with `phase: pending` on that SHA before scanning, then
use its default `report` phase after collection. Both phases derive the same
status context from the PR number and a digest of the full target branch, Sonar
URL and project. This prevents one PR or Sonar target from overwriting another
result when they share a commit. Summary comments use the same scope, so projects
reported in one run keep separate comments. Pin both phases to the same reviewed
action revision. New consumers must not write or require the old unqualified
`Sonar check` context. Preserve any existing required checks until a consumer's
merge-policy migration is explicitly approved. Serialize scans for the same Sonar
project and PR, including waiting for server processing and collection to finish;
overlapping submissions can be rejected when their analyses finish out of order.
Different PRs can run concurrently.
Rerun approval and scanning when the PR target branch changes
(`pull_request.edited`), as well as on new commits.

The status context varies by PR and is not a single fixed branch-protection gate.
GitHub commit statuses and ordinary required check names are commit-scoped;
a fixed-name workflow job alone does not establish PR isolation. Configure and
validate production merge-policy enforcement separately before requiring this
workflow. This action does not change repository rules.

After trusted approval, set pending in a hosted job with `statuses: write` and
pull-request read access. It publishes no comment and needs no result artifact:

```yaml
- uses: NVIDIA/spark-rapids-common/sonar-check/report@<reviewed-commit>
  with:
    phase: pending
    pr-number: ${{ github.event.pull_request.number }}
    sha: ${{ needs.approve.outputs.sha }}
    base-ref: ${{ needs.approve.outputs.base-ref }}
    sonar-url: ${{ vars.SONAR_URL }}
    project: ${{ vars.SONAR_PROJECT_KEY }}
```

Run the scanner and collector in a fresh trusted environment that has not executed
PR build scripts. Later step-local secrets do not isolate a compromised workspace,
and matching result identities do not authenticate a hostile producer.

The Sonar token must allow task/scanner-context and quality-gate reads. The gate
must contain `new_software_quality_high_issues` and
`new_software_quality_blocker_issues`, both with comparator `GT` and threshold `0`.

Collection inputs are `project`, `pr-number`, `sha`, `base-ref`, `scanner-outcome`,
`sonar-url` and `sonar-token`. `task-file` defaults to `.scannerwork/report-task.txt`;
`result-path` defaults to `${{ runner.temp }}/sonar-result.json`.

```yaml
- uses: NVIDIA/spark-rapids-common/sonar-check/collect@<reviewed-commit>
  id: collect
  if: always() && steps.scan.outcome != 'skipped'
  continue-on-error: true
  timeout-minutes: 12
  with:
    project: ${{ vars.SONAR_PROJECT_KEY }}
    pr-number: ${{ github.event.pull_request.number }}
    sha: ${{ needs.approve.outputs.sha }}
    base-ref: ${{ needs.approve.outputs.base-ref }}
    scanner-outcome: ${{ steps.scan.outcome }}
    sonar-url: ${{ vars.SONAR_URL }}
    sonar-token: ${{ secrets.SONAR_TOKEN }}
```

Collection writes schema-2 JSON even when analysis verification fails, and exposes
`result-path`, `passed`, `complete` and `source-attempt` outputs. Transfer that JSON
to a separate report job even after failure. Bind artifact upload/download to the
same workflow run and producing attempt, preserve the JSON file in the artifact,
and reject digest mismatches. Artifact transfer remains caller-owned.
The collector has a ten-minute polling budget; the caller's step/job timeout
provides the hard deadline for network reads and process termination.
Transient reads use at most three attempts, honoring `Retry-After` seconds or dates.
A requested delay that cannot fit the remaining budget fails without retrying early.
The artifact includes the approved `baseRef`. Identity is read only from the
root `Project scanner properties` context section; module properties cannot
replace missing root identity fields.

The report job must run with `if: always()`, depend on approval and scanning, and
have `pull-requests: write` and `statuses: write`. Download permissions may also
require `actions: read`. Use trusted reporting code and do not execute PR code in
this job. Do not pass the Sonar or runner-administration token to it.

```yaml
- uses: NVIDIA/spark-rapids-common/sonar-check/report@<reviewed-commit>
  if: always()
  timeout-minutes: 5
  with:
    result-path: ${{ runner.temp }}/sonar-report/sonar-result.json
    project: ${{ vars.SONAR_PROJECT_KEY }}
    pr-number: ${{ github.event.pull_request.number }}
    sha: ${{ needs.approve.outputs.sha }}
    base-ref: ${{ needs.approve.outputs.base-ref }}
    source-attempt: ${{ needs.scan.outputs.source-attempt || github.run_attempt }}
    scan-result: ${{ needs.scan.result }}
    sonar-url: ${{ vars.SONAR_URL }}
```

The default `phase: report` requires `result-path`, `source-attempt` and
`scan-result`; the pending phase does not. Reporting verifies the repository, PR,
SHA, target branch, run, producing attempt and project identity.
It uses the current workflow token by default
(`github-token` can supply a bot PAT).
Custom GitHub App tokens are not supported without a verified comment identity.
It publishes only to the approved SHA, annotates an advanced PR, and fails if the
current PR target branch differs from the approved target, even when its SHA is
unchanged. It also fails when a required findings summary or status cannot be published.
A rerun updates only a comment owned by that token's identity. It never retries an
ambiguous write automatically.

Run credential-free checks with:

```sh
node --test sonar-check/test/*.test.js
python3 -m unittest discover -s sonar-check/test -p 'test_*.py' -v
```
