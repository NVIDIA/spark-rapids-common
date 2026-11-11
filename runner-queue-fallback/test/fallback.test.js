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
const timers = require('node:timers/promises');
const {test} = require('node:test');

const sourceSha = 'a'.repeat(40);
const workflowSha = 'b'.repeat(40);
const gpuRunners = [
  {group: 'nv-gpu-amd64-rtxpro6000-1gpu', labels: 'linux-amd64-gpu-rtxpro6000-latest-1'},
  {group: 'nv-gpu-amd64-h100-1gpu', labels: 'linux-amd64-gpu-h100-latest-1'},
  {group: 'nv-gpu-general', labels: 'linux-amd64-gpu-l4-latest-1'},
];
const cpuRunners = [
  {group: 'nv-cpu-general', labels: 'linux-amd64-cpu16'},
  {group: 'nv-cpu-general', labels: 'linux-amd64-cpu32'},
];

function fixture(t, runners = gpuRunners) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-fallback-'));
  const label = runners?.[0]?.labels ?? '';
  const family = label.includes('-cpu') ? 'cpu' : 'gpu';
  const architecture = label.includes('-arm64-') ? 'arm64' : 'amd64';
  const gpuCount = family === 'gpu' ? label.match(/-(\d+)$/)?.[1] : undefined;
  const env = {
    GITHUB_API_URL: 'https://api.example.invalid',
    GITHUB_SERVER_URL: 'https://example.invalid',
    GITHUB_REPOSITORY: 'example/consumer',
    GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_OUTPUT: path.join(directory, 'output'),
    GITHUB_STATE: path.join(directory, 'state'),
    GITHUB_STEP_SUMMARY: path.join(directory, 'summary'),
    STATE_active: 'null',
    'INPUT_GITHUB-TOKEN': 'test-token',
    INPUT_WORKFLOW: 'runner-worker.yml', 'INPUT_WORKFLOW-REF': 'main',
    'INPUT_SOURCE-REF': 'refs/pull/1/merge', 'INPUT_SOURCE-SHA': sourceSha,
    'INPUT_SOURCE-POLICY': 'current',
    INPUT_RUNNERS: JSON.stringify(runners),
    'INPUT_QUEUE-POLICY': 'standard',
    'INPUT_RUNNER-TYPE': `${family}-${architecture}${gpuCount && gpuCount !== '1' ? `-${gpuCount}gpu` : ''}`,
    INPUT_WORKLOAD: JSON.stringify({artifactRunId: 42, artifactName: 'build'}),
    'INPUT_QUEUE-TIMEOUT-MINUTES': '1', 'INPUT_EXECUTION-TIMEOUT-MINUTES': '1',
    'INPUT_REQUEST-ID': 'runner-7-1-guard',
    'INPUT_PARENT-RUN-ID': '7', 'INPUT_PARENT-RUN-ATTEMPT': '1',
  };
  const originalEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const originalExitCode = process.exitCode;
  Object.assign(process.env, env);
  process.exitCode = undefined;
  for (const filename of [env.GITHUB_OUTPUT, env.GITHUB_STATE, env.GITHUB_STEP_SUMMARY]) {
    fs.writeFileSync(filename, '');
  }
  const modules = ['../index', '../lib', '../cleanup', '../guard/index'].map(require.resolve);
  for (const filename of modules) delete require.cache[filename];

  const f = {
    now: Date.parse('2026-01-01T00:00:00Z'),
    runs: [], requests: [], events: [], errors: [], logs: [], sleeps: [], unexpected: [],
    parent: {id: 7, status: 'in_progress', run_attempt: 1, conclusion: null}, source: sourceSha,
    onDispatch() {},
    onCancel(run) { f.finish(run, 'cancelled'); },
    onSleep() {},
    beforeRequest() {},
    finish(run, conclusion) {
      run.status = run.job.status = 'completed';
      run.conclusion = run.job.conclusion = conclusion;
      if (conclusion !== 'cancelled' && conclusion !== 'skipped') f.acquire(run);
      f.events.push(`completed:${run.id}:${conclusion}`);
    },
    acquire(run) {
      run.job.runner_id = 123;
      run.job.runner_name = 'fake-runner';
    },
    state() {
      const lines = fs.readFileSync(env.GITHUB_STATE, 'utf8').trim().split('\n');
      return lines[0] ? JSON.parse(lines.at(-1).slice('active='.length)) : null;
    },
    outputs() {
      return Object.fromEntries(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8').trim().split('\n')
        .filter(Boolean).map(line => {
          const index = line.indexOf('=');
          return [line.slice(0, index), line.slice(index + 1)];
        }));
    },
    async run(entry = '../index') {
      await require(entry)().catch(require('../lib').fail);
      return process.exitCode ?? 0;
    },
  };
  t.after(() => {
    process.exitCode = originalExitCode;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const filename of modules) delete require.cache[filename];
    fs.rmSync(directory, {recursive: true, force: true});
    assert.deepEqual(f.unexpected, [], 'No unexpected API calls');
  });
  t.mock.method(console, 'log', message => f.logs.push(message));
  t.mock.method(console, 'error', message => f.errors.push(message));
  t.mock.method(Date, 'now', () => f.now);
  // Mock only the imported sleep, leaving node:test's real timeout active.
  t.mock.method(timers, 'setTimeout', async milliseconds => {
    f.sleeps.push(milliseconds);
    f.now += milliseconds;
    await f.onSleep(milliseconds);
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const parsed = new URL(url);
    const prefix = '/repos/example/consumer';
    const route = parsed.pathname.slice(prefix.length);
    const request = {route, url: parsed, at: f.now, ...options};
    f.requests.push(request);
    if (parsed.origin !== env.GITHUB_API_URL || !parsed.pathname.startsWith(`${prefix}/`)) {
      f.unexpected.push(url);
      throw new Error('Network access is forbidden in these tests');
    }
    const override = f.beforeRequest(request);
    if (override) return override;
    const json = body => new Response(JSON.stringify(body), {status: 200});
    if (options.method === 'GET' && route === '/commits/main') return json({sha: workflowSha});
    if (options.method === 'GET' && route === `/commits/${encodeURIComponent(process.env['INPUT_SOURCE-REF'])}`) {
      return json({sha: f.source});
    }
    if (options.method === 'GET' && route === '/actions/runs/7') return json(f.parent);
    if (options.method === 'POST' && route === '/actions/workflows/runner-worker.yml/dispatches') {
      // Catch duplicate/overlapping dispatch even if a scenario otherwise ends successfully.
      if (f.runs.some(run => run.status !== 'completed')) {
        f.unexpected.push('dispatch before previous run completed');
      }
      const payload = JSON.parse(options.body);
      const run = {
        id: 100 + f.runs.length, status: 'queued', conclusion: null,
        run_attempt: 1, event: 'workflow_dispatch', head_sha: workflowSha,
        display_title: payload.inputs['request-id'], payload,
        job: {
          id: 1000 + f.runs.length,
          html_url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${100 + f.runs.length}/job/${1000 + f.runs.length}`,
          name: 'worker', status: 'queued', conclusion: null,
          runner_id: 0, runner_name: '', steps: [],
          started_at: new Date(f.now).toISOString(),
          labels: [JSON.parse(payload.inputs.runner).labels],
        },
      };
      f.runs.push(run);
      f.events.push(`dispatch:${run.id}`);
      await f.onDispatch(run);
      return json({workflow_run_id: run.id});
    }
    if (options.method === 'GET' && route === '/actions/workflows/runner-worker.yml/runs') {
      return json({total_count: f.runs.length, workflow_runs: f.runs});
    }
    const match = route.match(/^\/actions\/runs\/(\d+)(\/cancel|\/attempts\/1\/jobs)?$/);
    const run = match && f.runs.find(item => item.id === Number(match[1]));
    if (run && options.method === 'GET' && !match[2]) return json(run);
    if (run && options.method === 'GET' && match[2] === '/attempts/1/jobs') {
      return json({total_count: 1, jobs: [run.job]});
    }
    if (run && options.method === 'POST' && match[2] === '/cancel') {
      f.events.push(`cancel:${run.id}`);
      await f.onCancel(run);
      return new Response(null, {status: 202});
    }
    f.unexpected.push(`${options.method} ${route}`);
    throw new Error(`Unexpected API call: ${options.method} ${route}`);
  });
  return f;
}

test('primary success forwards immutable inputs and reports the selected run', {timeout: 5000}, async t => {
  const f = fixture(t);
  f.onDispatch = run => f.finish(run, 'success');
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.events, ['dispatch:100', 'completed:100:success']);
  assert.equal(f.runs[0].payload.ref, 'main');
  assert.equal(f.runs[0].payload.inputs['source-sha'], sourceSha);
  assert.equal(f.runs[0].payload.inputs['parent-run-id'], '7');
  assert.equal(f.runs[0].payload.inputs['parent-run-attempt'], '1');
  assert.deepEqual(JSON.parse(f.runs[0].payload.inputs.workload), {artifactRunId: 42, artifactName: 'build'});
  assert.equal(f.outputs()['run-id'], '100');
  assert.equal(f.outputs().attempts, '1');
  assert.deepEqual(JSON.parse(f.outputs().runner), gpuRunners[0]);
  assert.equal(f.state(), null);
  assert.equal(f.errors.length, 0);
  const url = 'https://example.invalid/example/consumer/actions/runs/100';
  assert.equal(f.logs.at(-1), `View worker job logs here: ${url}/job/1000`);
  const summary = fs.readFileSync(process.env.GITHUB_STEP_SUMMARY, 'utf8');
  assert.ok(summary.includes(`[View worker job logs here](${url}/job/1000)`));
  assert.ok(summary.includes(`[Worker artifacts](${url})`));
});

for (const entry of ['../index', '../guard/index']) {
  const caller = entry === '../index' ? 'coordinator' : 'worker guard';
  for (const status of ['queued', 'requested', 'pending', 'HTTP 404']) {
    test(`${caller} waits for initial parent ${status}`, {timeout: 5000}, async t => {
      const f = fixture(t);
      if (entry === '../guard/index') process.env.GITHUB_RUN_ID = '100';
      const started = f.now;
      let parentReads = 0;
      f.beforeRequest = request => {
        if (request.route !== '/actions/runs/7' || ++parentReads > 2) return;
        return status === 'HTTP 404' ? new Response('', {status: 404}) :
          Response.json({...f.parent, status});
      };
      f.onDispatch = run => {
        assert.equal(parentReads, 3, 'No dispatch before parent confirmation');
        assert.equal(f.now - started, 10000);
        f.finish(run, 'success');
      };
      assert.equal(await f.run(entry), 0);
      assert.equal(f.runs.length, entry === '../index' ? 1 : 0);
      assert.deepEqual(f.sleeps, entry === '../index' ? [5000, 5000, 15000] : [5000, 5000]);
      assert.match(f.logs.join('\n'), /Parent 7: startup visibility 0s\/120s; expected/);
      assert.match(f.logs.join('\n'), /"id":7,"run_attempt":1,"status":"in_progress"/);
      assert.ok(f.logs.some(line => line.includes(status === 'HTTP 404' ? 'HTTP 404' : `"status":"${status}"`)));
      assert.match(f.logs.join('\n'), /active at the expected attempt after 10s/);
      assert.equal(f.errors.length, 0);
    });
  }

  for (const status of ['queued', 'HTTP 404']) {
    test(`${caller} bounds persistent initial parent ${status}`, {timeout: 5000}, async t => {
      const f = fixture(t);
      if (entry === '../guard/index') process.env.GITHUB_RUN_ID = '100';
      const started = f.now;
      f.beforeRequest = request => {
        if (request.route !== '/actions/runs/7') return;
        return status === 'HTTP 404' ? new Response('', {status: 404}) :
          Response.json({...f.parent, status});
      };
      assert.equal(await f.run(entry), 1);
      assert.equal(f.now - started, 120000);
      assert.equal(f.requests.filter(request => request.route === '/actions/runs/7').length, 25);
      assert.ok(f.requests.every(request => request.method === 'GET'));
      assert.equal(f.runs.length, 0);
      assert.match(f.errors.join('\n'), /startup visibility 120s\/120s; expected/);
      assert.match(f.errors.join('\n'), /confirmation timed out; no dispatch or workload allowed/);
      assert.ok(f.errors[0].includes(status === 'HTTP 404' ? 'HTTP 404' : '"status":"queued"'));
      assert.equal(f.state(), null);
    });
  }

  for (const [name, fields] of [
    ['completed', {status: 'completed', conclusion: 'success'}],
    ['cancelled', {status: 'completed', conclusion: 'cancelled'}],
    ['cancelling', {status: 'in_progress', conclusion: 'cancelled'}],
    ['different run', {id: 8}],
    ['different attempt', {run_attempt: 2}],
    ['missing attempt', {run_attempt: undefined}],
    ['missing run', {id: undefined}],
    ['missing conclusion', {conclusion: undefined}],
    ['approval wait', {status: 'waiting'}],
  ]) {
    test(`${caller} immediately rejects ${name} parent`, {timeout: 5000}, async t => {
      const f = fixture(t);
      if (entry === '../guard/index') process.env.GITHUB_RUN_ID = '100';
      Object.assign(f.parent, fields);
      assert.equal(await f.run(entry), 1);
      assert.deepEqual(f.sleeps, []);
      assert.equal(f.runs.length, 0);
      assert.equal(f.requests.filter(request => request.route === '/actions/runs/7').length, 1);
      assert.match(f.errors.join('\n'), /Parent run is no longer active.*expected .*actual/);
      for (const [field, value] of Object.entries(fields)) {
        const observed = field === 'conclusion' && value === undefined ? '<missing>' : value ?? null;
        assert.ok(f.errors[0].includes(`"${field}":${JSON.stringify(observed)}`));
      }
    });
  }

  test(`${caller} stops if parent is cancelled during startup grace`, {timeout: 5000}, async t => {
    const f = fixture(t);
    if (entry === '../guard/index') process.env.GITHUB_RUN_ID = '100';
    f.parent.status = 'queued';
    f.onSleep = () => { Object.assign(f.parent, {status: 'completed', conclusion: 'cancelled'}); };
    assert.equal(await f.run(entry), 1);
    assert.deepEqual(f.sleeps, [5000]);
    assert.equal(f.runs.length, 0);
    assert.match(f.errors.join('\n'), /"status":"completed","conclusion":"cancelled"/);
  });

  test(`${caller} does not treat HTTP 403 as startup visibility`, {timeout: 5000}, async t => {
    const f = fixture(t);
    if (entry === '../guard/index') process.env.GITHUB_RUN_ID = '100';
    f.beforeRequest = request => {
      if (request.route === '/actions/runs/7') return new Response('', {status: 403});
    };
    assert.equal(await f.run(entry), 1);
    assert.deepEqual(f.sleeps, []);
    assert.equal(f.runs.length, 0);
    assert.match(f.errors.join('\n'), /HTTP 403 after 1 attempt/);
  });
}

for (const status of ['queued', 'requested', 'pending', 'HTTP 404']) {
  test(`confirmed parent ${status} stops without renewed startup grace`, {timeout: 5000}, async t => {
    const f = fixture(t);
    f.beforeRequest = request => {
      if (request.route !== '/actions/runs/7' || !f.runs.length) return;
      return status === 'HTTP 404' ? new Response('', {status: 404}) :
        Response.json({...f.parent, status});
    };
    assert.equal(await f.run(), 1);
    assert.deepEqual(f.sleeps, [15000]);
    assert.deepEqual(f.events, ['dispatch:100', 'cancel:100', 'completed:100:cancelled']);
    assert.ok(f.logs.every(line => !line.includes('startup visibility')));
    assert.equal(f.state(), null);
  });
}

test('fallback candidates do not renew parent startup grace', {timeout: 5000}, async t => {
  const f = fixture(t);
  f.onCancel = run => {
    f.finish(run, 'cancelled');
    f.parent.status = 'queued';
  };
  assert.equal(await f.run(), 1);
  assert.deepEqual(f.events, ['dispatch:100', 'cancel:100', 'completed:100:cancelled']);
  assert.match(f.errors.join('\n'), /Parent run is no longer active.*"status":"queued"/);
  assert.ok(f.logs.every(line => !line.includes('startup visibility')));
  assert.equal(f.state(), null);
});

for (const delay of ['retry-after', 'late response']) {
  test(`parent startup deadline includes ${delay}`, {timeout: 5000}, async t => {
    const f = fixture(t);
    const started = f.now;
    let delayedReads = 0;
    f.beforeRequest = request => {
      if (request.route !== '/actions/runs/7') return;
      if (f.now - started < 115000) return Response.json({...f.parent, status: 'queued'});
      delayedReads++;
      if (delay === 'retry-after') {
        return new Response('', {status: 429, headers: {'retry-after': '60'}});
      }
      f.now += 6000;
      return Response.json(f.parent);
    };
    assert.equal(await f.run(), 1);
    assert.equal(f.now - started, delay === 'retry-after' ? 115000 : 121000);
    assert.equal(delayedReads, 1);
    assert.equal(f.runs.length, 0);
    assert.match(f.errors.join('\n'), /Parent 7: active check failed.*expected.*last observation/);
    assert.match(f.errors.join('\n'), /GitHub GET .*\/actions\/runs\/7: request deadline exhausted/);
    assert.ok(f.sleeps.every(wait => wait === 5000));
  });
}

const expectedDefaults = {
  'gpu-amd64': [
    {group: 'nv-gpu-amd64-rtxpro6000-1gpu', labels: 'linux-amd64-gpu-rtxpro6000-latest-1'},
    {group: 'nv-gpu-amd64-h100-1gpu', labels: 'linux-amd64-gpu-h100-latest-1'},
    {group: 'nv-gpu-amd64-h200-1gpu', labels: 'linux-amd64-gpu-h200-latest-1'},
    {group: 'nv-gpu-amd64-a100-1gpu', labels: 'linux-amd64-gpu-a100-latest-1'},
    {group: 'nv-gpu-amd64-l40g-1gpu', labels: 'linux-amd64-gpu-l40g-latest-1'},
    {group: 'nv-gpu-general', labels: 'linux-amd64-gpu-l4-latest-1'},
  ],
  'gpu-arm64': ['gb300', 'gh200', 'a100', 'l4'].map(gpu => ({
    group: `nv-gpu-arm64-${gpu}-1gpu`, labels: `linux-arm64-gpu-${gpu}-latest-1`,
  })),
  'gpu-amd64-2gpu': ['rtxpro6000', 'h100', 'h200'].map(gpu => ({
    group: `nv-gpu-amd64-${gpu}-2gpu`, labels: `linux-amd64-gpu-${gpu}-latest-2`,
  })),
  'gpu-arm64-2gpu': [
    {group: 'nv-gpu-arm64-l4-2gpu', labels: 'linux-arm64-gpu-l4-latest-2'},
  ],
  'cpu-amd64': [16, 8, 32].map(size => ({group: 'nv-cpu-general', labels: `linux-amd64-cpu${size}`})),
  'cpu-arm64': [16, 8, 32].map(size => ({group: 'nv-cpu-general', labels: `linux-arm64-cpu${size}`})),
};
const expectedExtendedDefaults = structuredClone(expectedDefaults);
for (const [profile, label] of Object.entries({
  'cpu-amd64': 'linux-amd64-cpu32',
  'cpu-arm64': 'linux-arm64-cpu32',
  'gpu-amd64': 'linux-amd64-gpu-rtxpro6000-latest-1',
  'gpu-amd64-2gpu': 'linux-amd64-gpu-rtxpro6000-latest-2',
})) {
  expectedExtendedDefaults[profile].push(expectedDefaults[profile].find(runner => runner.labels === label));
}
for (const [type, runners] of Object.entries(expectedDefaults)) {
  test(`${type} defaults exhaust in order without architecture or GPU-count downgrade`, {timeout: 5000}, async t => {
    const f = fixture(t);
    process.env['INPUT_RUNNER-TYPE'] = type;
    delete process.env.INPUT_RUNNERS;
    assert.equal(await f.run(), 1);
    assert.deepEqual(f.runs.map(run => JSON.parse(run.payload.inputs.runner)), runners);
    assert.ok(f.runs.every(run => run.conclusion === 'cancelled'));
    assert.equal(f.outputs().attempts, String(runners.length));
    assert.match(f.errors.join('\n'), /All runner candidates exhausted/);
    assert.ok(f.logs.some(line => line.startsWith(`Using shared defaults for ${type}:`)));
    assert.equal(f.state(), null);
  });
}

for (const type of ['cpu', 'gpu']) {
  test(`${type} selects the amd64 defaults`, {timeout: 5000}, async t => {
    const f = fixture(t);
    process.env['INPUT_RUNNER-TYPE'] = type;
    delete process.env.INPUT_RUNNERS;
    assert.equal(await f.run(), 1);
    assert.deepEqual(f.runs.map(run => JSON.parse(run.payload.inputs.runner)), expectedDefaults[`${type}-amd64`]);
    assert.equal(f.state(), null);
  });
}

for (const type of [undefined, '', ' \n\t', 'gpu-unknown', 'gpu-amd64-4gpu', 'toString']) {
  for (const override of [false, true]) {
    test(`reject runner-type ${JSON.stringify(type)} with override=${override} before dispatch`, {timeout: 5000}, async t => {
      const f = fixture(t);
      if (type === undefined) delete process.env['INPUT_RUNNER-TYPE'];
      else process.env['INPUT_RUNNER-TYPE'] = type;
      if (!override) delete process.env.INPUT_RUNNERS;
      assert.equal(await f.run(), 1);
      assert.equal(f.requests.length, 0);
      assert.match(f.errors.join('\n'), /runner-type/);
    });
  }
}

for (const type of ['cpu-amd64', 'gpu-arm64', 'gpu-amd64-2gpu']) {
  test(`reject single-GPU amd64 override for ${type}`, {timeout: 5000}, async t => {
    const f = fixture(t);
    process.env['INPUT_RUNNER-TYPE'] = type;
    assert.equal(await f.run(), 1);
    assert.equal(f.requests.length, 0);
    assert.match(f.errors.join('\n'), /runners must match runner-type/);
  });
}

test('explicit two-GPU override retains the requested count and order', {timeout: 5000}, async t => {
  const runners = expectedDefaults['gpu-amd64-2gpu'].slice().reverse();
  const f = fixture(t, runners);
  f.onDispatch = run => { if (run.id === 102) f.finish(run, 'success'); };
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.runs.map(run => JSON.parse(run.payload.inputs.runner)), runners);
  assert.equal(f.state(), null);
});

for (const value of ['', ' \n\t']) {
  test(`blank runners ${JSON.stringify(value)} use the default primary pool`, {timeout: 5000}, async t => {
    const f = fixture(t);
    process.env.INPUT_RUNNERS = value;
    f.onDispatch = run => f.finish(run, 'success');
    assert.equal(await f.run(), 0);
    assert.equal(f.runs.length, 1);
    assert.deepEqual(JSON.parse(f.outputs().runner), gpuRunners[0]);
  });
}

test('explicit GPU runners replace defaults without adding more pools', {timeout: 5000}, async t => {
  const runners = [gpuRunners[2], gpuRunners[1]];
  const f = fixture(t, runners);
  assert.equal(await f.run(), 1);
  assert.deepEqual(f.runs.map(run => JSON.parse(run.payload.inputs.runner)), runners);
  assert.ok(f.runs.every(run => run.conclusion === 'cancelled'));
  assert.ok(!f.logs.some(line => line.startsWith('Using shared defaults')));
  assert.equal(f.state(), null);
});

test('malformed runners do not silently select default pools', {timeout: 5000}, async t => {
  const f = fixture(t);
  process.env.INPUT_RUNNERS = 'invalid-json';
  assert.equal(await f.run(), 1);
  assert.equal(f.requests.length, 0);
});

for (const [kind, runners] of [['GPU', gpuRunners], ['CPU', cpuRunners]]) {
  test(`${kind} child metadata is first read after the initial fifteen-second delay`, {timeout: 5000}, async t => {
    const f = fixture(t, runners);
    const started = f.now;
    f.onDispatch = run => f.finish(run, 'success');
    assert.equal(await f.run(), 0);
    assert.deepEqual(f.sleeps, [15000]);
    const reads = f.requests.filter(request => request.route.startsWith('/actions/runs/100'));
    assert.equal(reads.length, 2);
    assert.ok(reads.every(request => request.at === started + 15000));
    assert.ok(f.logs.includes('Child 100: first metadata poll in 15s (within the 120s startup window)'));
    assert.ok(f.logs.includes('Poll #1: child 100; elapsed 15s; run completed/success; worker success; polling finished'));
    assert.equal(f.runs.length, 1);
    assert.equal(f.state(), null);
  });
}

for (const status of ['queued', 'in_progress']) {
  test(`${status} rounds log progress and poll every sixty seconds`, {timeout: 5000}, async t => {
    const f = fixture(t);
    process.env['INPUT_QUEUE-TIMEOUT-MINUTES'] = '5';
    process.env['INPUT_EXECUTION-TIMEOUT-MINUTES'] = '5';
    const started = f.now;
    f.onDispatch = run => {
      if (status === 'in_progress') {
        f.acquire(run);
        run.status = run.job.status = status;
      }
    };
    let rounds = 0;
    f.onSleep = milliseconds => {
      if (milliseconds === 60000 && ++rounds === 2) f.finish(f.runs[0], 'success');
    };
    assert.equal(await f.run(), 0);
    assert.deepEqual(f.sleeps, [15000, 60000, 60000]);
    assert.deepEqual(f.requests.filter(request => request.route === '/actions/runs/100')
      .map(request => request.at - started), [15000, 75000, 135000]);
    assert.deepEqual(f.logs.filter(message => message.startsWith('Poll #')), [
      `Poll #1: child 100; elapsed 15s; run ${status}; worker ${status}; next poll in 60s (1 minute)`,
      `Poll #2: child 100; elapsed 75s; run ${status}; worker ${status}; next poll in 60s (1 minute)`,
      'Poll #3: child 100; elapsed 135s; run completed/success; worker success; polling finished',
    ]);
    assert.deepEqual(f.events, ['dispatch:100', 'completed:100:success']);
    assert.equal(f.state(), null);
  });
}

test('fallback waits for cancellation completion before dispatching the next pool', {timeout: 5000}, async t => {
  const f = fixture(t);
  let cancelAt;
  f.onDispatch = run => { if (run.id === 101) f.finish(run, 'success'); };
  f.onCancel = () => { cancelAt = f.now; };
  f.onSleep = () => {
    if (cancelAt && f.runs[0].status !== 'completed' && f.now - cancelAt >= 10000) {
      f.finish(f.runs[0], 'cancelled');
    }
  };
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.events, ['dispatch:100', 'cancel:100', 'completed:100:cancelled',
    'dispatch:101', 'completed:101:success']);
  assert.deepEqual(JSON.parse(f.runs[1].payload.inputs.runner), gpuRunners[1]);
  assert.equal(f.outputs().attempts, '2');
  assert.equal(f.state(), null);
});

for (const entity of ['run', 'job']) {
  for (const field of ['status', 'conclusion']) {
    test(`cancellation waits for delayed ${entity} ${field}`, {timeout: 5000}, async t => {
      const f = fixture(t);
      let cancelAt;
      f.onDispatch = run => { if (run.id === 101) f.finish(run, 'success'); };
      f.onCancel = run => {
        cancelAt = f.now;
        run.status = run.job.status = 'completed';
        run.conclusion = run.job.conclusion = 'cancelled';
        (entity === 'run' ? run : run.job)[field] = field === 'status' ? 'queued' : null;
      };
      f.onSleep = () => {
        if (cancelAt && f.now - cancelAt >= 10000 && f.runs.length === 1) {
          f.finish(f.runs[0], 'cancelled');
        }
      };
      assert.equal(await f.run(), 0);
      assert.deepEqual(f.events, ['dispatch:100', 'cancel:100', 'completed:100:cancelled',
        'dispatch:101', 'completed:101:success']);
      assert.ok(f.requests.find(request => request.method === 'POST' &&
        request.route.endsWith('/dispatches') && request.at > cancelAt).at >= cancelAt + 10000);
      assert.ok(f.logs.some(message => message.includes('Cancel confirmation: child 100') &&
        message.includes('next poll in 5s')));
      assert.ok(f.logs.some(message => message.includes('cancellation confirmed; polling finished')));
      assert.equal(f.state(), null);
    });
  }
}

test('cancellation metadata gets a final observation at the deadline', {timeout: 5000}, async t => {
  const f = fixture(t);
  let cancelAt;
  f.onDispatch = run => { if (run.id === 101) f.finish(run, 'success'); };
  f.onCancel = run => {
    cancelAt = f.now;
    run.status = run.job.status = 'completed';
    run.conclusion = 'cancelled';
    run.job.conclusion = null;
  };
  f.onSleep = () => {
    if (cancelAt && f.runs.length === 1 && f.now - cancelAt >= 120000) {
      f.finish(f.runs[0], 'cancelled');
    }
  };
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.events, ['dispatch:100', 'cancel:100', 'completed:100:cancelled',
    'dispatch:101', 'completed:101:success']);
  assert.ok(f.logs.some(message => message.includes('elapsed 120s/120s') &&
    message.includes('cancellation confirmed; polling finished')));
  assert.equal(f.state(), null);
});

test('cancellation metadata expiry fails with states and never dispatches another worker', {timeout: 5000}, async t => {
  const f = fixture(t);
  let cancelAt;
  f.onCancel = run => {
    cancelAt = f.now;
    run.status = run.job.status = 'completed';
    run.conclusion = 'cancelled';
    run.job.conclusion = null;
  };
  assert.equal(await f.run(), 1);
  assert.equal(f.now - cancelAt, 120000);
  assert.equal(f.runs.length, 1);
  assert.equal(f.events.filter(event => event.startsWith('cancel:')).length, 1);
  assert.match(f.errors.join('\n'), /Cancellation unconfirmed.*run completed\/cancelled.*worker completed\/pending/);
  assert.ok(f.logs.some(message => message.includes('next poll in 5s')));
  assert.equal(f.state(), null);
});

for (const delay of ['retry-after', 'late response']) {
  test(`cancellation deadline includes ${delay}`, {timeout: 5000}, async t => {
    const f = fixture(t);
    let cancelAt;
    let delayedReads = 0;
    f.onCancel = run => {
      cancelAt = f.now;
      run.status = 'completed';
      run.conclusion = 'cancelled';
    };
    f.beforeRequest = request => {
      if (cancelAt && f.now - cancelAt >= 115000 && request.route.endsWith('/jobs')) {
        delayedReads++;
        if (delay === 'retry-after') {
          return new Response('{}', {status: 429, headers: {'retry-after': '60'}});
        }
        f.now += 6000;
        f.finish(f.runs[0], 'cancelled');
        return new Response(JSON.stringify({total_count: 1, jobs: [f.runs[0].job]}), {status: 200});
      }
    };
    assert.equal(await f.run(), 1);
    assert.equal(f.now - cancelAt, delay === 'retry-after' ? 115000 : 121000);
    assert.equal(delayedReads, 1);
    assert.equal(f.runs.length, 1);
    assert.equal(f.events.filter(event => event.startsWith('cancel:')).length, 1);
    assert.match(f.errors.join('\n'), /Cancellation unconfirmed.*run completed\/cancelled.*worker queued\/pending/);
    assert.match(f.errors.join('\n'), /GitHub GET .*\/jobs.*request deadline exhausted/);
    assert.equal(f.state(), null);
  });
}

test('execution detected while waiting for cancellation metadata stops fallback', {timeout: 5000}, async t => {
  const f = fixture(t);
  let cancelAt;
  f.onCancel = run => {
    cancelAt = f.now;
    run.status = 'completed';
    run.conclusion = 'cancelled';
  };
  f.onSleep = () => {
    if (cancelAt) {
      f.acquire(f.runs[0]);
      f.finish(f.runs[0], 'cancelled');
    }
  };
  assert.equal(await f.run(), 1);
  assert.equal(f.now - cancelAt, 5000);
  assert.equal(f.runs.length, 1);
  assert.match(f.errors.join('\n'), /Queue cancellation raced execution.*runner_id=123/);
  assert.equal(f.state(), null);
});

for (const entity of ['run', 'job']) {
  test(`non-cancellation terminal ${entity} result stops fallback immediately`, {timeout: 5000}, async t => {
    const f = fixture(t);
    f.onCancel = run => {
      run.status = run.job.status = 'completed';
      run.conclusion = run.job.conclusion = 'cancelled';
      (entity === 'run' ? run : run.job).conclusion = 'failure';
    };
    assert.equal(await f.run(), 1);
    assert.equal(f.runs.length, 1);
    assert.match(f.errors.join('\n'), /Queue cancellation ended with a non-cancelled result.*failure/);
    assert.ok(!f.sleeps.includes(5000));
    assert.equal(f.state(), null);
  });
}

test('identity drift during cancellation confirmation fails without renewed grace', {timeout: 5000}, async t => {
  const f = fixture(t);
  let cancelAt;
  f.onCancel = run => {
    cancelAt = f.now;
    run.status = 'completed';
    run.conclusion = 'cancelled';
  };
  f.onSleep = () => { if (cancelAt) f.runs[0].head_sha = 'c'.repeat(40); };
  assert.equal(await f.run(), 1);
  assert.equal(f.now - cancelAt, 5000);
  assert.equal(f.runs.length, 1);
  assert.match(f.errors.join('\n'), /identity mismatch.*head_sha/);
  assert.equal(f.state(), null);
});

test('queue exhaustion cancels all three attempts and fails', {timeout: 5000}, async t => {
  const f = fixture(t);
  assert.equal(await f.run(), 1);
  assert.equal(f.runs.length, 3);
  assert.ok(f.runs.every(run => run.conclusion === 'cancelled'));
  assert.match(f.errors.join('\n'), /All runner candidates exhausted/);
  assert.equal(f.state(), null);
});

test('acquisition during cancellation stops fallback', {timeout: 5000}, async t => {
  const f = fixture(t);
  f.onCancel = run => {
    f.acquire(run);
    f.finish(run, 'cancelled');
  };
  assert.equal(await f.run(), 1);
  assert.equal(f.runs.length, 1);
  assert.match(f.errors.join('\n'), /cancellation raced execution/);
  assert.equal(f.state(), null);
});

for (const result of ['failure', 'skipped']) {
  test(`workload ${result} cannot pass or trigger fallback`, {timeout: 5000}, async t => {
    const f = fixture(t);
    f.onDispatch = run => f.finish(run, result);
    assert.equal(await f.run(), 1);
    assert.equal(f.runs.length, 1);
    assert.equal(f.events.filter(event => event.startsWith('cancel:')).length, 0);
    assert.match(f.errors.join('\n'), /no workload retry/);
    assert.equal(f.logs.at(-1),
      'View worker job logs here: https://example.invalid/example/consumer/actions/runs/100/job/1000');
    assert.match(fs.readFileSync(process.env.GITHUB_STEP_SUMMARY, 'utf8'),
      /failed: Worker 100:.*\[View worker job logs here\]\(https:\/\/example\.invalid\/example\/consumer\/actions\/runs\/100\/job\/1000\)/);
  });
}

for (const hasJobId of [true, false]) {
  test(`failure without job html_url: ${hasJobId ? 'use job ID' : 'label run fallback'}`, {timeout: 5000}, async t => {
    const f = fixture(t);
    f.onDispatch = run => {
      delete run.job.html_url;
      if (!hasJobId) delete run.job.id;
      f.finish(run, 'failure');
    };
    assert.equal(await f.run(), 1);
    const url = 'https://example.invalid/example/consumer/actions/runs/100';
    assert.equal(f.logs.at(-1), hasJobId
      ? `View worker job logs here: ${url}/job/1000`
      : `Job link unavailable; view worker run here: ${url}`);
    assert.match(f.errors.join('\n'), /Worker 100: failure; no workload retry/);
    assert.equal(f.runs.length, 1);
    assert.equal(f.state(), null);
  });
}

test('execution timeout cancels the acquired runner without fallback', {timeout: 5000}, async t => {
  const f = fixture(t);
  f.onDispatch = run => {
    f.acquire(run);
    run.status = run.job.status = 'in_progress';
  };
  assert.equal(await f.run(), 1);
  assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0].conclusion, 'cancelled');
  assert.match(f.errors.join('\n'), /execution timeout; no fallback/);
  assert.equal(f.logs.at(-1),
    'View worker job logs here: https://example.invalid/example/consumer/actions/runs/100/job/1000');
});

test('unconfirmed cancellation preserves cleanup state and never dispatches again', {timeout: 5000}, async t => {
  const f = fixture(t);
  f.onCancel = () => {};
  assert.equal(await f.run(), 1);
  assert.equal(f.runs.length, 1);
  assert.equal(f.state().id, 100);
  assert.match(f.errors.join('\n'), /Cancellation unconfirmed/);
  assert.equal(f.logs.at(-1),
    'View worker job logs here: https://example.invalid/example/consumer/actions/runs/100/job/1000');
});

test('lost dispatch response is recovered by request identity, not retried', {timeout: 5000}, async t => {
  const f = fixture(t);
  f.onDispatch = () => { throw new Error('Lost dispatch response'); };
  assert.equal(await f.run(), 1);
  assert.deepEqual(f.events, ['dispatch:100', 'cancel:100', 'completed:100:cancelled']);
  assert.match(f.errors.join('\n'), /Lost dispatch response/);
  assert.equal(f.state(), null);
});

for (const reason of ['parent cancellation', 'source change']) {
  test(`${reason} stops dispatch and cleans the queued child`, {timeout: 5000}, async t => {
    const f = fixture(t);
    f.onSleep = () => {
      if (reason === 'parent cancellation') f.parent.status = 'completed';
      else f.source = 'c'.repeat(40);
    };
    assert.equal(await f.run(), 1);
    assert.equal(f.runs.length, 1);
    assert.equal(f.runs[0].conclusion, 'cancelled');
    assert.match(f.errors.join('\n'), /Parent run is no longer active|Source ref changed/);
    assert.equal(f.state(), null);
  });
}

function trustedCacheFixture(t) {
  const f = fixture(t, cpuRunners);
  process.env['INPUT_SOURCE-POLICY'] = 'pinned-after-start';
  process.env['INPUT_SOURCE-REF'] = 'refs/heads/main';
  return f;
}

for (const policy of [undefined, '', 'current']) {
  test(`source policy ${policy ?? 'omitted'} still cancels an allocated worker`, {timeout: 5000}, async t => {
    const f = fixture(t);
    if (policy === undefined) delete process.env['INPUT_SOURCE-POLICY'];
    else process.env['INPUT_SOURCE-POLICY'] = policy;
    f.onDispatch = run => {
      f.acquire(run);
      run.status = run.job.status = 'in_progress';
    };
    f.onSleep = () => { f.source = 'c'.repeat(40); };
    assert.equal(await f.run(), 1);
    assert.deepEqual(f.events, ['dispatch:100', 'cancel:100', 'completed:100:cancelled']);
    assert.match(f.errors.join('\n'), /Source ref changed/);
    assert.equal(f.state(), null);
  });
}

test('invalid source policy fails before any API request', {timeout: 5000}, async t => {
  const f = fixture(t);
  process.env['INPUT_SOURCE-POLICY'] = 'pinned';
  assert.equal(await f.run(), 1);
  assert.match(f.errors.join('\n'), /source-policy must be current or pinned-after-start/);
  assert.equal(f.requests.length, 0);
});

for (const timing of ['before first poll', 'after first poll', 'completed before first poll', 'terminal check']) {
  test(`trusted worker keeps its SHA when source changes ${timing}`, {timeout: 5000}, async t => {
    const f = trustedCacheFixture(t);
    f.onDispatch = run => {
      f.acquire(run);
      run.status = run.job.status = 'in_progress';
      if (timing === 'completed before first poll' || timing === 'terminal check') {
        f.finish(run, 'success');
      }
    };
    let parentReads = 0;
    f.beforeRequest = request => {
      if (request.route === '/actions/runs/7' && ++parentReads === 3 && timing === 'terminal check') {
        f.source = 'c'.repeat(40);
      }
    };
    f.onSleep = milliseconds => {
      if (milliseconds === 15000 && ['before first poll', 'completed before first poll'].includes(timing)) {
        f.source = 'c'.repeat(40);
      }
      if (milliseconds === 60000) {
        f.source = 'c'.repeat(40);
        f.finish(f.runs[0], 'success');
      }
    };
    assert.equal(await f.run(), 0);
    assert.equal(f.source, 'c'.repeat(40));
    assert.deepEqual(f.events, ['dispatch:100', 'completed:100:success']);
    assert.equal(f.runs[0].payload.inputs['source-sha'], sourceSha);
    assert.equal(f.runs[0].payload.inputs['source-policy'], undefined);
    assert.ok(f.logs.some(message => message.includes(`Source pinned to ${sourceSha}`)));
    assert.equal(f.errors.length, 0);
    assert.equal(f.state(), null);
  });
}

test('default policy still rejects a source change during its final check', {timeout: 5000}, async t => {
  const f = fixture(t);
  f.onDispatch = run => f.finish(run, 'success');
  let parentReads = 0;
  f.beforeRequest = request => {
    if (request.route === '/actions/runs/7' && ++parentReads === 3) f.source = 'c'.repeat(40);
  };
  assert.equal(await f.run(), 1);
  assert.match(f.errors.join('\n'), /Source ref changed/);
  assert.equal(f.runs.length, 1);
  assert.equal(f.state(), null);
});

test('workload data cannot opt into the trusted source policy', {timeout: 5000}, async t => {
  const f = fixture(t);
  process.env.INPUT_WORKLOAD = JSON.stringify({'source-policy': 'pinned-after-start'});
  f.onDispatch = run => {
    f.acquire(run);
    run.status = run.job.status = 'in_progress';
  };
  f.onSleep = () => { f.source = 'c'.repeat(40); };
  assert.equal(await f.run(), 1);
  assert.match(f.errors.join('\n'), /Source ref changed/);
  assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0].conclusion, 'cancelled');
});

test('trusted completion still checks parent cancellation', {timeout: 5000}, async t => {
  const f = trustedCacheFixture(t);
  f.onDispatch = run => f.finish(run, 'success');
  let parentReads = 0;
  f.beforeRequest = request => {
    if (request.route === '/actions/runs/7' && ++parentReads === 3) f.parent.status = 'completed';
  };
  assert.equal(await f.run(), 1);
  assert.match(f.errors.join('\n'), /Parent run is no longer active/);
  assert.equal(f.runs.length, 1);
  assert.equal(f.state(), null);
});

test('trusted source must still be current before dispatch', {timeout: 5000}, async t => {
  const f = trustedCacheFixture(t);
  f.source = 'c'.repeat(40);
  assert.equal(await f.run(), 1);
  assert.match(f.errors.join('\n'), /Source ref changed/);
  assert.equal(f.runs.length, 0);
});

for (const pending of [false, true]) {
  test(`trusted source change cancels ${pending ? 'unconfirmed metadata' : 'queued worker'}`, {timeout: 5000}, async t => {
    const f = trustedCacheFixture(t);
    f.onDispatch = run => {
      if (pending) run.display_title = 'not-visible-yet';
    };
    f.onSleep = () => { f.source = 'c'.repeat(40); };
    assert.equal(await f.run(), 1);
    assert.match(f.errors.join('\n'), /Source ref changed/);
    assert.deepEqual(f.events, ['dispatch:100', 'cancel:100', 'completed:100:cancelled']);
    assert.equal(f.state(), null);
  });
}

test('trusted source is checked again before dispatching a fallback candidate', {timeout: 5000}, async t => {
  const f = trustedCacheFixture(t);
  f.onCancel = run => {
    f.finish(run, 'cancelled');
    f.source = 'c'.repeat(40);
  };
  assert.equal(await f.run(), 1);
  assert.match(f.errors.join('\n'), /Source ref changed/);
  assert.equal(f.runs.length, 1);
  assert.equal(f.state(), null);
});

test('trusted policy still checks the workflow definition before fallback', {timeout: 5000}, async t => {
  const f = trustedCacheFixture(t);
  let workflowChanged = false;
  f.onCancel = run => {
    f.finish(run, 'cancelled');
    workflowChanged = true;
  };
  f.beforeRequest = request => {
    if (workflowChanged && request.route === '/commits/main') {
      return new Response(JSON.stringify({sha: 'c'.repeat(40)}), {status: 200});
    }
  };
  assert.equal(await f.run(), 1);
  assert.match(f.errors.join('\n'), /Trusted workflow ref changed/);
  assert.equal(f.runs.length, 1);
  assert.equal(f.state(), null);
});

for (const reason of ['parent cancellation', 'parent attempt', 'identity change', 'execution timeout', 'workload failure', 'API failure']) {
  test(`trusted active worker still stops for ${reason}`, {timeout: 5000}, async t => {
    const f = trustedCacheFixture(t);
    f.onDispatch = run => {
      f.acquire(run);
      run.status = run.job.status = 'in_progress';
    };
    f.onSleep = milliseconds => {
      if (milliseconds !== 60000) return;
      f.source = 'c'.repeat(40);
      if (reason === 'parent cancellation') f.parent.status = 'completed';
      if (reason === 'parent attempt') f.parent.run_attempt = 2;
      if (reason === 'identity change') f.runs[0].display_title = 'different-request';
      if (reason === 'workload failure') f.finish(f.runs[0], 'failure');
    };
    f.beforeRequest = request => {
      if (reason === 'API failure' && f.source !== sourceSha && request.route === '/actions/runs/7') {
        return new Response('', {status: 403});
      }
    };
    assert.equal(await f.run(), 1);
    assert.equal(f.runs.length, 1);
    assert.equal(f.runs[0].conclusion, reason === 'workload failure' ? 'failure' : 'cancelled');
    const expected = {
      'parent cancellation': /Parent run is no longer active/,
      'parent attempt': /Parent run is no longer active/,
      'identity change': /identity mismatch/,
      'execution timeout': /execution timeout; no fallback/,
      'workload failure': /failure; no workload retry/,
      'API failure': /HTTP 403/,
    };
    assert.match(f.errors.join('\n'), expected[reason]);
    assert.equal(f.state(), null);
  });
}

test('trusted worker startup guard still rejects a stale SHA', {timeout: 5000}, async t => {
  const f = trustedCacheFixture(t);
  process.env.GITHUB_RUN_ID = '100';
  f.source = 'c'.repeat(40);
  assert.equal(await f.run('../guard/index'), 1);
  assert.match(f.errors.join('\n'), /Source ref changed/);
  assert.equal(f.runs.length, 0);
});

test('post entry point cleans its own state without cancelling a parallel worker', {timeout: 5000}, async t => {
  const f = fixture(t);
  const lib = require('../lib');
  const active = {id: 100, request: 'runner-7-1-interrupted'};
  f.runs.push(
    {id: 100, status: 'queued', job: {status: 'queued'}},
    {id: 101, display_title: 'runner-7-1-another-invocation', status: 'in_progress',
      job: {status: 'in_progress', runner_id: 456}},
  );
  lib.save(active);
  process.env.STATE_active = JSON.stringify(f.state());
  assert.equal(await f.run('../cleanup'), 0);
  assert.deepEqual(f.events, ['cancel:100', 'completed:100:cancelled']);
  assert.equal(f.runs[1].status, 'in_progress');
});

test('invocations sharing a parent run have different request identities', {timeout: 5000}, async t => {
  const f = fixture(t);
  f.onDispatch = run => f.finish(run, 'success');
  assert.equal(await f.run(), 0);
  assert.equal(await f.run(), 0);
  assert.equal(f.runs.length, 2);
  const requests = f.runs.map(run => run.payload.inputs['request-id']);
  assert.ok(requests.every(request => request.startsWith('runner-7-1-')));
  assert.notEqual(requests[0], requests[1]);
  assert.ok(!f.events.some(event => event.startsWith('cancel:')));
});

test('post cleanup with unknown run ID cancels only the matching request', {timeout: 5000}, async t => {
  const f = fixture(t);
  const active = {workflow: 'runner-worker.yml', request: 'runner-7-1-lost', created: new Date(f.now).toISOString()};
  f.runs.push(
    {id: 100, display_title: 'runner-7-1-unrelated', status: 'queued', job: {status: 'queued'}},
    {id: 101, display_title: active.request, status: 'queued', job: {status: 'queued'}},
  );
  require('../lib').save(active);
  process.env.STATE_active = JSON.stringify(f.state());
  assert.equal(await f.run('../cleanup'), 0);
  assert.equal(f.runs[0].status, 'queued');
  assert.deepEqual(f.events, ['cancel:101', 'completed:101:cancelled']);
});

test('GET rate limiting backs off while keeping dispatch single-shot', {timeout: 5000}, async t => {
  const f = fixture(t);
  let limited = false;
  const started = f.now;
  f.beforeRequest = request => {
    if (request.route === '/actions/runs/7' && !limited) {
      limited = true;
      return new Response('', {status: 429, headers: {'retry-after': '1'}});
    }
  };
  f.onDispatch = run => f.finish(run, 'success');
  assert.equal(await f.run(), 0);
  assert.equal(f.now - started, 1000 + 15000);
  assert.equal(f.runs.length, 1);
});

for (const delay of ['identity', 'run 404', 'jobs 404', 'empty jobs']) {
  test(`startup metadata recovers: ${delay}`, {timeout: 5000}, async t => {
    const f = fixture(t);
    const started = f.now;
    f.onDispatch = run => f.finish(run, 'success');
    f.beforeRequest = request => {
      if (f.now - started >= 20000) return;
      if (request.route === '/actions/runs/100') {
        if (delay === 'run 404') return new Response('', {status: 404});
        if (delay === 'identity') {
          return Response.json({...f.runs[0], display_title: ''});
        }
      }
      if (request.route === '/actions/runs/100/attempts/1/jobs') {
        if (delay === 'jobs 404') return new Response('', {status: 404});
        if (delay === 'empty jobs') return Response.json({total_count: 0, jobs: []});
      }
    };
    assert.equal(await f.run(), 0);
    assert.equal(f.now - started, 20000);
    assert.deepEqual(f.events, ['dispatch:100', 'completed:100:success']);
    const pending = f.logs.filter(message => message.includes('metadata pending'));
    assert.equal(pending.length, 1);
    assert.match(pending[0], /^Poll #1: child 100; elapsed 15s; metadata pending/);
    assert.match(pending[0], /next poll in 5s$/);
    assert.deepEqual(f.sleeps, [15000, 5000]);
    assert.equal(f.errors.length, 0);
    assert.equal(f.state(), null);
  });
}

for (const missing of ['identity', 'jobs']) {
  test(`startup deadline cleans up without fallback: ${missing}`, {timeout: 5000}, async t => {
    const f = fixture(t);
    const started = f.now;
    if (missing === 'identity') f.onDispatch = run => { run.display_title = 'not-ready'; };
    else f.beforeRequest = request => {
      if (request.route === '/actions/runs/100/attempts/1/jobs') {
        return Response.json({total_count: 0, jobs: []});
      }
    };
    assert.equal(await f.run(), 1);
    assert.equal(f.now - started, 120000);
    assert.deepEqual(f.events, ['dispatch:100', 'cancel:100', 'completed:100:cancelled']);
    assert.match(f.errors.join('\n'), /120s startup window; last observation:/);
    const summary = fs.readFileSync(process.env.GITHUB_STEP_SUMMARY, 'utf8');
    assert.match(summary, /failed: Worker metadata/);
    assert.match(summary, /cleanup confirmed; child is no longer running/);
    assert.match(summary, /actions\/runs\/100/);
    if (missing === 'identity') {
      assert.match(summary, /"field":"display_title"/);
      assert.ok(summary.includes(`"expected":"${f.runs[0].payload.inputs['request-id']}"`));
      assert.match(summary, /"actual":"not-ready"/);
    } else assert.match(summary, /worker job is not visible/);
    assert.equal(f.state(), null);
  });
}

for (const [field, value] of Object.entries({
  run_attempt: 2, event: 'push', head_sha: 'c'.repeat(40), display_title: 'changed',
})) {
  test(`confirmed identity changes fail immediately: ${field}`, {timeout: 5000}, async t => {
    const f = fixture(t);
    const started = f.now;
    f.onSleep = milliseconds => {
      if (milliseconds === 60000) f.runs[0][field] = value;
    };
    assert.equal(await f.run(), 1);
    assert.equal(f.now - started, 15000 + 60000);
    assert.deepEqual(f.events, ['dispatch:100', 'cancel:100', 'completed:100:cancelled']);
    assert.match(f.errors.join('\n'), /identity mismatch/);
    assert.ok(f.errors.some(message => message.includes(`"field":"${field}"`)));
    assert.ok(f.logs.every(message => !message.includes('metadata pending')));
    assert.equal(f.state(), null);
  });
}

for (const method of ['GET', 'POST']) {
  for (const failure of ['network', 'HTTP 503', 'malformed JSON']) {
    for (const recover of [true, false]) {
      test(`${method === 'GET' ? 'read' : 'cancel'} ${failure}: ${recover ? 'recovers' : 'exhausts retries'}`,
        {timeout: 5000}, async t => {
          const f = fixture(t);
          const started = f.now;
          const route = method === 'GET' ? '/actions/runs/7' : '/actions/runs/100/cancel';
          if (method === 'POST') f.runs.push({id: 100, status: 'queued', job: {status: 'queued'}});
          let calls = 0;
          f.beforeRequest = request => {
            if (request.route !== route || request.method !== method) return;
            calls++;
            if (recover && calls === 3) return;
            if (failure === 'network') throw new TypeError('temporary connection failure');
            if (failure === 'malformed JSON') return new Response('{', {status: 200});
            return new Response('', {status: 503, headers: {'x-github-request-id': 'request-123'}});
          };
          const api = require('../lib').client();
          if (recover) {
            const result = await api(route, method);
            assert.deepEqual(result, method === 'GET' ? f.parent : null);
            assert.ok(f.logs.some(message => message.includes('recovered on attempt 3')));
            if (method === 'POST') assert.equal(f.runs[0].status, 'completed');
          } else {
            await assert.rejects(api(route, method), error => {
              assert.ok(error.message.includes(`GitHub ${method} ${route}:`));
              assert.match(error.message, /after 3 attempt\(s\)/);
              if (failure === 'HTTP 503') assert.match(error.message, /HTTP 503.*request ID request-123/);
              else assert.match(error.message, failure === 'network' ? /temporary connection failure/ : /SyntaxError/);
              return true;
            });
            if (method === 'POST') assert.equal(f.runs[0].status, 'queued');
          }
          assert.equal(calls, 3);
          assert.equal(f.now - started, 15000);
          assert.ok(f.events.every(event => !event.startsWith('dispatch:')));
        });
    }
  }
}

test('HTTP 408 reads recover after bounded backoff', {timeout: 5000}, async t => {
  const f = fixture(t);
  const started = f.now;
  let calls = 0;
  f.beforeRequest = request => {
    if (request.route === '/actions/runs/7' && ++calls < 3) {
      return new Response('', {status: 408});
    }
  };
  assert.deepEqual(await require('../lib').client()('/actions/runs/7'), f.parent);
  assert.equal(calls, 3);
  assert.equal(f.now - started, 15000);
});

test('HTTP 503 dispatch is never retried', {timeout: 5000}, async t => {
  const f = fixture(t);
  const started = f.now;
  const route = '/actions/workflows/runner-worker.yml/dispatches';
  f.beforeRequest = request => {
    if (request.route === route) return new Response('', {status: 503});
  };
  await assert.rejects(require('../lib').client()(route, 'POST', {}), /HTTP 503 after 1 attempt\(s\)/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.now, started);
  assert.equal(f.runs.length, 0);
});

for (const condition of ['active', 'completed parent', 'stale source', 'rerun']) {
  test(`child guard: ${condition}`, {timeout: 5000}, async t => {
    const f = fixture(t);
    process.env.GITHUB_RUN_ID = '100';
    if (condition === 'completed parent') f.parent.status = 'completed';
    if (condition === 'stale source') f.source = 'c'.repeat(40);
    if (condition === 'rerun') process.env.GITHUB_RUN_ATTEMPT = '2';
    assert.equal(await f.run('../guard/index'), condition === 'active' ? 0 : 1);
    assert.equal(f.runs.length, 0);
    assert.ok(f.requests.every(request => request.method === 'GET'));
  });
}

test('CPU primary success uses the same coordinator contract', {timeout: 5000}, async t => {
  const f = fixture(t, cpuRunners);
  f.onDispatch = run => f.finish(run, 'success');
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.events, ['dispatch:100', 'completed:100:success']);
  assert.deepEqual(JSON.parse(f.outputs().runner), cpuRunners[0]);
  assert.equal(f.state(), null);
});

const cpuProfiles = [
  ['linux amd64', cpuRunners],
  ['linux arm64', cpuRunners.map(runner => ({...runner, labels: runner.labels.replace('amd64', 'arm64')}))],
  ['windows amd64', cpuRunners.map(runner => ({...runner, labels: runner.labels.replace('linux', 'windows')}))],
  ['memory optimized', cpuRunners.map(runner => ({group: 'nv-cpu-memory', labels: `${runner.labels}m`}))],
  ['general to memory optimized', [cpuRunners[0], {group: 'nv-cpu-memory', labels: 'linux-amd64-cpu32m'}]],
  ['explicit smaller fallback', [...cpuRunners].reverse()],
];
for (const [profile, runners] of cpuProfiles) {
  test(`CPU fallback between different sizes: ${profile}`, {timeout: 5000}, async t => {
    const f = fixture(t, runners);
    f.onDispatch = run => { if (run.id === 101) f.finish(run, 'success'); };
    assert.equal(await f.run(), 0);
    assert.deepEqual(f.events, ['dispatch:100', 'cancel:100', 'completed:100:cancelled',
      'dispatch:101', 'completed:101:success']);
    assert.deepEqual(f.runs.map(run => JSON.parse(run.payload.inputs.runner)), runners);
    assert.deepEqual(JSON.parse(f.outputs().runner), runners[1]);
    assert.equal(f.state(), null);
  });
}

test('CPU queue exhaustion is bounded by the supplied labels', {timeout: 5000}, async t => {
  const f = fixture(t, cpuRunners);
  assert.equal(await f.run(), 1);
  assert.equal(f.runs.length, 2);
  assert.ok(f.runs.every(run => run.conclusion === 'cancelled'));
  assert.match(f.errors.join('\n'), /All runner candidates exhausted/);
  assert.equal(f.state(), null);
});

test('default x86 CPU sizes use ten-minute queues and cancel before each switch', {timeout: 5000}, async t => {
  const runners = [16, 8, 32].map(size => ({
    group: 'nv-cpu-general', labels: `linux-amd64-cpu${size}`,
  }));
  const f = fixture(t, runners);
  delete process.env.INPUT_RUNNERS;
  process.env['INPUT_QUEUE-TIMEOUT-MINUTES'] = '10';
  const started = f.now;
  f.onDispatch = run => { if (run.id === 102) f.finish(run, 'success'); };
  assert.equal(await f.run(), 0);
  assert.equal(f.now - started, 2 * 10 * 60000 + 3 * 15000);
  assert.deepEqual(f.runs.map(run => JSON.parse(run.payload.inputs.runner)), runners);
  assert.deepEqual(f.events, [
    'dispatch:100', 'cancel:100', 'completed:100:cancelled',
    'dispatch:101', 'cancel:101', 'completed:101:cancelled',
    'dispatch:102', 'completed:102:success',
  ]);
  assert.equal(f.outputs().attempts, '3');
  assert.equal(f.state(), null);
});

test('CPU workload failure does not retry on a larger CPU label', {timeout: 5000}, async t => {
  const f = fixture(t, cpuRunners);
  f.onDispatch = run => f.finish(run, 'failure');
  assert.equal(await f.run(), 1);
  assert.equal(f.runs.length, 1);
  assert.match(f.errors.join('\n'), /no workload retry/);
});

test('explicit final re-wait honors its budget and strips policy from runs-on', {timeout: 5000}, async t => {
  const runners = [...cpuRunners, {...cpuRunners[1], 'queue-timeout-minutes': 60}];
  const f = fixture(t, runners);
  const started = f.now;
  assert.equal(await f.run(), 1);
  assert.equal(f.now - started, (1 + 1 + 60) * 60000 + 3 * 15000);
  assert.deepEqual(f.runs.map(run => JSON.parse(run.payload.inputs.runner)),
    [...cpuRunners, cpuRunners[1]]);
  assert.deepEqual(JSON.parse(f.outputs().runner), cpuRunners[1]);
  assert.ok(f.logs.includes('Queue deadline for this candidate: 60 minutes'));
  assert.deepEqual(f.events, [
    'dispatch:100', 'cancel:100', 'completed:100:cancelled',
    'dispatch:101', 'cancel:101', 'completed:101:cancelled',
    'dispatch:102', 'cancel:102', 'completed:102:cancelled',
  ]);
});

for (const [family, runners, duration] of [['cpu', cpuRunners, 10], ['gpu', gpuRunners, 15]]) {
  test(family + ' extended omitted queue deadline uses its family default', {timeout: 5000}, async t => {
    const f = fixture(t, [runners[0]]);
    process.env['INPUT_QUEUE-POLICY'] = 'extended';
    delete process.env['INPUT_QUEUE-TIMEOUT-MINUTES'];
    const started = f.now;
    assert.equal(await f.run(), 1);
    assert.equal(f.now - started, duration * 60000 + 15000);
  });
}

test('terminal re-wait never repeats an acquired failing worker', {timeout: 5000}, async t => {
  const f = fixture(t, [cpuRunners[0], {...cpuRunners[0], 'queue-timeout-minutes': 60}]);
  f.onDispatch = run => f.finish(run, 'failure');
  assert.equal(await f.run(), 1);
  assert.equal(f.runs.length, 1);
  assert.match(f.errors.join('\n'), /no workload retry/);
});

test('terminal re-wait stops if queue cancellation races allocation', {timeout: 5000}, async t => {
  const f = fixture(t, [cpuRunners[0], {...cpuRunners[0], 'queue-timeout-minutes': 60}]);
  f.onCancel = run => { f.acquire(run); f.finish(run, 'cancelled'); };
  assert.equal(await f.run(), 1);
  assert.equal(f.runs.length, 1);
  assert.match(f.errors.join('\n'), /raced execution|ambiguous outcome/);
});

for (const [type, regular, count] of [['cpu-amd64', 10, 3], ['cpu-arm64', 10, 3],
  ['gpu-amd64', 15, 6], ['gpu-amd64-2gpu', 15, 3]]) {
  test(type + ' defaults include the full final sixty-minute re-wait', {timeout: 5000}, async t => {
    const f = fixture(t);
    process.env['INPUT_RUNNER-TYPE'] = type;
    process.env['INPUT_QUEUE-POLICY'] = 'extended';
    delete process.env.INPUT_RUNNERS;
    delete process.env['INPUT_QUEUE-TIMEOUT-MINUTES'];
    const started = f.now;
    assert.equal(await f.run(), 1);
    assert.equal(f.runs.length, count + 1);
    assert.equal(f.now - started, (regular * count + 60) * 60000 + (count + 1) * 15000);
    assert.deepEqual(f.runs.map(run => JSON.parse(run.payload.inputs.runner)), expectedExtendedDefaults[type]);
    assert.ok(f.runs.every(run => run.conclusion === 'cancelled'));
  });
}

test('existing examples-style caller retains six fifteen-minute GPU queues', {timeout: 5000}, async t => {
  const f = fixture(t);
  delete process.env.INPUT_RUNNERS;
  delete process.env['INPUT_QUEUE-POLICY'];
  process.env['INPUT_QUEUE-TIMEOUT-MINUTES'] = '15';
  const started = f.now;
  assert.equal(await f.run(), 1);
  assert.equal(f.now - started, 6 * 15 * 60000 + 6 * 15000);
  assert.deepEqual(f.runs.map(run => JSON.parse(run.payload.inputs.runner)), expectedDefaults['gpu-amd64']);
});

for (const type of ['cpu-amd64', 'gpu-amd64']) {
  test(type + ' existing callers keep ten-minute omitted deadlines', {timeout: 5000}, async t => {
    const f = fixture(t);
    process.env['INPUT_RUNNER-TYPE'] = type;
    delete process.env.INPUT_RUNNERS;
    delete process.env['INPUT_QUEUE-POLICY'];
    delete process.env['INPUT_QUEUE-TIMEOUT-MINUTES'];
    const started = f.now;
    assert.equal(await f.run(), 1);
    const count = expectedDefaults[type].length;
    assert.equal(f.now - started, count * (10 * 60000 + 15000));
    assert.equal(f.runs.length, count);
  });
}

test('extended policy does not append pools to explicit runner lists', {timeout: 5000}, async t => {
  const f = fixture(t, cpuRunners);
  process.env['INPUT_QUEUE-POLICY'] = 'extended';
  assert.equal(await f.run(), 1);
  assert.deepEqual(f.runs.map(run => JSON.parse(run.payload.inputs.runner)), cpuRunners);
});

test('unknown queue policy fails before dispatch', {timeout: 5000}, async t => {
  const f = fixture(t);
  process.env['INPUT_QUEUE-POLICY'] = 'unknown';
  assert.equal(await f.run(), 1);
  assert.equal(f.requests.length, 0);
  assert.match(f.errors.join('\n'), /queue-policy/);
});

const invalidRunners = [
  ['empty list', [], /one to seven candidates/],
  ['null list', null, /one to seven candidates/],
  ['more than seven candidates', [...cpuRunners, ...gpuRunners, ...gpuRunners], /one to seven candidates/],
  ['mixed CPU/GPU', [cpuRunners[0], gpuRunners[0]], /CPU\/GPU family/],
  ['mixed architectures', [cpuRunners[0], {group: 'nv-cpu-general', labels: 'linux-arm64-cpu32'}], /architecture/],
  ['mixed operating systems', [cpuRunners[0], {group: 'nv-cpu-general', labels: 'windows-amd64-cpu32'}], /OS/],
  ['wrong CPU group', [{group: 'nv-cpu-memory', labels: 'linux-amd64-cpu16'}], /matching runner group/],
  ['memory label in general pool', [{group: 'nv-cpu-general', labels: 'linux-amd64-cpu16m'}], /matching runner group/],
  ['CPU label in GPU pool', [{group: 'nv-gpu-general', labels: 'linux-amd64-cpu16'}], /matching runner group/],
  ['different GPU counts', [gpuRunners[0], {group: 'nv-gpu-amd64-h100-2gpu', labels: 'linux-amd64-gpu-h100-latest-2'}], /GPU count/],
  ['duplicate labels', [cpuRunners[0], cpuRunners[0]], /Duplicate runner candidate/],
  ['nonterminal repeat', [cpuRunners[0], {...cpuRunners[0], 'queue-timeout-minutes': 60}, cpuRunners[1]], /Duplicate runner candidate/],
  ['zero candidate deadline', [{...cpuRunners[0], 'queue-timeout-minutes': 0}], /integer from 1 to 60/],
  ['oversized candidate deadline', [{...cpuRunners[0], 'queue-timeout-minutes': 61}], /integer from 1 to 60/],
  ['string candidate deadline', [{...cpuRunners[0], 'queue-timeout-minutes': '60'}], /integer from 1 to 60/],
  ['fractional candidate deadline', [{...cpuRunners[0], 'queue-timeout-minutes': 1.5}], /integer from 1 to 60/],
  ['broad CPU label', [{group: 'nv-cpu-general', labels: 'linux-amd64'}], /specific NVIDIA CPU or GPU label/],
];
for (const [name, runners, expectedError] of invalidRunners) {
  test(`reject ${name} before any API request`, {timeout: 5000}, async t => {
    const f = fixture(t, runners);
    assert.equal(await f.run(), 1);
    assert.equal(f.requests.length, 0);
    assert.equal(f.runs.length, 0);
    assert.match(f.errors.join('\n'), expectedError);
  });
}
