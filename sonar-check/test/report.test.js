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
const marker = '<!-- sonar-check:test-org/project:7:123:1 -->';
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

test('maps inputs without accepting repository or run overrides', () => {
  assert.deepEqual(
    optionsFromEnv({
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

test('publishes one successful summary and exact named commit status', async t => {
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
  assert.equal(f.statuses()[0].context, 'Sonar check');
  assert.equal(f.statuses()[0].state, 'success');
  assert.equal(f.statuses()[0].sha, sha);
  assert.equal(f.statuses()[0].owner, 'test-org');
  assert.equal(f.statuses()[0].repo, 'project');
});

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
    assert.match(f.comments[0].body, /Scan evidence is missing/);
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
    assert.doesNotMatch([...f.warnings, ...f.failures].join('\n'), /TOKEN-IN-BAD-JSON/);
  });
}

for (const change of [
  { gateStatus: 'ERROR' },
  { gateStatus: 'WARN' },
  { gateStatus: 'NONE' },
  { high: 1 },
  { blocker: 1 },
  { passed: false },
]) {
  test(`valid failing gate evidence ${JSON.stringify(change)} remains a failure`, async t => {
    const f = fixture(t, result(change));
    assert.equal((await f.run()).passed, false);
    assert.equal(f.statuses()[0].state, 'failure');
    assert.match(f.comments[0].body, /Full Sonar report/);
  });
}

for (const scanResult of ['failure', 'cancelled', 'skipped']) {
  test(`successful evidence does not override ${scanResult} scan job`, async t => {
    const f = fixture(t);
    f.options.scanResult = scanResult;
    assert.equal((await f.run()).passed, false);
    assert.equal(f.statuses()[0].state, 'failure');
  });
}

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

test('retargeted PR fails and explains the changed baseline even on the same SHA', async t => {
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
    published: true,
    statusPublished: true,
  });
  assert.match(f.comments[0].body, /Sonar check: FAIL/);
  assert.match(f.comments[0].body, /Target branch: \*\*release\/26\.12\*\*/);
  assert.match(f.comments[0].body, /PR target branch has since changed/);
  assert.doesNotMatch(f.comments[0].body, /PR head has since changed/);
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
      body: marker.replace(':1 -->', ':2 -->') + '\nother source attempt',
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
    assert.doesNotMatch(f.comments[0].body, /Full Sonar report/);
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
  { project: '' },
  { baseRef: undefined },
  { baseRef: '' },
  { baseRef: 'release candidate' },
  { baseRef: 'main\nother' },
  { sonarUrl: 'http://sonar.example.test' },
  { sonarUrl: `${sonarUrl}?token=secret` },
]) {
  test(`invalid reporting options fail on the safe target ${JSON.stringify(change)}`, async t => {
    const f = fixture(t);
    Object.assign(f.options, change);
    assert.equal((await f.run()).passed, false);
    assert.deepEqual(
      f.writes().map(call => call.name),
      ['status'],
    );
    assert.equal(f.statuses()[0].state, 'failure');
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
