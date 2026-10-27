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

function minutes(name, maximum) {
  const value = Number(input(name));
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value * 60000;
}

function candidates() {
  const runners = JSON.parse(input('runners'));
  if (!Array.isArray(runners) || runners.length < 1 || runners.length > 3) {
    throw new Error('runners must contain one to three candidates');
  }
  let shape;
  const seen = new Set();
  for (const runner of runners) {
    if (!runner || Object.keys(runner).sort().join(',') !== 'group,labels' ||
        !/^nv-gpu-[a-z0-9-]+$/.test(runner.group)) {
      throw new Error('Each candidate must have a runner group and one labels string');
    }
    const label = typeof runner.labels === 'string' &&
      runner.labels.match(/^(linux|windows|wsl)-(amd64|arm64)-gpu-[a-z0-9]+-(earliest|latest)-([1-9][0-9]*)$/);
    if (!label) throw new Error('Use a specific NVIDIA GPU runner label, not a broad label list');
    const current = `${label[1]}:${label[2]}:${label[4]}`;
    if (shape && shape !== current) throw new Error('Fallback must preserve OS, architecture and GPU count');
    shape = current;
    if (seen.has(runner.labels)) throw new Error('Duplicate GPU candidate');
    seen.add(runner.labels);
  }
  return runners;
}

async function main() {
  const runners = candidates();
  const queueLimit = minutes('queue-timeout-minutes', 30);
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
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `- ${line} ([run](${active.url}))\n`);
    }
  };

  let active = null;
  try {
    for (let i = 0; i < runners.length; i++) {
      await ensureCurrent();
      if ((await api(`/commits/${encodeURIComponent(workflowRef)}`)).sha !== workflowSha) {
        throw new Error('Trusted workflow ref changed; restart the coordinator');
      }
      active = {
        workflow, workflowSha, runner: runners[i],
        request: `gpu-${parentId}-${parentAttempt}-${randomUUID()}`,
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

      const jobDeadline = Date.now() + 120000;
      let queuedAt;
      let startedAt;
      while (true) {
        await ensureCurrent();
        const {run, job} = await snapshot(api, active);
        if (acquired(job) && !startedAt) {
          startedAt = Date.now();
          report(active, 'runner acquired; fallback disabled', queuedAt);
        }
        if (run.status === 'completed') {
          report(active, `completed: ${run.conclusion}`, undefined);
          if (run.conclusion !== 'success' || job?.conclusion !== 'success' || !startedAt) {
            throw new Error(`GPU child ${active.id}: ${run.conclusion}; no workload retry`);
          }
          await ensureCurrent();
          active = null;
          save(null);
          return;
        }
        if (!job && Date.now() > jobDeadline) throw new Error('GPU job was not created; no fallback');
        if (startedAt) {
          if (Date.now() - startedAt >= executionLimit) {
            throw new Error(`GPU child ${active.id}: execution timeout; no fallback`);
          }
        } else if (job?.status === 'queued') {
          queuedAt ??= Date.now();
          if (Date.now() - queuedAt >= queueLimit) {
            // Re-read immediately before cancellation, then inspect allocation again after it.
            const latest = await snapshot(api, active);
            if (acquired(latest.job) || latest.run.status === 'completed') continue;
            if (latest.job?.status !== 'queued') throw new Error('Child left the runner queue; no fallback');
            await cancel(api, active.id);
            const stopped = await snapshot(api, active);
            if (acquired(stopped.job) || stopped.run.conclusion !== 'cancelled' ||
                stopped.job?.conclusion !== 'cancelled') {
              throw new Error('Queue cancellation raced execution or has an ambiguous outcome; no fallback');
            }
            report(active, 'queue timeout; cancellation confirmed', queuedAt);
            active = null;
            save(null);
            break;
          }
        } else if (job) {
          throw new Error(`Child state ${job.status} is not a runner queue; no fallback`);
        }
        // Repository tokens share an API budget. Execution needs less frequent observation.
        await sleep(startedAt ? 120000 : 60000);
      }
    }
    throw new Error('All GPU candidates exhausted their queue deadlines');
  } catch (error) {
    // Keep the primary failure visible even if cleanup encounters a separate API error.
    fail(error);
  } finally {
    // The post action covers parent cancellation that terminates this process before finally runs.
    await cleanup(api, active);
    save(null);
  }
}

if (require.main === module) main().catch(fail);

module.exports = main;
