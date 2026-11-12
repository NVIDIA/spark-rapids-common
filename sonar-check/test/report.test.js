// Copyright (c) 2026, NVIDIA CORPORATION.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { report, optionsFromEnv } = require('../report');
const sha = 'a'.repeat(40);
const baseRef = 'release/26.12';
const repository = 'test-org/project';
const sonarUrl = 'https://sonar.example.test';
const statusContext = 'Sonar check / PR #7 / 6f08ff44f51824640bc11b410f5a72fb';
const marker = '<!-- sonar-check:test-org/project:7:123:1:6f08ff44f51824640bc11b410f5a72fb -->';
const unverifiedDescription =
  'Sonar failed: analysis result could not be verified. Inspect scan and artifact steps, then rerun.';
const bot = {
  id: 41898282,
  type: 'Bot',
  login: 'github-actions[bot]',
};

function result(overrides = {}) {
  return {
    schema: 2,
    repository,
    sha,
    baseRef,
    pr: 7,
    runId: '123',
    runAttempt: '1',
    project: 'project-key',
    complete: true,
    passed: true,
    taskId: 'task-id',
    analysisId: 'analysis-id',
    gateStatus: 'OK',
    high: 0,
    blocker: 0,
    reportUrl: `${sonarUrl}/dashboard?id=project-key&pullRequest=7`,
    issues: [],
    totalIssues: 0,
    detailsComplete: true,
    detailsScope: overrides.detailsComplete === false ? null : 'current-pr',
    detailsCapturedAt: overrides.detailsComplete === false ? null : '2026-11-09T04:00:00Z',
    ...overrides,
  };
}

function issue(overrides = {}) {
  return {
    key: 'issue-key',
    rule: 'java:S123',
    message: 'A finding',
    path: 'src/Foo.java',
    line: 12,
    impacts: [
      {
        severity: 'MEDIUM',
        softwareQuality: 'MAINTAINABILITY',
      },
    ],
    legacySeverity: 'MAJOR',
    legacyType: 'CODE_SMELL',
    ...overrides,
  };
}

function fixture(t, evidence = result()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-report-'));
  t.after(() =>
    fs.rmSync(directory, {
      recursive: true,
      force: true,
    }),
  );
  const resultPath = path.join(directory, 'result.json');
  fs.writeFileSync(resultPath, JSON.stringify(evidence));
  const f = {
    directory,
    comments: [],
    calls: [],
    warnings: [],
    failures: [],
    handlers: {},
    context: {
      repo: {
        owner: 'test-org',
        repo: 'project',
      },
      runId: 123,
      runAttempt: 1,
      serverUrl: 'https://github.com',
    },
    options: {
      resultPath,
      prNumber: '7',
      sha,
      baseRef,
      sourceAttempt: '1',
      scanResult: 'success',
      sonarUrl,
      project: 'project-key',
      actionsToken: true,
    },
  };
  f.core = {
    warning: message => f.warnings.push(message),
    setFailed: message => f.failures.push(message),
  };
  const api = (name, operation) => async args => {
    assert.equal(args.request.timeout, 30000);
    if (name === 'status') {
      assert.ok(args.description.length <= 140);
    }
    f.calls.push({
      name,
      args: structuredClone(args),
    });
    return f.handlers[name] ? f.handlers[name](args) : operation(args);
  };
  f.github = {
    rest: {
      pulls: {
        get: api('pull', () => ({
          data: {
            number: 7,
            base: { ref: baseRef, repo: { full_name: repository } },
            head: { sha },
          },
        })),
      },
      users: {
        getAuthenticated: api('user', () => {
          throw Object.assign(new Error('Installation token'), { status: 403 });
        }),
      },
      issues: {
        listComments: api('list', args => ({
          data: f.comments.slice((args.page - 1) * 100, args.page * 100),
        })),
        createComment: api('create', args => {
          const comment = {
            id: f.comments.length + 100,
            user: bot,
            body: args.body,
          };
          f.comments.push(comment);
          return { data: comment };
        }),
        updateComment: api('update', args => {
          const comment = f.comments.find(row => row.id === args.comment_id);
          comment.body = args.body;
          return { data: comment };
        }),
      },
      repos: { createCommitStatus: api('status', () => ({ data: { id: 1 } })) },
    },
  };
  f.run = () => report(f);
  f.statuses = () => f.calls.filter(call => call.name === 'status').map(call => call.args);
  f.writes = () => f.calls.filter(call => ['create', 'update', 'status'].includes(call.name));
  return f;
}

function scopedFixture(t, changes = {}) {
  const options = {
    prNumber: '7',
    baseRef,
    sonarUrl,
    project: 'project-key',
    ...changes,
  };
  const reportUrl = new URL(`${options.sonarUrl.replace(/\/+$/, '')}/dashboard`);
  reportUrl.search = new URLSearchParams({ id: options.project, pullRequest: options.prNumber });
  const f = fixture(
    t,
    result({
      pr: Number(options.prNumber),
      baseRef: options.baseRef,
      project: options.project,
      reportUrl: reportUrl.href,
    }),
  );
  Object.assign(f.options, options);
  f.handlers.pull = () => ({
    data: {
      number: Number(options.prNumber),
      base: { ref: options.baseRef, repo: { full_name: repository } },
      head: { sha },
    },
  });
  return f;
}

function assertNoCommentCalls(f) {
  assert.deepEqual(
    f.calls.filter(call => ['user', 'list', 'create', 'update'].includes(call.name)),
    [],
  );
}

test('maps inputs without accepting repository or run overrides', () => {
  assert.deepEqual(
    optionsFromEnv({
      SONAR_REPORT_PHASE: 'pending',
      SONAR_RESULT_PATH: 'r.json',
      SONAR_PR_NUMBER: '7',
      SONAR_SHA: sha,
      SONAR_BASE_REF: baseRef,
      SONAR_SOURCE_ATTEMPT: '2',
      SONAR_SCAN_RESULT: 'failure',
      SONAR_URL: sonarUrl,
      SONAR_PROJECT_KEY: 'project-key',
      SONAR_REPORT_ACTIONS_TOKEN: 'true',
      GITHUB_REPOSITORY: 'other/repo',
      GITHUB_RUN_ID: '999',
    }),
    {
      phase: 'pending',
      resultPath: 'r.json',
      prNumber: '7',
      sha,
      baseRef,
      sourceAttempt: '2',
      scanResult: 'failure',
      sonarUrl,
      project: 'project-key',
      actionsToken: true,
    },
  );
});

test('defaults the adapter phase to final reporting', () => {
  assert.equal(optionsFromEnv({}).phase, 'report');
});

test('publishes one successful summary and exact scoped commit status', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.run(), {
    passed: true,
    published: true,
    statusPublished: true,
  });
  assert.equal(f.failures.length, 0);
  assert.deepEqual(
    f.writes().map(call => call.name),
    ['create', 'status'],
  );
  assert.ok(f.comments[0].body.startsWith(marker + '\n'));
  assert.match(f.comments[0].body, /No current PR findings/);
  assert.equal(f.statuses()[0].context, statusContext);
  assert.equal(f.statuses()[0].state, 'success');
  assert.equal(f.statuses()[0].description, 'Sonar passed: 0 High, 0 Blocker issues.');
  assert.equal(f.statuses()[0].sha, sha);
  assert.equal(f.statuses()[0].owner, 'test-org');
  assert.equal(f.statuses()[0].repo, 'project');
});

test('a successful different PR cannot overwrite a failure on the same commit', async t => {
  const failed = fixture(t, result({ passed: false, gateStatus: 'ERROR', high: 1 }));
  const passed = scopedFixture(t, { prNumber: '8' });
  assert.equal((await failed.run()).passed, false);
  assert.equal((await passed.run()).passed, true);
  const latestStatuses = new Map();
  for (const status of [...failed.statuses(), ...passed.statuses()]) {
    latestStatuses.set(`${status.sha}:${status.context.toLowerCase()}`, status.state);
  }
  assert.equal(latestStatuses.size, 2);
  assert.equal(latestStatuses.get(`${sha}:${statusContext.toLowerCase()}`), 'failure');
});

test('different Sonar projects preserve their own summaries within the same PR and run', async t => {
  const failed = fixture(t, result({ passed: false, gateStatus: 'ERROR', high: 1 }));
  const passed = scopedFixture(t, { project: 'other-project' });
  passed.comments = failed.comments;
  assert.equal((await failed.run()).passed, false);
  assert.equal((await passed.run()).passed, true);
  assert.equal(failed.comments.length, 2);
  assert.ok(failed.comments[0].body.startsWith(marker + '\n'));
  assert.match(failed.comments[0].body, /Sonar check: FAIL/);
  assert.match(failed.comments[1].body, /Sonar check: PASS/);
  assert.notEqual(
    failed.comments[0].body.split('\n')[0],
    failed.comments[1].body.split('\n')[0],
  );
  const passingBody = failed.comments[1].body;
  assert.equal((await failed.run()).passed, false);
  assert.equal(failed.comments.length, 2);
  assert.equal(failed.comments[1].body, passingBody);
  assert.equal(failed.calls.filter(call => call.name === 'update').length, 1);
});

for (const [name, changes] of [
  ['target branch', { baseRef: 'main' }],
  ['target branch case', { baseRef: 'Release/26.12' }],
  ['Sonar project', { project: 'other-project' }],
  ['Sonar project case', { project: 'PROJECT-KEY' }],
  ['Sonar service', { sonarUrl: 'https://other-sonar.example.test' }],
  ['Sonar context path', { sonarUrl: `${sonarUrl}/sonar` }],
]) {
  test(`separates ${name} on the same PR and commit`, async t => {
    const f = scopedFixture(t, changes);
    assert.equal((await f.run()).passed, true);
    assert.notEqual(f.statuses()[0].context.toLowerCase(), statusContext.toLowerCase());
    assert.match(f.statuses()[0].context, /^Sonar check \/ PR #7 \/ [a-f0-9]{32}$/);
    assert.equal(f.statuses()[0].sha, sha);
  });
}

test('preserves case-sensitive Sonar context paths in case-insensitive status contexts', async t => {
  const lower = scopedFixture(t, { sonarUrl: `${sonarUrl}/sonar` });
  const upper = scopedFixture(t, { sonarUrl: `${sonarUrl}/Sonar` });
  assert.equal((await lower.run()).passed, true);
  assert.equal((await upper.run()).passed, true);
  assert.notEqual(
    lower.statuses()[0].context.toLowerCase(),
    upper.statuses()[0].context.toLowerCase(),
  );
});

test('normalizes equivalent Sonar service URLs to the same context', async t => {
  const f = scopedFixture(t, { sonarUrl: 'https://SONAR.EXAMPLE.TEST:443///' });
  assert.equal((await f.run()).passed, true);
  assert.equal(f.statuses()[0].context, statusContext);
});

test('keeps long target branches bounded and out of the status context', async t => {
  const f = scopedFixture(t, { baseRef: `release/${'a'.repeat(1000)}` });
  assert.equal((await f.run()).passed, true);
  const context = f.statuses()[0].context;
  assert.match(context, /^Sonar check \/ PR #7 \/ [a-f0-9]{32}$/);
  assert.equal(context.length, statusContext.length);
  assert.ok(!context.includes(f.options.baseRef));
  assert.ok(!context.includes(f.options.project));
  assert.ok(!context.includes(f.options.sonarUrl));
});

test('keeps the same status context across workflow runs and producing attempts', async t => {
  const f = fixture(t);
  assert.equal((await f.run()).passed, true);
  f.context.runId = 124;
  f.context.runAttempt = 2;
  f.options.sourceAttempt = '2';
  fs.writeFileSync(
    f.options.resultPath,
    JSON.stringify(result({ runId: '124', runAttempt: '2' })),
  );
  assert.equal((await f.run()).passed, true);
  assert.deepEqual(f.statuses().map(status => status.context), [statusContext, statusContext]);
});

test('pending verifies approval and publishes without scan evidence or comment access', async t => {
  const f = fixture(t);
  fs.unlinkSync(f.options.resultPath);
  Object.assign(f.options, {
    phase: 'pending',
    resultPath: undefined,
    sourceAttempt: 'invalid',
    scanResult: 'not-started',
  });
  assert.deepEqual(await f.run(), {
    passed: false,
    published: false,
    statusPublished: true,
  });
  assert.deepEqual(f.calls.map(call => call.name), ['pull', 'status']);
  assert.equal(f.failures.length, 0);
  assert.equal(f.statuses()[0].state, 'pending');
  assert.equal(f.statuses()[0].context, statusContext);
  assert.equal(f.statuses()[0].sha, sha);
  assert.equal(f.statuses()[0].owner, 'test-org');
  assert.equal(f.statuses()[0].repo, 'project');
});

test('pending and final publication use the same status context', async t => {
  const f = fixture(t);
  f.options.phase = 'pending';
  assert.equal((await f.run()).statusPublished, true);
  f.options.phase = 'report';
  assert.equal((await f.run()).passed, true);
  assert.deepEqual(f.statuses().map(status => status.state), ['pending', 'success']);
  assert.deepEqual(f.statuses().map(status => status.context), [statusContext, statusContext]);
  assert.equal(f.comments.length, 1);
});

for (const [name, changes] of [
  ['different PR number', { number: 8 }],
  ['stale head', { head: { sha: 'b'.repeat(40) } }],
  ['missing head', { head: null }],
  ['retargeted branch', { base: { ref: 'main', repo: { full_name: repository } } }],
  ['different repository', { base: { ref: baseRef, repo: { full_name: 'other/repo' } } }],
]) {
  test(`pending rejects ${name} without publishing`, async t => {
    const f = fixture(t);
    f.options.phase = 'pending';
    f.handlers.pull = () => ({
      data: {
        number: 7,
        base: { ref: baseRef, repo: { full_name: repository } },
        head: { sha },
        ...changes,
      },
    });
    assert.deepEqual(await f.run(), {
      passed: false,
      published: false,
      statusPublished: false,
    });
    assert.deepEqual(f.calls.map(call => call.name), ['pull']);
    assert.equal(f.failures.length, 1);
  });
}

for (const failing of ['pull', 'status']) {
  test(`pending ${failing} errors fail without retry or raw diagnostics`, async t => {
    const f = fixture(t);
    f.options.phase = 'pending';
    f.handlers[failing] = () => {
      throw Object.assign(new Error('PRIVATE_TOKEN PRIVATE_RESPONSE'), {
        status: failing === 'pull' ? 403 : 504,
      });
    };
    assert.deepEqual(await f.run(), {
      passed: false,
      published: false,
      statusPublished: false,
    });
    assert.deepEqual(
      f.calls.map(call => call.name),
      failing === 'pull' ? ['pull'] : ['pull', 'status'],
    );
    assert.equal(f.failures.length, 1);
    assert.doesNotMatch(JSON.stringify([...f.failures, ...f.warnings]), /PRIVATE/);
    assert.equal(f.comments.length, 0);
  });
}

test('authoritative gate passes with unavailable details without claiming zero issues', async t => {
  const f = fixture(
    t,
    result({
      detailsComplete: false,
      totalIssues: null,
    }),
  );
  assert.equal((await f.run()).passed, true);
  assert.match(f.comments[0].body, /Issue details are unavailable/);
  assert.match(f.comments[0].body, /exact analysis quality gate/);
  assert.doesNotMatch(f.comments[0].body, /No current PR findings|Current PR findings: \*\*0/);
  assert.match(f.comments[0].body, /Full Sonar report/);
});

for (const [name, change] of Object.entries({
  'wrong schema': { schema: 1 },
  'different repository': { repository: 'other/project' },
  'different SHA': { sha: 'b'.repeat(40) },
  'missing target branch': { baseRef: undefined },
  'different target branch': { baseRef: 'main' },
  'different PR': { pr: 8 },
  'different run': { runId: '124' },
  'numeric run': { runId: 123 },
  'different project': { project: 'another-project' },
  'different source attempt': { runAttempt: '2' },
  'numeric attempt': { runAttempt: 1 },
  'incomplete result': { complete: false },
  'missing analysis': { analysisId: undefined },
  'numeric task identity': { taskId: 12 },
  'nonboolean passed': { passed: 'true' },
  'negative count': { high: -1 },
  'unsafe count': { blocker: Number.MAX_SAFE_INTEGER + 1 },
  'string count': { high: '0' },
  'unknown gate': { gateStatus: 'PASS' },
})) {
  test(`fails closed for ${name}`, async t => {
    const f = fixture(t, result(change));
    assert.equal((await f.run()).passed, false);
    assert.equal(f.statuses()[0].state, 'failure');
    assert.equal(f.failures.length, 1);
    assert.equal(f.statuses()[0].description, unverifiedDescription);
    assertNoCommentCalls(f);
  });
}

for (const [name, change] of Object.entries({
  'missing detail fields': {
    detailsComplete: undefined,
    issues: undefined,
  },
  'uncertain details claiming zero': {
    detailsComplete: false,
    totalIssues: 0,
  },
  'uncertain details containing issues': {
    detailsComplete: false,
    totalIssues: null,
    issues: [issue()],
  },
  'complete details missing count': { totalIssues: null },
  'wrong detail scope': { detailsScope: 'analysis' },
  'missing capture time': { detailsCapturedAt: undefined },
  'invalid capture time': { detailsCapturedAt: '2026-02-31T12:00:00Z' },
  'non-UTC capture time': { detailsCapturedAt: '2026-11-09T12:00:00+08:00' },
  'absent details with provenance': {
    detailsComplete: false,
    totalIssues: null,
    detailsScope: 'current-pr',
  },
  'too many findings': {
    totalIssues: 11,
    issues: Array.from({ length: 11 }, (_, i) => issue({ key: String(i) })),
  },
  'duplicate finding': {
    totalIssues: 2,
    issues: [issue(), issue()],
  },
  'unsafe file path': {
    totalIssues: 1,
    issues: [issue({ path: '../other' })],
  },
  'invalid source line': {
    totalIssues: 1,
    issues: [issue({ line: 0 })],
  },
  'invalid severity': {
    totalIssues: 1,
    issues: [
      issue({
        impacts: [
          {
            severity: 'CRITICAL',
            softwareQuality: 'SECURITY',
          },
        ],
      }),
    ],
  },
})) {
  test(`omits ${name} without changing the exact gate result`, async t => {
    const f = fixture(t, result(change));
    assert.equal((await f.run()).passed, true);
    assert.equal(f.statuses()[0].state, 'success');
    assert.equal(f.failures.length, 0);
    assert.match(f.comments[0].body, /Issue details are unavailable/);
    assert.match(f.warnings[0], /Invalid advisory Sonar details were omitted/);
  });
}

test('omitting invalid advisory data never rescues a failed exact gate', async t => {
  const f = fixture(
    t,
    result({
      gateStatus: 'ERROR',
      high: 1,
      issues: 'malformed',
    }),
  );
  assert.equal((await f.run()).passed, false);
  assert.equal(f.statuses()[0].state, 'failure');
  assert.match(f.comments[0].body, /Exact analysis quality gate: \*\*ERROR/);
  assert.match(f.comments[0].body, /Issue details are unavailable/);
});

test('current High findings do not override authoritative historical gate counts', async t => {
  const f = fixture(
    t,
    result({
      totalIssues: 1,
      issues: [
        issue({
          impacts: [
            {
              severity: 'HIGH',
              softwareQuality: 'SECURITY',
            },
          ],
        }),
      ],
    }),
  );
  assert.equal((await f.run()).passed, true);
  assert.match(f.comments[0].body, /HIGH SECURITY/);
  assert.match(f.comments[0].body, /advisory observations may differ/);
  assert.equal(f.statuses()[0].state, 'success');
});

for (const mode of ['missing', 'malformed', 'oversized', 'directory', 'symlink']) {
  test(`fails closed for ${mode} evidence file`, async t => {
    const f = fixture(t);
    if (mode === 'missing') {
      fs.unlinkSync(f.options.resultPath);
    }
    if (mode === 'malformed') {
      fs.writeFileSync(f.options.resultPath, 'TOKEN-IN-BAD-JSON');
    }
    if (mode === 'oversized') {
      fs.writeFileSync(f.options.resultPath, 'x'.repeat(1024 * 1024 + 1));
    }
    if (mode === 'directory') {
      f.options.resultPath = f.directory;
    }
    if (mode === 'symlink') {
      const alias = path.join(f.directory, 'alias');
      fs.symlinkSync(f.options.resultPath, alias);
      f.options.resultPath = alias;
    }
    assert.equal((await f.run()).passed, false);
    assert.equal(f.statuses()[0].state, 'failure');
    assertNoCommentCalls(f);
    assert.doesNotMatch([...f.warnings, ...f.failures].join('\n'), /TOKEN-IN-BAD-JSON/);
  });
}

for (const [change, reason] of [
  [{ gateStatus: 'ERROR' }, 'quality gate did not pass (ERROR)'],
  [{ gateStatus: 'WARN' }, 'quality gate did not pass (WARN)'],
  [{ gateStatus: 'NONE' }, 'quality gate did not pass (NONE)'],
  [{ high: 1 }, '1 High, 0 Blocker issues'],
  [{ high: 2 }, '2 High, 0 Blocker issues'],
  [{ blocker: 1 }, '0 High, 1 Blocker issues'],
  [{ high: 2, blocker: 1 }, '2 High, 1 Blocker issues'],
]) {
  test(`valid failing gate evidence ${JSON.stringify(change)} remains a failure`, async t => {
    const f = fixture(t, result(change));
    assert.equal((await f.run()).passed, false);
    assert.equal(f.statuses()[0].state, 'failure');
    assert.match(f.comments[0].body, /Full Sonar report/);
    assert.equal(f.statuses()[0].description, `Sonar failed: ${reason}.`);
    assert.ok(f.comments[0].body.includes(`**Sonar check: FAIL — ${reason}.**`));
    assert.equal(f.failures[0], `Sonar failed: ${reason}.`);
    assert.doesNotMatch(f.comments[0].body, /policy, or target branch verification/);
  });
}

for (const scanResult of ['failure', 'cancelled', 'skipped']) {
  test(`successful evidence does not override ${scanResult} scan job`, async t => {
    const f = fixture(t);
    f.options.scanResult = scanResult;
    assert.equal((await f.run()).passed, false);
    assert.equal(f.statuses()[0].state, 'failure');
    assertNoCommentCalls(f);
    assert.match(f.failures[0], /rerun/i);
  });
}

test('zero-count OK analysis marked not passed is a process failure without a comment', async t => {
  const f = fixture(t, result({ passed: false }));
  assert.deepEqual(await f.run(), { passed: false, published: false, statusPublished: true });
  assert.equal(
    f.statuses()[0].description,
    'Sonar failed: analysis was not marked as passed. Inspect the scan logs, then rerun.',
  );
  assert.deepEqual(f.calls.map(call => call.name), ['status']);
});

for (const scanResult of ['cancelled', 'skipped']) {
  for (const finding of [{ high: 1 }, { blocker: 1 }, { gateStatus: 'ERROR' }]) {
    test(`${scanResult} process suppresses even verified ${JSON.stringify(finding)} comments`, async t => {
      const f = fixture(t, result(finding));
      f.options.scanResult = scanResult;
      assert.deepEqual(await f.run(), { passed: false, published: false, statusPublished: true });
      assert.ok(f.statuses()[0].description.startsWith(`Sonar failed: scan was ${scanResult}.`));
      assertNoCommentCalls(f);
    });
  }
}

test('a verified quality-gate failure still posts findings when the scanner job fails', async t => {
  const f = fixture(t, result({ passed: false, gateStatus: 'ERROR' }));
  f.options.scanResult = 'failure';
  assert.deepEqual(await f.run(), { passed: false, published: true, statusPublished: true });
  assert.equal(f.statuses()[0].description, 'Sonar failed: quality gate did not pass (ERROR).');
  assert.equal(f.comments.length, 1);
});

test('verified High findings explain a failed scanner without listing unrelated causes', async t => {
  const f = fixture(t, result({ passed: false, gateStatus: 'ERROR', high: 1 }));
  f.options.scanResult = 'failure';
  assert.equal((await f.run()).passed, false);
  assert.equal(f.statuses()[0].description, 'Sonar failed: 1 High, 0 Blocker issues.');
  assert.match(f.comments[0].body, /Sonar check: FAIL — 1 High, 0 Blocker issues/);
  assert.doesNotMatch(f.comments[0].body, /scan job failed|publication failed|verification did not pass/);
});

for (const [scanResult, reason] of [
  ['failure', 'scan job failed'],
  ['cancelled', 'scan was cancelled'],
  ['skipped', 'scan was skipped'],
  ['success', 'analysis result could not be verified'],
]) {
  test(`unverified evidence reports the known ${scanResult} scan outcome`, async t => {
    const f = fixture(t, result({ complete: false, high: 99, error: 'SECRET-RAW-ERROR' }));
    f.options.scanResult = scanResult;
    assert.equal((await f.run()).passed, false);
    assert.ok(f.statuses()[0].description.startsWith(`Sonar failed: ${reason}.`));
    assert.equal(f.failures[0], f.statuses()[0].description);
    assert.match(f.failures[0], /rerun/i);
    assertNoCommentCalls(f);
    assert.doesNotMatch(JSON.stringify(f.statuses()), /99|SECRET-RAW-ERROR/);
  });
}

function failedAnalysis(failureCode = 'analysis-out-of-order', changes = {}) {
  return result({
    complete: false,
    passed: false,
    failureCode,
    high: 99,
    blocker: 99,
    error: 'SECRET-RAW-ERROR',
    ...changes,
  });
}

for (const [code, reason, nextStep] of [
  [
    'analysis-out-of-order',
    'a newer analysis finished first',
    'Serialize scans for this PR, then rerun.',
  ],
  [
    'analysis-failed',
    'Sonar server analysis failed',
    'Inspect the collection step and Sonar task details before rerunning.',
  ],
  [
    'analysis-cancelled',
    'Sonar server analysis was cancelled',
    'Review the Sonar task cancellation, then rerun.',
  ],
]) {
  test(`verified incomplete ${code} fails only the check with safe retry guidance`, async t => {
    const f = fixture(t, failedAnalysis(code));
    assert.deepEqual(await f.run(), { passed: false, published: false, statusPublished: true });
    assert.equal(f.statuses()[0].description, `Sonar failed: ${reason}. ${nextStep}`);
    assert.equal(f.failures[0], f.statuses()[0].description);
    assert.deepEqual(f.calls.map(call => call.name), ['status']);
    assertNoCommentCalls(f);
    assert.doesNotMatch(JSON.stringify([...f.statuses(), ...f.failures]), /99|SECRET-RAW-ERROR/);
  });

  test(`complete successful evidence ignores ${code}`, async t => {
    const f = fixture(t, result({ failureCode: code }));
    assert.equal((await f.run()).passed, true);
    assert.equal(f.statuses()[0].description, 'Sonar passed: 0 High, 0 Blocker issues.');
    assert.doesNotMatch(f.comments[0].body, /Serialize scans|Sonar task:/);
  });
}

for (const [field, value] of Object.entries({
  schema: 3,
  repository: 'another/project',
  sha: 'b'.repeat(40),
  baseRef: 'another-target',
  pr: 8,
  runId: '124',
  runAttempt: '2',
  project: 'another-project',
  taskId: 'invalid/task',
  complete: null,
  passed: true,
})) {
  for (const candidate of new Set([value, undefined, null])) {
    test(`incomplete failure code rejects ${field}=${candidate}`, async t => {
      const f = fixture(t, failedAnalysis('analysis-out-of-order', { [field]: candidate }));
      assert.equal((await f.run()).passed, false);
      assert.equal(f.statuses()[0].description, unverifiedDescription);
      assert.equal(f.statuses()[0].sha, sha);
      assertNoCommentCalls(f);
      assert.doesNotMatch(
        JSON.stringify([...f.statuses(), ...f.failures]),
        /newer analysis|Serialize scans|Sonar task:|99|SECRET-RAW-ERROR/,
      );
    });
  }
}

for (const code of ['unknown', '__proto__', 'constructor', 'toString', null, {}, 123]) {
  test(`unrecognized failure code ${JSON.stringify(code)} retains the generic failure`, async t => {
    const f = fixture(t, failedAnalysis(code));
    assert.equal((await f.run()).passed, false);
    assert.equal(f.statuses()[0].description, unverifiedDescription);
    assertNoCommentCalls(f);
    assert.doesNotMatch(JSON.stringify(f.statuses()), /newer analysis|Serialize scans|99|SECRET-RAW-ERROR/);
  });
}

for (const [scanResult, reason] of [
  ['cancelled', 'scan was cancelled'],
  ['skipped', 'scan was skipped'],
]) {
  test(`${scanResult} scan takes precedence over a server failure code`, async t => {
    const f = fixture(t, failedAnalysis());
    f.options.scanResult = scanResult;
    assert.equal((await f.run()).passed, false);
    assert.ok(f.statuses()[0].description.startsWith(`Sonar failed: ${reason}.`));
    assertNoCommentCalls(f);
    assert.doesNotMatch(JSON.stringify(f.statuses()), /newer analysis|Serialize scans|Sonar task:/);
  });
}

test('verified server reason explains a failed scan job', async t => {
  const f = fixture(t, failedAnalysis());
  f.options.scanResult = 'failure';
  assert.equal((await f.run()).passed, false);
  assert.equal(
    f.statuses()[0].description,
    'Sonar failed: a newer analysis finished first. Serialize scans for this PR, then rerun.',
  );
  assertNoCommentCalls(f);
});

test('process failure leaves an existing summary untouched without comment API access', async t => {
  const f = fixture(t, failedAnalysis());
  f.comments.push({ id: 1, user: bot, body: marker + '\nprevious complete analysis' });
  f.handlers.user = () => {
    throw new Error('Comment access unavailable');
  };
  assert.deepEqual(await f.run(), { passed: false, published: false, statusPublished: true });
  assertNoCommentCalls(f);
  assert.deepEqual(f.calls.map(call => call.name), ['status']);
  assert.equal(f.comments[0].body, marker + '\nprevious complete analysis');
  assert.doesNotMatch(f.failures[0], /summary publication/);
});

test('unconfirmed status publication retains the operational cause and retry guidance', async t => {
  const f = fixture(t, failedAnalysis());
  f.handlers.status = () => {
    throw new Error('PRIVATE-RESPONSE');
  };
  assert.deepEqual(await f.run(), { passed: false, published: false, statusPublished: false });
  assertNoCommentCalls(f);
  assert.match(f.failures[0], /newer analysis finished first/);
  assert.match(f.failures[0], /Serialize scans for this PR, then rerun/);
  assert.match(f.failures[0], /status publication was not confirmed/);
  assert.doesNotMatch(JSON.stringify([...f.failures, ...f.warnings]), /PRIVATE-RESPONSE/);
  assert.equal(f.statuses().length, 1);
});

test('verified complete High findings ignore failure codes', async t => {
  const f = fixture(
    t,
    result({ passed: false, gateStatus: 'ERROR', high: 1, failureCode: 'analysis-out-of-order' }),
  );
  assert.equal((await f.run()).passed, false);
  assert.equal(f.statuses()[0].description, 'Sonar failed: 1 High, 0 Blocker issues.');
  assert.doesNotMatch(f.comments[0].body, /newer analysis|Serialize scans|Sonar task:/);
});

test('maximum verified issue counts fit the commit status limit', async t => {
  const f = fixture(
    t,
    result({
      high: Number.MAX_SAFE_INTEGER,
      blocker: Number.MAX_SAFE_INTEGER,
    }),
  );
  assert.equal((await f.run()).passed, false);
  assert.equal(
    f.statuses()[0].description,
    'Sonar failed: 9007199254740991 High, 9007199254740991 Blocker issues.',
  );
});

test('retargeting takes precedence over verified findings', async t => {
  const f = fixture(t, result({ high: 1, gateStatus: 'ERROR' }));
  f.handlers.pull = () => ({
    data: {
      number: 7,
      base: { ref: 'main', repo: { full_name: repository } },
      head: { sha },
    },
  });
  assert.equal((await f.run()).passed, false);
  assert.equal(f.statuses()[0].description, 'Sonar failed: target branch changed; rerun scan.');
  assertNoCommentCalls(f);
});

test('unconfirmed summary publication takes precedence over analysis findings', async t => {
  const f = fixture(t, result({ high: 1, gateStatus: 'ERROR' }));
  f.handlers.create = () => {
    throw new Error('SECRET-RAW-ERROR');
  };
  assert.equal((await f.run()).passed, false);
  assert.equal(
    f.statuses()[0].description,
    'Sonar failed: summary publication was not confirmed. Check the PR comment, then retry reporting.',
  );
  assert.equal(f.calls.filter(call => call.name === 'create').length, 1);
});

test('medium findings do not fail the check', async t => {
  const f = fixture(
    t,
    result({
      totalIssues: 1,
      issues: [issue()],
    }),
  );
  assert.equal((await f.run()).passed, true);
  assert.match(f.comments[0].body, /MEDIUM MAINTAINABILITY/);
  assert.match(f.comments[0].body, /Medium findings alone do not fail/);
  assert.match(f.comments[0].body, /project\/issues\?id=project-key&pullRequest=7&open=issue-key/);
  assert.match(f.comments[0].body, /advisory observations may differ from the analyzed commit/);
  assert.match(f.comments[0].body, /collected at 2026-11-09T04:00:00Z/);
  assert.doesNotMatch(f.comments[0].body, /\/blob\//);
});

test('report retry consumes the required original source attempt and updates its comment', async t => {
  const f = fixture(t);
  await f.run();
  f.context.runAttempt = 2;
  assert.equal((await f.run()).passed, true);
  assert.equal(f.comments.length, 1);
  assert.equal(f.calls.filter(call => call.name === 'update').length, 1);
  assert.match(f.comments[0].body, /\[Scan run\].*attempts\/1/);
  assert.match(f.comments[0].body, /\[Report retry\].*attempts\/2/);
  assert.ok(f.comments[0].body.startsWith(marker + '\n'));
});

test('stale PR head is annotated and status remains on analyzed SHA', async t => {
  const f = fixture(t);
  f.handlers.pull = () => ({
    data: {
      number: 7,
      base: { ref: baseRef, repo: { full_name: repository } },
      head: { sha: 'b'.repeat(40) },
    },
  });
  assert.equal((await f.run()).passed, true);
  assert.match(f.comments[0].body, /PR head has since changed/);
  assert.equal(f.statuses()[0].sha, sha);
  assert.doesNotMatch(f.comments[0].body, new RegExp('b'.repeat(40)));
});

test('retargeted PR fails without a summary even on the same SHA', async t => {
  const f = fixture(t);
  f.handlers.pull = () => ({
    data: {
      number: 7,
      base: { ref: 'main', repo: { full_name: repository } },
      head: { sha },
    },
  });
  assert.deepEqual(await f.run(), {
    passed: false,
    published: false,
    statusPublished: true,
  });
  assertNoCommentCalls(f);
  assert.equal(f.statuses()[0].description, 'Sonar failed: target branch changed; rerun scan.');
  assert.equal(f.statuses()[0].sha, sha);
  assert.equal(f.statuses()[0].state, 'failure');
  assert.equal(f.failures.length, 1);
});

test('missing current PR target branch fails without publishing a misleading summary', async t => {
  const f = fixture(t);
  f.handlers.pull = () => ({
    data: {
      number: 7,
      base: { repo: { full_name: repository } },
      head: { sha },
    },
  });
  assert.equal((await f.run()).passed, false);
  assert.equal(f.comments.length, 0);
  assert.equal(f.statuses()[0].state, 'failure');
});

test('cannot redirect PR lookup or writes to a different repository', async t => {
  const f = fixture(t);
  f.handlers.pull = () => ({
    data: {
      number: 7,
      base: { ref: baseRef, repo: { full_name: 'other/repo' } },
      head: { sha },
    },
  });
  assert.equal((await f.run()).passed, false);
  assert.equal(f.comments.length, 0);
  assert.equal(f.statuses()[0].repo, 'project');
  assert.equal(f.statuses()[0].state, 'failure');
});

test('does not edit copied markers written by humans or unrelated bots', async t => {
  const f = fixture(t);
  f.comments = [
    {
      id: 1,
      user: {
        id: 5,
        type: 'User',
        login: 'person',
      },
      body: marker + '\ncopy',
    },
    {
      id: 2,
      user: {
        id: 6,
        type: 'Bot',
        login: 'other[bot]',
      },
      body: marker + '\ncopy',
    },
    {
      id: 3,
      user: bot,
      body: marker.replace(':123:', ':124:') + '\nother run',
    },
    {
      id: 4,
      user: bot,
      body: marker.replace(':123:1:', ':123:2:') + '\nother source attempt',
    },
  ];
  await f.run();
  assert.equal(f.comments.length, 5);
  assert.equal(f.calls.filter(call => call.name === 'update').length, 0);
});

test('updates an authenticated token owners comment, not a same-login different ID', async t => {
  const f = fixture(t);
  f.options.actionsToken = false;
  const user = {
    id: 55,
    type: 'User',
    login: 'service-user',
  };
  f.handlers.user = () => ({ data: user });
  f.comments = [
    {
      id: 1,
      user: {
        ...user,
        id: 56,
      },
      body: marker + '\ncopy',
    },
    {
      id: 2,
      user,
      body: marker + '\nold',
    },
  ];
  await f.run();
  assert.equal(f.calls.find(call => call.name === 'update').args.comment_id, 2);
  assert.equal(f.comments.length, 2);
});

test('does not assume an unidentified custom App token owns Actions bot comments', async t => {
  const f = fixture(t);
  f.options.actionsToken = false;
  f.comments.push({
    id: 1,
    user: bot,
    body: marker + '\nexisting',
  });
  assert.equal((await f.run()).passed, false);
  assert.deepEqual(
    f.writes().map(call => call.name),
    ['status'],
  );
  assert.equal(f.statuses()[0].state, 'failure');
  assert.equal(f.comments[0].body, marker + '\nexisting');
});

test('paginates comments before selecting the existing owned marker', async t => {
  const f = fixture(t);
  f.comments = Array.from({ length: 100 }, (_, id) => ({
    id: id + 1,
    user: bot,
    body: 'Unrelated',
  }));
  f.comments.push({
    id: 101,
    user: bot,
    body: marker + '\nold',
  });
  await f.run();
  assert.equal(f.calls.filter(call => call.name === 'list').length, 2);
  assert.equal(f.calls.find(call => call.name === 'update').args.comment_id, 101);
});

test('ambiguous duplicate owned comments fail without another comment mutation', async t => {
  const f = fixture(t);
  f.comments = [1, 2].map(id => ({
    id,
    user: bot,
    body: marker + '\nold',
  }));
  assert.equal((await f.run()).passed, false);
  assert.deepEqual(
    f.writes().map(call => call.name),
    ['status'],
  );
  assert.equal(f.statuses()[0].state, 'failure');
});

for (const failing of ['pull', 'user', 'list', 'create', 'update', 'status']) {
  test(`${failing} failure is single-shot and never logs raw API error`, async t => {
    const f = fixture(t);
    if (failing === 'update') {
      f.comments.push({
        id: 1,
        user: bot,
        body: marker + '\nold',
      });
    }
    f.handlers[failing] = () => {
      throw new Error('AUTHORIZATION-TOKEN raw response body');
    };
    assert.equal((await f.run()).passed, false);
    assert.equal(f.calls.filter(call => call.name === failing).length, 1);
    assert.equal(f.statuses().length, 1);
    if (failing !== 'status') {
      assert.equal(f.statuses()[0].state, 'failure');
    }
    assert.equal(f.failures.length, 1);
    const reason = failing === 'pull'
      ? 'pull request could not be verified'
      : failing === 'status'
        ? 'status publication was not confirmed'
        : 'summary publication was not confirmed';
    assert.ok(f.failures[0].includes(reason));
    assert.match(f.failures[0], /retry/i);
    if (failing !== 'status') {
      assert.equal(f.statuses()[0].description, f.failures[0]);
    }
    if (failing === 'pull') {
      assertNoCommentCalls(f);
    }
    assert.doesNotMatch([...f.warnings, ...f.failures].join('\n'), /AUTHORIZATION|raw response/);
  });
}

test('an ambiguous accepted comment write is not retried and gets a failure status', async t => {
  const f = fixture(t);
  f.handlers.create = args => {
    f.comments.push({
      id: 1,
      user: bot,
      body: args.body,
    });
    throw new Error('Timed out after server accepted request');
  };
  assert.equal((await f.run()).passed, false);
  assert.equal(f.comments.length, 1);
  assert.equal(f.calls.filter(call => call.name === 'create').length, 1);
  assert.equal(f.statuses()[0].state, 'failure');
});

for (const reportUrl of [
  'http://sonar.example.test/dashboard?id=project-key&pullRequest=7',
  'https://evil.test/dashboard?id=project-key&pullRequest=7',
  `${sonarUrl}:444/dashboard?id=project-key&pullRequest=7`,
  `${sonarUrl}/other?id=project-key&pullRequest=7`,
  `${sonarUrl}/dashboard?id=project-key&pullRequest=8`,
  `${sonarUrl}/dashboard?id=other&pullRequest=7`,
  `${sonarUrl}/dashboard?id=project-key&pullRequest=7&pullRequest=8`,
  `${sonarUrl}/dashboard?id=project-key&pullRequest=7&token=secret`,
  `${sonarUrl}/dashboard?id=project-key&pullRequest=7#fragment`,
  'https://user:password@sonar.example.test/dashboard?id=project-key&pullRequest=7',
]) {
  test(`rejects unexpected dashboard URL ${reportUrl}`, async t => {
    const f = fixture(t, result({ reportUrl }));
    assert.equal((await f.run()).passed, false);
    assert.equal(f.statuses()[0].state, 'failure');
    assertNoCommentCalls(f);
  });
}

test('accepts configured Sonar context path and escaped project identity', async t => {
  const f = fixture(
    t,
    result({
      project: 'org:project',
      reportUrl: `${sonarUrl}/sonar/dashboard?id=org%3Aproject&pullRequest=7`,
    }),
  );
  f.options.sonarUrl = `${sonarUrl}/sonar/`;
  f.options.project = 'org:project';
  assert.equal((await f.run()).passed, true);
});

test('escapes table syntax, HTML, mentions, newlines and link destinations', async t => {
  const f = fixture(
    t,
    result({
      totalIssues: 1,
      issues: [
        issue({
          rule: 'java:*rule*',
          message: '<script>@team [click](https://evil.test) | ![img]\nnext',
          path: 'src/Foo(1).java',
          legacyType: '<b>@other</b>',
        }),
      ],
    }),
  );
  assert.equal((await f.run()).passed, true);
  const body = f.comments[0].body;
  assert.match(body, /&lt;script&gt;&#64;team/);
  assert.ok(body.includes('\\[click\\]\\(https://evil.test\\) \\| \\!\\[img\\] next'));
  assert.ok(body.includes('Foo\\(1\\).java:12'));
  assert.match(body, /project\/issues\?id=project-key&pullRequest=7&open=issue-key/);
  assert.doesNotMatch(body, /<script>|@team|@other/);
});

test('bounds top-ten comment size even with long escaped locations and messages', async t => {
  const issues = Array.from({ length: 10 }, (_, n) =>
    issue({
      key: `issue-${n}`,
      path: `src/${'\u6d4b'.repeat(1800)}.java`,
      message: '<'.repeat(4000),
    }),
  );
  const f = fixture(
    t,
    result({
      totalIssues: 50,
      issues,
    }),
  );
  assert.equal((await f.run()).passed, true);
  assert.ok(f.comments[0].body.length < 65536);
  assert.match(f.comments[0].body, /Showing 10 of 50 issues/);
});

test('caps rendered rows before the comment limit without truncating Markdown', async t => {
  const issues = Array.from({ length: 10 }, (_, n) =>
    issue({
      key: `${n}${'\u6d4b'.repeat(390)}`,
      rule: '<'.repeat(400),
      path: '<'.repeat(180),
      message: '<'.repeat(4000),
      impacts: Array.from({ length: 10 }, () => ({
        severity: 'MEDIUM',
        softwareQuality: '<'.repeat(100),
      })),
    }),
  );
  const f = fixture(
    t,
    result({
      totalIssues: 10,
      issues,
    }),
  );
  assert.equal((await f.run()).passed, true);
  assert.ok(f.comments[0].body.length < 65536);
  assert.match(f.comments[0].body, /Showing [1-9] of 10 issues/);
  assert.match(f.comments[0].body, /\[Full Sonar report\]/);
});

for (const change of [
  { sourceAttempt: '' },
  { sourceAttempt: '2' },
  { sourceAttempt: '01' },
  { scanResult: 'unknown' },
  { resultPath: '' },
]) {
  test(`invalid report options fail within the verified scope ${JSON.stringify(change)}`, async t => {
    const f = fixture(t);
    Object.assign(f.options, change);
    assert.equal((await f.run()).passed, false);
    assert.deepEqual(
      f.writes().map(call => call.name),
      ['status'],
    );
    assert.equal(f.statuses()[0].context, statusContext);
    assert.equal(f.statuses()[0].state, 'failure');
    assert.equal(
      f.statuses()[0].description,
      'Sonar failed: invalid reporting configuration. Fix reporter inputs, then rerun.',
    );
    assertNoCommentCalls(f);
  });
}

for (const change of [
  { project: '' },
  { project: 'project\nPRIVATE' },
  { baseRef: undefined },
  { baseRef: '' },
  { baseRef: 'release candidate' },
  { baseRef: 'main\nother' },
  { sonarUrl: 'http://sonar.example.test' },
  { sonarUrl: `${sonarUrl}?token=secret` },
  { sonarUrl: 'https://PRIVATE@sonar.example.test' },
]) {
  for (const phase of ['pending', 'report']) {
    test(`invalid ${phase} scope makes no API calls ${JSON.stringify(change)}`, async t => {
      const f = fixture(t);
      Object.assign(f.options, change, { phase });
      assert.deepEqual(await f.run(), {
        passed: false,
        published: false,
        statusPublished: false,
      });
      assert.equal(f.calls.length, 0);
      assert.equal(f.failures.length, 1);
      assert.doesNotMatch(JSON.stringify([...f.failures, ...f.warnings]), /PRIVATE|secret/);
    });
  }
}

for (const phase of ['', 'unknown', 42, null]) {
  test(`invalid phase makes no API calls ${JSON.stringify(phase)}`, async t => {
    const f = fixture(t);
    f.options.phase = phase;
    assert.equal((await f.run()).passed, false);
    assert.equal(f.calls.length, 0);
    assert.equal(f.failures.length, 1);
  });
}

test('invalid target identity makes no API calls', async t => {
  const f = fixture(t);
  f.options.sha = 'not-a-sha';
  assert.equal((await f.run()).passed, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.failures.length, 1);
});

test('adapter pins supported github-script and disables mutation retries/debug logging', () => {
  const action = fs.readFileSync(path.join(__dirname, '../report/action.yml'), 'utf8');
  assert.match(action, /actions\/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0/);
  assert.match(action, /retries: 0/);
  assert.match(action, /debug: false/);
  assert.match(action, /SONAR_REPORT_ACTION_PATH: \$\{\{ github.action_path }}/);
  assert.match(action, /SONAR_BASE_REF: \$\{\{ inputs.base-ref }}/);
  assert.match(action, /SONAR_REPORT_PHASE: \$\{\{ inputs.phase }}/);
  assert.match(action, /SONAR_REPORT_ACTIONS_TOKEN: \$\{\{ inputs.github-token == github.token }}/);
  const script = action
    .split('        script: |\n')[1]
    .split('\n')
    .map(line => line.slice(10))
    .join('\n');
  assert.doesNotMatch(script, /\$\{\{/);
  assert.doesNotThrow(
    () =>
      new (Object.getPrototypeOf(async function () {}).constructor)(
        'require',
        'github',
        'core',
        'context',
        script,
      ),
  );
});
