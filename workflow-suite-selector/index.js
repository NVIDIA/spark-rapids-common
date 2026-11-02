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

const {posix: {matchesGlob}} = require('node:path');

const validJob = job => typeof job === 'string' && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(job);

function selectSuites(files, config) {
  if (!Array.isArray(files) || files.some(file => !file ||
    typeof file.filename !== 'string' || !file.filename ||
    (file.previous_filename !== undefined && typeof file.previous_filename !== 'string'))) {
    throw new Error('Invalid PR file metadata');
  }
  const validPaths = (paths, globs = false) => Array.isArray(paths) &&
    paths.every(path => typeof path === 'string' && path.length > 0 &&
      !path.startsWith('/') && !path.startsWith('!') && !path.includes('..') &&
      !path.includes('\\') && (globs || !/[?*]/.test(path)));
  const sharedPaths = config?.shared_paths === undefined ? [] : config.shared_paths;
  if (!config || !validPaths(sharedPaths) || !config.suites ||
      typeof config.suites !== 'object' || Array.isArray(config.suites) ||
      Object.keys(config.suites).length === 0) {
    throw new Error('Invalid suite catalog');
  }
  const changed = files.flatMap(file => [file.filename, file.previous_filename].filter(Boolean));
  const matches = (file, path) => path.endsWith('/') ? file.startsWith(path) : file === path;
  const shared = changed.some(file => sharedPaths.some(path => matches(file, path)));
  return Object.entries(config.suites).filter(([name, suite]) => {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !suite ||
        (suite.paths !== undefined && (!validPaths(suite.paths) || suite.paths.length === 0)) ||
        !Array.isArray(suite.jobs) || suite.jobs.length === 0 ||
        !suite.jobs.every(validJob) || new Set(suite.jobs).size !== suite.jobs.length) {
      throw new Error(`Invalid suite: ${name}`);
    }
    if (suite.exclude_paths !== undefined && !validPaths(suite.exclude_paths, true)) {
      throw new Error(`Suite ${name}: exclude_paths must be an array of relative paths or glob patterns`);
    }
    if (suite.enabled !== undefined && typeof suite.enabled !== 'boolean') {
      throw new Error(`Suite ${name}: enabled must be a boolean`);
    }
    if (suite.comment !== undefined && typeof suite.comment !== 'string') {
      throw new Error(`Suite ${name}: comment must be a string`);
    }
    if (suite.enabled === false && !suite.comment?.trim()) {
      throw new Error(`Suite ${name}: disabling a suite requires a nonempty comment`);
    }
    // Filter each path, not the whole PR; shared changes and either side of a rename still count.
    return suite.enabled !== false && (shared || changed.some(file =>
      (suite.paths === undefined || suite.paths.some(path => matches(file, path))) &&
      !suite.exclude_paths?.some(path => matches(file, path) ||
        matchesGlob(file, path.endsWith('/') ? `${path}**` : path))));
  }).map(([name]) => name);
}

function pullNumber(context) {
  const match = context.eventName === 'push' &&
    /^refs\/heads\/pull-request\/([1-9][0-9]*)$/.exec(context.ref || '');
  if (!match) throw new Error('Suite selection requires a push to refs/heads/pull-request/<number>');
  return Number(match[1]);
}

async function assertCurrent(github, repo, pr) {
  const {data: current} = await github.rest.pulls.get({...repo, pull_number: pr.number});
  if (current.state !== 'open' || current.head.sha !== pr.head.sha ||
      current.base.sha !== pr.base.sha || current.base.ref !== pr.base.ref) {
    throw new Error('PR changed during suite selection; rerun for the current PR head');
  }
}

async function select({github, context, core, catalog, baseBranch, selectorJob}) {
  if (typeof baseBranch !== 'string' || !baseBranch.trim() || !validJob(selectorJob)) {
    throw new Error('A base-branch and valid selector-job ID are required');
  }
  const {data: pr} = await github.rest.pulls.get({
    ...context.repo, pull_number: pullNumber(context),
  });
  // Check runs share a head SHA; another target branch must not waive this branch's tests.
  if (pr.base.ref !== baseBranch) throw new Error(`Suite selection only supports PRs targeting ${baseBranch}`);
  if (pr.state !== 'open' || context.sha !== pr.head.sha) {
    throw new Error('Push commit does not match the head of an open PR');
  }
  const files = await github.paginate(github.rest.pulls.listFiles, {
    ...context.repo, pull_number: pr.number, per_page: 100,
  });
  // GitHub caps this endpoint at 3,000 files. Incomplete detection must not skip tests.
  if (files.length !== pr.changed_files) throw new Error('Incomplete PR file list');
  const suites = selectSuites(files, catalog);
  await assertCurrent(github, context.repo, pr);

  for (const [name, suite] of Object.entries(catalog.suites)) {
    if (suite.enabled === false) core.info(`Suite ${name} is disabled: ${suite.comment}`);
  }
  core.setOutput('suites', JSON.stringify(suites));
  core.setOutput('required-jobs', JSON.stringify([
    ...new Set([selectorJob, ...suites.flatMap(name => catalog.suites[name].jobs)]),
  ]));
  await core.summary.addHeading('Test suite selection')
    .addRaw(`PR #${pr.number}, head ${pr.head.sha}: ${suites.join(', ') || 'no enabled suites affected'}`)
    .write();
}

module.exports = {select, selectSuites};
