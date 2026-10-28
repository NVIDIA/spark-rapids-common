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
    INPUT_RUNNERS: JSON.stringify(runners),
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
    runs: [], requests: [], events: [], errors: [], logs: [], unexpected: [],
    parent: {status: 'in_progress', run_attempt: 1}, source: sourceSha,
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
    f.now += milliseconds;
    await f.onSleep(milliseconds);
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const parsed = new URL(url);
    const prefix = '/repos/example/consumer';
    const route = parsed.pathname.slice(prefix.length);
    const request = {route, url: parsed, ...options};
    f.requests.push(request);
    if (parsed.origin !== env.GITHUB_API_URL || !parsed.pathname.startsWith(`${prefix}/`)) {
      f.unexpected.push(url);
      throw new Error('Network access is forbidden in these tests');
    }
    const override = f.beforeRequest(request);
    if (override) return override;
    const json = body => new Response(JSON.stringify(body), {status: 200});
    if (options.method === 'GET' && route === '/commits/main') return json({sha: workflowSha});
    if (options.method === 'GET' && route === '/commits/refs%2Fpull%2F1%2Fmerge') return json({sha: f.source});
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
});

test('fallback waits for cancellation completion before dispatching the next pool', {timeout: 5000}, async t => {
  const f = fixture(t);
  let cancelAt;
  f.onDispatch = run => { if (run.id === 101) f.finish(run, 'success'); };
  f.onCancel = () => { cancelAt = f.now; };
  f.onSleep = () => {
    if (cancelAt && f.now - cancelAt >= 10000) f.finish(f.runs[0], 'cancelled');
  };
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.events, ['dispatch:100', 'cancel:100', 'completed:100:cancelled',
    'dispatch:101', 'completed:101:success']);
  assert.deepEqual(JSON.parse(f.runs[1].payload.inputs.runner), gpuRunners[1]);
  assert.equal(f.outputs().attempts, '2');
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
});

test('unconfirmed cancellation preserves cleanup state and never dispatches again', {timeout: 5000}, async t => {
  const f = fixture(t);
  f.onCancel = () => {};
  assert.equal(await f.run(), 1);
  assert.equal(f.runs.length, 1);
  assert.equal(f.state().id, 100);
  assert.match(f.errors.join('\n'), /Cancellation unconfirmed/);
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

test('post entry point cancels using the durable state written before interruption', {timeout: 5000}, async t => {
  const f = fixture(t);
  const lib = require('../lib');
  const active = {id: 100, request: 'runner-7-1-interrupted'};
  f.runs.push({id: 100, status: 'queued', job: {status: 'queued'}});
  lib.save(active);
  process.env.STATE_active = JSON.stringify(f.state());
  assert.equal(await f.run('../cleanup'), 0);
  assert.deepEqual(f.events, ['cancel:100', 'completed:100:cancelled']);
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
  assert.equal(f.now - started, 1000);
  assert.equal(f.runs.length, 1);
});

for (const delay of ['identity', 'run 404', 'jobs 404', 'empty jobs']) {
  test(`startup metadata recovers: ${delay}`, {timeout: 5000}, async t => {
    const f = fixture(t);
    const started = f.now;
    f.onDispatch = run => f.finish(run, 'success');
    f.beforeRequest = request => {
      if (f.now - started >= 10000) return;
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
    assert.equal(f.now - started, 10000);
    assert.deepEqual(f.events, ['dispatch:100', 'completed:100:success']);
    assert.equal(f.logs.filter(message => message.startsWith('Waiting for child')).length, 2);
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
    f.onSleep = () => { f.runs[0][field] = value; };
    assert.equal(await f.run(), 1);
    assert.equal(f.now - started, 60000);
    assert.deepEqual(f.events, ['dispatch:100', 'cancel:100', 'completed:100:cancelled']);
    assert.match(f.errors.join('\n'), /identity mismatch/);
    assert.ok(f.errors.some(message => message.includes(`"field":"${field}"`)));
    assert.ok(f.logs.every(message => !message.startsWith('Waiting for child')));
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

test('four x86 CPU sizes use ten-minute queues and cancel before each switch', {timeout: 5000}, async t => {
  const runners = [16, 8, 4, 32].map(size => ({
    group: 'nv-cpu-general', labels: `linux-amd64-cpu${size}`,
  }));
  const f = fixture(t, runners);
  process.env['INPUT_QUEUE-TIMEOUT-MINUTES'] = '10';
  const started = f.now;
  f.onDispatch = run => { if (run.id === 103) f.finish(run, 'success'); };
  assert.equal(await f.run(), 0);
  assert.equal(f.now - started, 3 * 10 * 60000);
  assert.deepEqual(f.runs.map(run => JSON.parse(run.payload.inputs.runner)), runners);
  assert.deepEqual(f.events, [
    'dispatch:100', 'cancel:100', 'completed:100:cancelled',
    'dispatch:101', 'cancel:101', 'completed:101:cancelled',
    'dispatch:102', 'cancel:102', 'completed:102:cancelled',
    'dispatch:103', 'completed:103:success',
  ]);
  assert.equal(f.outputs().attempts, '4');
  assert.equal(f.state(), null);
});

test('CPU workload failure does not retry on a larger CPU label', {timeout: 5000}, async t => {
  const f = fixture(t, cpuRunners);
  f.onDispatch = run => f.finish(run, 'failure');
  assert.equal(await f.run(), 1);
  assert.equal(f.runs.length, 1);
  assert.match(f.errors.join('\n'), /no workload retry/);
});

const invalidRunners = [
  ['more than four candidates', [...cpuRunners, ...gpuRunners], /one to four candidates/],
  ['mixed CPU/GPU', [cpuRunners[0], gpuRunners[0]], /CPU\/GPU family/],
  ['mixed architectures', [cpuRunners[0], {group: 'nv-cpu-general', labels: 'linux-arm64-cpu32'}], /architecture/],
  ['mixed operating systems', [cpuRunners[0], {group: 'nv-cpu-general', labels: 'windows-amd64-cpu32'}], /OS/],
  ['wrong CPU group', [{group: 'nv-cpu-memory', labels: 'linux-amd64-cpu16'}], /matching runner group/],
  ['memory label in general pool', [{group: 'nv-cpu-general', labels: 'linux-amd64-cpu16m'}], /matching runner group/],
  ['CPU label in GPU pool', [{group: 'nv-gpu-general', labels: 'linux-amd64-cpu16'}], /matching runner group/],
  ['different GPU counts', [gpuRunners[0], {group: 'nv-gpu-amd64-h100-2gpu', labels: 'linux-amd64-gpu-h100-latest-2'}], /GPU count/],
  ['duplicate labels', [cpuRunners[0], cpuRunners[0]], /Duplicate runner candidate/],
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
