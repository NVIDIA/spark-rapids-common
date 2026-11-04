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
const {randomUUID} = require('node:crypto');
const {input, output, save, fail, client, currentSource, parentActive,
  acquired, snapshot, cancel, cleanup, sleep} = require('./lib');

// Linux defaults from enterprise-runner-configuration's runner catalog and Spark grants.
// Keep architectures and GPU counts separate; consumers may have narrower grants.
const defaultRunners = {
  'cpu-amd64': [16, 8, 32].map(size => ({
    group: 'nv-cpu-general', labels: `linux-amd64-cpu${size}`,
  })),
  'cpu-arm64': [16, 8, 32].map(size => ({
    group: 'nv-cpu-general', labels: `linux-arm64-cpu${size}`,
  })),
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
};

// Extended waits are opt-in so existing coordinators retain their timeout budgets.
const finalQueueLabels = {
  'cpu-amd64': 'linux-amd64-cpu32',
  'cpu-arm64': 'linux-arm64-cpu32',
  'gpu-amd64': 'linux-amd64-gpu-rtxpro6000-latest-1',
  'gpu-amd64-2gpu': 'linux-amd64-gpu-rtxpro6000-latest-2',
};

function minutes(name, maximum, defaultValue) {
  const value = Number(process.env['INPUT_' + name.toUpperCase()]?.trim() || defaultValue);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value * 60000;
}

function candidates() {
  const requestedType = input('runner-type');
  const type = ['cpu', 'gpu'].includes(requestedType) ? `${requestedType}-amd64` : requestedType;
  if (!Object.hasOwn(defaultRunners, type)) {
    throw new Error(`runner-type must be cpu, gpu, or one of: ${Object.keys(defaultRunners).join(', ')}`);
  }
  const configured = process.env.INPUT_RUNNERS?.trim();
  const policy = process.env['INPUT_QUEUE-POLICY']?.trim() || 'standard';
  if (!['standard', 'extended'].includes(policy)) {
    throw new Error('queue-policy must be standard or extended');
  }
  let runners = configured ? JSON.parse(configured) : defaultRunners[type];
  if (!configured && policy === 'extended' && Object.hasOwn(finalQueueLabels, type)) {
    runners = [...runners, {
      ...runners.find(runner => runner.labels === finalQueueLabels[type]),
      'queue-timeout-minutes': 60,
    }];
  }
  if (!Array.isArray(runners) || runners.length < 1 || runners.length > 7) {
    throw new Error('runners must contain one to seven candidates');
  }
  let shape;
  const seen = new Set();
  for (const [index, runner] of runners.entries()) {
    if (!runner || !['group,labels', 'group,labels,queue-timeout-minutes'].includes(Object.keys(runner).sort().join(',')) ||
        typeof runner.group !== 'string' || typeof runner.labels !== 'string') {
      throw new Error('Each candidate must have group and labels strings, with an optional queue-timeout-minutes');
    }
    const queueMinutes = runner['queue-timeout-minutes'];
    if (Object.hasOwn(runner, 'queue-timeout-minutes') &&
        (!Number.isInteger(queueMinutes) || queueMinutes < 1 || queueMinutes > 60)) {
      throw new Error('Candidate queue-timeout-minutes must be an integer from 1 to 60');
    }
    const gpu = runner.labels.match(/^(linux|windows|wsl)-(amd64|arm64)-gpu-[a-z0-9]+-(earliest|latest)-([1-9][0-9]*)$/);
    const cpu = runner.labels.match(/^(linux|windows)-(amd64|arm64)-cpu([1-9][0-9]*)(m?)$/);
    let current;
    if (gpu && /^nv-gpu-[a-z0-9-]+$/.test(runner.group)) {
      current = `${gpu[1]}:${gpu[2]}:gpu:${gpu[4]}`;
    } else if (cpu && runner.group === (cpu[4] ? 'nv-cpu-memory' : 'nv-cpu-general')) {
      // CPU sizes may differ; the caller must choose candidates that meet the workload's needs.
      current = `${cpu[1]}:${cpu[2]}:cpu`;
    } else {
      throw new Error('Use a specific NVIDIA CPU or GPU label with its matching runner group');
    }
    if (shape && shape !== current) {
      throw new Error('Fallback must preserve OS, architecture, CPU/GPU family and GPU count');
    }
    shape = current;
    // Only an explicit final re-wait may repeat a pool; execution is still never retried.
    if (seen.has(runner.labels) && (index !== runners.length - 1 || queueMinutes === undefined ||
        !runners.slice(0, index).some(previous => previous.labels === runner.labels && previous.group === runner.group))) {
      throw new Error('Duplicate runner candidate requires an explicit final queue-timeout-minutes and the same group');
    }
    seen.add(runner.labels);
  }
  const [, architecture, family, count] = shape.split(':');
  const actualType = `${family}-${architecture}${family === 'gpu' && count !== '1' ? `-${count}gpu` : ''}`;
  if (actualType !== type) {
    throw new Error(`runners must match runner-type ${type}: CPU/GPU family, architecture and GPU count`);
  }
  console.log(`Using ${configured ? 'explicit runners' : 'shared defaults'} for ${type}: ${runners.map(runner => runner.labels).join(' -> ')}`);
  return {runners, queueDefault: policy === 'extended' && type.startsWith('gpu-') ? 15 : 10};
}

async function main() {
  const {runners, queueDefault} = candidates();
  const defaultQueueLimit = minutes('queue-timeout-minutes', 60, queueDefault);
  const executionLimit = minutes('execution-timeout-minutes', 300);
  const workflow = input('workflow');
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow)) throw new Error('workflow must be a YAML filename');
  const workflowRef = input('workflow-ref');
  if (workflowRef.includes('refs/pull/')) throw new Error('workflow-ref must not be a PR ref');
  const sourceRef = input('source-ref');
  const sourceSha = input('source-sha');
  const workload = JSON.parse(input('workload'));
  if (!workload || Array.isArray(workload) || typeof workload !== 'object') {
    throw new Error('workload must be a JSON object');
  }
  const api = client();
  const parentId = process.env.GITHUB_RUN_ID;
  const parentAttempt = process.env.GITHUB_RUN_ATTEMPT;
  const workflowSha = (await api(`/commits/${encodeURIComponent(workflowRef)}`)).sha;
  const ensureCurrent = async () => {
    await parentActive(api, parentId, parentAttempt);
    await currentSource(api, sourceRef, sourceSha);
  };
  const report = (active, outcome, queuedAt) => {
    const wait = queuedAt ? `; observed queue wait ${Math.round((Date.now() - queuedAt) / 1000)}s` : '';
    const line = `${active.runner.labels}: ${outcome}${wait}; child ${active.id}`;
    const logUrl = active.jobUrl || active.url;
    const logLabel = active.jobUrl ? 'View worker job logs here' : 'Job link unavailable; view worker run here';
    console.log(line);
    console.log(`${logLabel}: ${logUrl}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `- ${line} ([${logLabel}](${logUrl}); [Worker artifacts](${active.url}))\n`);
    }
  };

  let active = null;
  try {
    for (let i = 0; i < runners.length; i++) {
      const candidate = runners[i];
      const queueLimit = candidate['queue-timeout-minutes'] === undefined ?
        defaultQueueLimit : candidate['queue-timeout-minutes'] * 60000;
      await ensureCurrent();
      if ((await api(`/commits/${encodeURIComponent(workflowRef)}`)).sha !== workflowSha) {
        throw new Error('Trusted workflow ref changed; restart the coordinator');
      }
      active = {
        workflow, workflowSha, runner: {group: candidate.group, labels: candidate.labels},
        request: `runner-${parentId}-${parentAttempt}-${randomUUID()}`,
        // Run timestamps have second precision; allow for rounding and small clock skew.
        created: new Date(Date.now() - 60000).toISOString(),
      };
      save(active);
      const dispatch = await api(`/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, 'POST', {
        ref: workflowRef,
        inputs: {
          'request-id': active.request,
          'parent-run-id': parentId,
          'parent-run-attempt': parentAttempt,
          'source-ref': sourceRef,
          'source-sha': sourceSha,
          runner: JSON.stringify(active.runner),
          workload: JSON.stringify(workload),
        },
      });
      if (!dispatch?.workflow_run_id) throw new Error('Dispatch did not return a run ID');
      active.id = dispatch.workflow_run_id;
      active.url = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${active.id}`;
      save(active);
      output('run-id', active.id);
      output('run-url', active.url);
      output('runner', JSON.stringify(active.runner));
      output('attempts', i + 1);
      console.log(`Candidate ${i + 1}/${runners.length}: ${active.runner.labels}; ${active.url}`);

      const dispatchedAt = Date.now();
      console.log('Queue deadline for this candidate: ' + queueLimit / 60000 + ' minutes');
      const jobDeadline = dispatchedAt + 120000;
      console.log(`Child ${active.id}: first metadata poll in 15s (within the 120s startup window)`);
      await sleep(15000);
      let identityConfirmed = false;
      let queuedAt;
      let startedAt;
      let pollRound = 0;
      while (true) {
        pollRound++;
        await ensureCurrent();
        // Dispatch can return before the child's run metadata has finished initializing.
        let state;
        try {
          state = await snapshot(api, active, identityConfirmed ? 0 : jobDeadline);
        } catch (error) {
          if (!identityConfirmed && Date.now() >= jobDeadline) {
            throw new Error(`Worker metadata did not become valid within the 120s startup window` +
              `; last observation: ${error.message}`);
          }
          throw error;
        }
        const {run, job, metadataPending} = state;
        const progress = `Poll #${pollRound}: child ${active.id}; elapsed ${Math.round((Date.now() - dispatchedAt) / 1000)}s`;
        if (metadataPending) {
          console.log(`${progress}; metadata pending (120s startup window): ${metadataPending}; next poll in 5s`);
          await sleep(5000);
          continue;
        }
        identityConfirmed = true;
        const jobUrl = job?.html_url || (job?.id ? `${active.url}/job/${job.id}` : null);
        if (jobUrl && jobUrl !== active.jobUrl) {
          active.jobUrl = jobUrl;
          save(active);
        }
        if (acquired(job) && !startedAt) {
          startedAt = Date.now();
          report(active, 'runner acquired; fallback disabled', queuedAt);
        }
        if (run.status === 'completed') {
          console.log(`${progress}; run completed/${run.conclusion}; worker ${job?.conclusion}; polling finished`);
          report(active, `completed: ${run.conclusion}`, undefined);
          if (run.conclusion !== 'success' || job?.conclusion !== 'success' || !startedAt) {
            throw new Error(`Worker ${active.id}: ${run.conclusion}; no workload retry`);
          }
          await ensureCurrent();
          active = null;
          save(null);
          return;
        }
        if (startedAt) {
          if (Date.now() - startedAt >= executionLimit) {
            throw new Error(`Worker ${active.id}: execution timeout; no fallback`);
          }
        } else if (job?.status === 'queued') {
          queuedAt ??= Date.now();
          if (Date.now() - queuedAt >= queueLimit) {
            // Re-read immediately before cancellation, then inspect allocation again after it.
            const latest = await snapshot(api, active);
            if (acquired(latest.job) || latest.run.status === 'completed') continue;
            if (latest.job?.status !== 'queued') throw new Error('Child left the runner queue; no fallback');
            await cancel(api, active.id, active);
            report(active, 'queue timeout; cancellation confirmed', queuedAt);
            active = null;
            save(null);
            break;
          }
        } else if (job) {
          throw new Error(`Child state ${job.status} is not a runner queue; no fallback`);
        }
        console.log(`${progress}; run ${run.status}; worker ${job?.status}; next poll in 60s (1 minute)`);
        await sleep(60000);
      }
    }
    throw new Error('All runner candidates exhausted their queue deadlines');
  } catch (error) {
    // Keep the primary failure visible even if cleanup encounters a separate API error.
    fail(error);
    if (active?.id) report(active, `failed: ${error.message}`);
  } finally {
    // The post action covers parent cancellation that terminates this process before finally runs.
    try {
      await cleanup(api, active);
      if (active?.id) report(active, 'cleanup confirmed; child is no longer running');
      save(null);
    } catch (error) {
      if (active?.id) report(active, `cleanup unconfirmed: ${error.message}; check the child run`);
      throw error;
    }
  }
}

if (require.main === module) main().catch(fail);

module.exports = main;
