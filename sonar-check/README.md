# Sonar collection and PR reporting

Two actions share reporting without owning builds, scans, approval policy or
runner management. No repository consumer is enabled by this change.

- `sonar-check/collect` runs beside the scanner with Python 3 and Sonar access.
  It verifies the CE task's project, PR and scanner revision, then retrieves the
  quality gate and High/Blocker counts by **analysis ID**.
- `sonar-check/report` runs with a GitHub token, upserts a summary comment and
  sets the **Sonar check** commit status. It needs no Sonar credential or network
  access to Sonar. Node 24 is supplied by its pinned GitHub Script action.

A failed scanner, non-OK gate, or any new High/Blocker issue fails the check.
Missing or mismatched evidence also fails. Medium findings alone do not fail this
severity policy; other configured quality-gate conditions still apply.

Issue APIs return mutable current PR data, not historical analysis snapshots.
When available, the summary labels these observations with their collection time
and links to the current Sonar view. They do not change the exact analysis result.
Concurrent analyses or unavailable issue APIs may omit this table without failing
an otherwise verified gate. The dashboard link is also a current PR view.

## Caller contract

Keep approval and trusted action revisions in the calling workflow. Remove stale
`report-task.txt` before scanning, pass the approved SHA as `sonar.scm.revision`,
and pass the expected project and PR to the scanner. Use a fresh task file from
that invocation; a matching older scan of the same SHA is not a new invocation.
Set `Sonar check` pending on that SHA before scanning and serialize runs for the
same PR; different PRs can run concurrently.
The Sonar token must allow task/scanner-context and quality-gate reads. The gate
must contain `new_software_quality_high_issues` and
`new_software_quality_blocker_issues`, both with comparator `GT` and threshold `0`.

Collection inputs are `project`, `pr-number`, `sha`, `scanner-outcome`, `sonar-url`
and `sonar-token`. `task-file` defaults to `.scannerwork/report-task.txt`;
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
    source-attempt: ${{ needs.scan.outputs.source-attempt || github.run_attempt }}
    scan-result: ${{ needs.scan.result }}
    sonar-url: ${{ vars.SONAR_URL }}
```

Reporting verifies repository/PR/SHA/run/producing-attempt/project identity and
uses the current workflow token by default (`github-token` can supply a bot PAT).
Custom GitHub App tokens are not supported without a verified comment identity.
It publishes only to the approved SHA, annotates an advanced PR, and fails when
either the summary or status cannot be published. A rerun updates only a comment
owned by that token's identity. It never retries an ambiguous write automatically.

Run credential-free checks with:

```sh
node --test sonar-check/test/*.test.js
python3 -m unittest discover -s sonar-check/test -p 'test_*.py' -v
```
