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

const fs = require('node:fs');
const {setTimeout: sleep} = require('node:timers/promises');

function input(name) {
  const value = process.env[`INPUT_${name.toUpperCase()}`]?.trim();
  if (!value) throw new Error(`Missing input: ${name}`);
  return value;
}

function output(name, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function save(active) {
  fs.appendFileSync(process.env.GITHUB_STATE, `active=${JSON.stringify(active)}\n`);
}

function fail(error) {
  const message = String(error.message).replaceAll('%', '%25')
    .replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.error(`::error::${message}`);
  process.exitCode = 1;
}

function client() {
  const token = input('github-token');
  const root = `${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}`;
  return async (path, method = 'GET', body) => {
    // Do not retry dispatch POSTs: an ambiguous response may already have created a run.
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${root}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2026-03-10',
          'Content-Type': 'application/json',
          'User-Agent': 'runner-queue-fallback',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      const text = await response.text();
      if (response.ok) return text.trim() ? JSON.parse(text) : null;

      const after = response.headers.get('retry-after');
      const remaining = response.headers.get('x-ratelimit-remaining');
      const reset = response.headers.get('x-ratelimit-reset');
      const rateLimited = response.status === 429 ||
        (response.status === 403 && (remaining === '0' || after !== null));
      const wait = after !== null
        ? (/^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now())
        : remaining === '0' && reset ? Number(reset) * 1000 - Date.now() + 1000 : 30000;
      const retrySafe = method === 'GET' || path.endsWith('/cancel');
      if (retrySafe && rateLimited && attempt < 2 && Number.isFinite(wait) && wait <= 60000) {
        console.log(`GitHub rate limit: waiting ${Math.max(1, Math.ceil(wait / 1000))}s`);
        await sleep(Math.max(1000, wait));
        continue;
      }
      const error = new Error(`GitHub ${method} ${path}: HTTP ${response.status}` +
        (rateLimited ? '; API quota unavailable within the bounded backoff window' : ''));
      error.status = response.status;
      throw error;
    }
  };
}

async function currentSource(api, ref, sha) {
  if (!/^refs\/(heads|tags|pull)\/.+/.test(ref) || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('source-ref must be a full ref and source-sha a full lowercase commit SHA');
  }
  const commit = await api(`/commits/${encodeURIComponent(ref)}`);
  if (commit.sha !== sha) throw new Error('Source ref changed; obtain approval for the new SHA');
}

async function parentActive(api, id, attempt) {
  if (!/^\d+$/.test(String(id)) || !/^\d+$/.test(String(attempt))) {
    throw new Error('Invalid parent run identity');
  }
  const parent = await api(`/actions/runs/${id}`);
  if (parent.status !== 'in_progress' || parent.run_attempt !== Number(attempt)) {
    throw new Error('Parent run is no longer active at the expected attempt');
  }
}

function acquired(job) {
  // started_at alone can be populated while queued. Prefer actual allocation/execution evidence.
  return Boolean(job && (job.runner_id || job.runner_name || job.status === 'in_progress' ||
    job.steps?.some(step => step.status === 'in_progress' ||
      (step.status === 'completed' && step.conclusion !== 'skipped'))));
}

async function snapshot(api, active) {
  const run = await api(`/actions/runs/${active.id}`);
  if (run.run_attempt !== 1 || run.event !== 'workflow_dispatch' ||
      run.head_sha !== active.workflowSha || run.display_title !== active.request) {
    throw new Error('Child run identity changed or the child workflow contract does not match');
  }
  const data = await api(`/actions/runs/${active.id}/attempts/1/jobs?per_page=100`);
  if (data.total_count > 1 || data.jobs.some(job => job.name !== 'worker')) {
    throw new Error('Child workflow must contain exactly one job named worker, without a matrix');
  }
  if (data.jobs.some(job => !job.labels?.includes(active.runner.labels))) {
    throw new Error('Child job did not request the selected runner label');
  }
  return {run, job: data.jobs[0]};
}

async function cancel(api, id) {
  const run = await api(`/actions/runs/${id}`);
  if (run.status === 'completed') return;
  try {
    await api(`/actions/runs/${id}/cancel`, 'POST');
  } catch (error) {
    // 409 can mean the run finished between GET and POST. Still confirm completion below.
    if (error.status !== 409) throw error;
  }
  const deadline = Date.now() + 120000;
  do {
    if ((await api(`/actions/runs/${id}`)).status === 'completed') return;
    await sleep(5000);
  } while (Date.now() < deadline);
  throw new Error(`Cancellation unconfirmed for child ${id}; no further dispatch is allowed`);
}

async function cleanup(api, active) {
  if (!active) return;
  if (active.id) {
    await cancel(api, active.id);
    return;
  }
  // Recover only our unique request if dispatch succeeded but its response was lost.
  const deadline = Date.now() + 120000;
  do {
    const query = new URLSearchParams({
      event: 'workflow_dispatch', created: `>=${active.created}`, per_page: '100',
    });
    for (let page = 1; page <= 10; page++) {
      const data = await api(`/actions/workflows/${encodeURIComponent(active.workflow)}/runs?${query}&page=${page}`);
      const matches = data.workflow_runs.filter(run => run.display_title === active.request);
      if (matches.length) {
        for (const run of matches) await cancel(api, run.id);
        return;
      }
      if (page * 100 >= data.total_count) break;
      if (page === 10) throw new Error('Cannot enumerate all runs for ambiguous dispatch cleanup');
    }
    await sleep(5000);
  } while (Date.now() < deadline);
  throw new Error(`Dispatch outcome unknown for ${active.request}; check the child workflow manually`);
}

module.exports = {input, output, save, fail, client, currentSource, parentActive,
  acquired, snapshot, cancel, cleanup, sleep};
