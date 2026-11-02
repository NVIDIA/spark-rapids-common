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

function jsonInput(name) {
  try {
    return JSON.parse(process.env[`INPUT_${name.toUpperCase()}`]);
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
}

function main() {
  const needs = jsonInput('needs');
  const requiredJobs = jsonInput('required-jobs');
  const validId = id => typeof id === 'string' && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(id);

  if (!needs || typeof needs !== 'object' || Array.isArray(needs) ||
      Object.keys(needs).length === 0 || !Object.keys(needs).every(validId)) {
    throw new Error('needs must be a nonempty JSON object keyed by workflow job IDs');
  }
  if (!Array.isArray(requiredJobs) || !requiredJobs.every(validId) ||
      new Set(requiredJobs).size !== requiredJobs.length) {
    throw new Error('required-jobs must be a JSON array of unique workflow job IDs');
  }

  const required = new Set(requiredJobs);
  const errors = [];
  for (const id of required) {
    if (!Object.hasOwn(needs, id)) errors.push(`${id}: missing from needs`);
  }

  // Log only job IDs/results, never dependency outputs, which can contain sensitive data.
  for (const [id, job] of Object.entries(needs)) {
    const result = job?.result;
    if (!['success', 'failure', 'cancelled', 'skipped'].includes(result)) {
      errors.push(`${id}: invalid or missing job result`);
      continue;
    }
    const expected = required.has(id) ? ['success'] : ['success', 'skipped'];
    console.log(`${id}: ${result} (expected ${expected.join(' or ')})`);
    if (!expected.includes(result)) errors.push(`${id}: ${result}`);
  }

  if (errors.length) throw new Error(`Workflow result gate failed: ${errors.join('; ')}`);
  console.log('Workflow result gate passed');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = String(error.message).replaceAll('%', '%25')
      .replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.error(`::error::${message}`);
    process.exitCode = 1;
  }
}

module.exports = main;
