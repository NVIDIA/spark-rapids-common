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
const shaPattern = /^[a-f0-9]{40}$/i;
const decimalPattern = /^[1-9][0-9]*$/;
const severities = ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const request = { timeout: 30000 };

function optionsFromEnv(env) {
  return {
    resultPath: env.SONAR_RESULT_PATH,
    prNumber: env.SONAR_PR_NUMBER,
    sha: env.SONAR_SHA,
    baseRef: env.SONAR_BASE_REF,
    sourceAttempt: env.SONAR_SOURCE_ATTEMPT,
    scanResult: env.SONAR_SCAN_RESULT,
    sonarUrl: env.SONAR_URL,
    project: env.SONAR_PROJECT_KEY,
    actionsToken: env.SONAR_REPORT_ACTIONS_TOKEN === 'true',
  };
}

function requireValue(condition) {
  if (!condition) {
    throw new Error('Invalid Sonar reporting input or evidence');
  }
}

function text(value, maximum, empty = false) {
  return (
    typeof value === 'string' &&
    (empty || value.length > 0) &&
    value.length <= maximum &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function baseUrl(value) {
  requireValue(text(value, 2048) && !/[\s\\]/.test(value));
  const url = new URL(value);
  requireValue(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href.length <= 2048,
  );
  return url.href.replace(/\/+$/, '');
}

function identity(context, options) {
  const { owner, repo } = context.repo;
  requireValue(
    /^[a-z0-9][a-z0-9-]*$/i.test(owner || '') &&
      /^[a-z0-9_.-]+$/i.test(repo || '') &&
      !['.', '..'].includes(repo),
  );
  requireValue(
    shaPattern.test(options.sha || '') &&
      decimalPattern.test(String(options.prNumber)) &&
      positive(Number(options.prNumber)) &&
      positive(context.runId) &&
      positive(context.runAttempt),
  );
  return {
    owner,
    repo,
    repository: `${owner}/${repo}`,
    pr: Number(options.prNumber),
    sha: options.sha.toLowerCase(),
    runId: String(context.runId),
    runAttempt: String(context.runAttempt),
    server: baseUrl(context.serverUrl),
  };
}

function validateOptions(options, target) {
  requireValue(
    typeof options.sourceAttempt === 'string' &&
      decimalPattern.test(options.sourceAttempt) &&
      positive(Number(options.sourceAttempt)) &&
      Number(options.sourceAttempt) <= Number(target.runAttempt),
  );
  requireValue(['success', 'failure', 'cancelled', 'skipped'].includes(options.scanResult));
  requireValue(text(options.resultPath, 4096) && text(options.project, 400));
  requireValue(text(options.baseRef, 1024) && !/\s/.test(options.baseRef));
  return baseUrl(options.sonarUrl);
}

function capturedAt(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const parts = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/);
  return (
    parts &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === `${parts[1]}.${(parts[2] || '').padEnd(3, '0')}Z`
  );
}

async function readResult(filename) {
  const file = await fs.promises.open(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    const limit = 1024 * 1024;
    requireValue(stat.isFile() && stat.size <= limit);
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) {
        break;
      }
      size += bytesRead;
    }
    requireValue(size <= limit);
    return JSON.parse(buffer.toString('utf8', 0, size));
  } finally {
    await file.close();
  }
}

function validateResult(data, target, options, sonarUrl) {
  requireValue(
    data &&
      data.schema === 2 &&
      data.repository === target.repository &&
      typeof data.sha === 'string' &&
      shaPattern.test(data.sha) &&
      data.sha.toLowerCase() === target.sha &&
      data.baseRef === options.baseRef &&
      data.pr === target.pr &&
      data.runId === target.runId &&
      data.runAttempt === options.sourceAttempt &&
      data.project === options.project &&
      data.complete === true &&
      typeof data.passed === 'boolean' &&
      text(data.taskId, 200) &&
      /^[a-z0-9_-]+$/i.test(data.taskId) &&
      text(data.analysisId, 200) &&
      /^[a-z0-9_-]+$/i.test(data.analysisId) &&
      ['OK', 'ERROR', 'WARN', 'NONE'].includes(data.gateStatus) &&
      count(data.high) &&
      count(data.blocker),
  );
  requireValue(text(data.reportUrl, 4096) && !/[\s\\]/.test(data.reportUrl));
  const url = new URL(data.reportUrl);
  const expected = new URL(`${sonarUrl}/dashboard`);
  requireValue(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.href.length <= 4096 &&
      url.origin === expected.origin &&
      url.pathname === expected.pathname &&
      [...url.searchParams.keys()].sort().join(',') === 'id,pullRequest' &&
      url.searchParams.get('id') === data.project &&
      url.searchParams.get('pullRequest') === String(target.pr),
  );
  return data;
}

function validateDetails(data) {
  requireValue(
    typeof data.detailsComplete === 'boolean' &&
      Array.isArray(data.issues) &&
      data.issues.length <= 10,
  );
  if (!data.detailsComplete) {
    requireValue(
      data.totalIssues === null &&
        data.issues.length === 0 &&
        data.detailsScope === null &&
        data.detailsCapturedAt === null,
    );
  } else {
    requireValue(
      count(data.totalIssues) &&
        data.totalIssues >= data.issues.length &&
        data.detailsScope === 'current-pr' &&
        capturedAt(data.detailsCapturedAt),
    );
  }
  const keys = new Set();
  for (const issue of data.issues) {
    requireValue(
      issue &&
        text(issue.key, 400) &&
        !keys.has(issue.key) &&
        text(issue.rule, 400) &&
        typeof issue.message === 'string' &&
        issue.message.length <= 4000 &&
        (issue.path === undefined || text(issue.path, 2048, true)) &&
        (issue.line === undefined || issue.line === null || positive(issue.line)) &&
        Array.isArray(issue.impacts) &&
        issue.impacts.length <= 10 &&
        (issue.legacySeverity === undefined || text(issue.legacySeverity, 100, true)) &&
        (issue.legacyType === undefined || text(issue.legacyType, 100, true)),
    );
    requireValue(
      !issue.path ||
        (!issue.path.startsWith('/') &&
          !issue.path.includes('\\') &&
          !issue.path.split('/').some(part => ['.', '..', ''].includes(part))),
    );
    for (const impact of issue.impacts) {
      requireValue(
        impact && severities.includes(impact.severity) && text(impact.softwareQuality, 100),
      );
    }
    keys.add(issue.key);
  }
}

function escape(value) {
  return String(value ?? '')
    .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()|!~#]/g, '\\$&')
    .replace(/@/g, '&#64;');
}

function link(value) {
  return value.replace(
    /[()'<>]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function analysisFailure(evidence, scanResult) {
  if (evidence) {
    if (evidence.high > 0 || evidence.blocker > 0) {
      return `${evidence.high} High, ${evidence.blocker} Blocker issues`;
    }
    if (evidence.gateStatus !== 'OK') {
      return `quality gate did not pass (${evidence.gateStatus})`;
    }
  }
  const scanFailures = {
    failure: 'scan job failed',
    cancelled: 'scan was cancelled',
    skipped: 'scan was skipped',
  };
  if (scanFailures[scanResult]) {
    return scanFailures[scanResult];
  }
  if (!evidence) {
    return 'analysis result could not be verified';
  }
  return evidence.passed ? '' : 'analysis was not marked as passed';
}

function summary(target, options, evidence, passed, stale, retargeted, marker, reason) {
  const run = `${target.server}/${target.repository}/actions/runs/${target.runId}`;
  const scanUrl = `${run}/attempts/${options.sourceAttempt}`;
  const reportUrl = `${run}/attempts/${target.runAttempt}`;
  const commitUrl = `${target.server}/${target.repository}/commit/${target.sha}`;
  const lines = [
    marker,
    '### Sonar check',
    '',
    `**Sonar check: ${passed ? 'PASS' : 'FAIL — ' + reason + '.'}**`,
    '',
    `${evidence ? 'Analyzed' : 'Expected'} commit: [\`${target.sha.slice(0, 12)}\`](${commitUrl}). ` +
      `This result applies only to that commit.${stale ? ' The PR head has since changed.' : ''}`,
    '',
    `Target branch: **${escape(options.baseRef)}**.` +
      (retargeted
        ? ' The PR target branch has since changed; rerun the scan for the current target.'
        : ''),
    '',
  ];
  if (evidence) {
    lines.push(
      `Exact analysis quality gate: **${evidence.gateStatus}**. New High: **${evidence.high}**; ` +
        `new Blocker: **${evidence.blocker}**.`,
      '',
    );
    if (evidence.detailsComplete) {
      lines.push(
        `Current PR findings: **${evidence.totalIssues}** (collected at ${evidence.detailsCapturedAt}).`,
        'These advisory observations may differ from the analyzed commit and do not determine this check.',
        '',
        '| Finding | Location | Severity |',
        '| --- | --- | --- |',
      );
      const rank = issue =>
        Math.min(5, ...issue.impacts.map(impact => severities.indexOf(impact.severity)));
      let shown = 0;
      for (const issue of [...evidence.issues].sort((a, b) => rank(a) - rank(b))) {
        const path = issue.path || '';
        const location = new URL(evidence.reportUrl);
        location.pathname = location.pathname.replace(/\/dashboard$/, '/project/issues');
        location.searchParams.set('open', issue.key);
        const label = path
          ? `${path.slice(0, 180)}${issue.line ? `:${issue.line}` : ''}`
          : 'Project';
        const severity = issue.impacts
          .map(impact => `${impact.severity} ${impact.softwareQuality}`)
          .join(', ');
        const legacy = [issue.legacySeverity, issue.legacyType].filter(Boolean).join(' ');
        const row =
          `| ${escape(issue.rule)}: ${escape(issue.message.slice(0, 500))} | ` +
          `[${escape(label)}](${link(location.href)}) | ` +
          `${escape(severity || 'Unspecified')}${legacy ? ` (legacy: ${escape(legacy)})` : ''} |`;
        // Leave room under GitHub's comment limit for the report and run links.
        if (lines.join('\n').length + row.length > 48000) {
          break;
        }
        lines.push(row);
        shown++;
      }
      if (evidence.totalIssues === 0) {
        lines.push('| No current PR findings | - | - |');
      }
      if (evidence.totalIssues > shown) {
        lines.push('', `Showing ${shown} of ${evidence.totalIssues} issues; see the full report.`);
      }
    } else {
      lines.push(
        'Issue details are unavailable. The exact analysis quality gate and High/Blocker counts ' +
          'remain valid; see the full Sonar report.',
      );
    }
    lines.push(
      '',
      'The exact analysis fails for new High or Blocker issues. Medium findings alone do not fail it.',
      '',
      `[Full Sonar report](${link(evidence.reportUrl)})`,
    );
  }
  lines.push('', `[Scan run](${scanUrl})`);
  if (target.runAttempt !== options.sourceAttempt) {
    lines.push(`[Report retry](${reportUrl})`);
  }
  return lines.join('\n');
}

async function commentAuthor(github, actionsToken) {
  try {
    const { data: user } = await github.rest.users.getAuthenticated({ request });
    requireValue(user && positive(user.id) && text(user.login, 100));
    return comment => comment.user?.id === user.id && comment.user?.login === user.login;
  } catch (error) {
    // Installation tokens cannot use /user. Never treat an arbitrary bot as this reporter.
    if (error.status !== 403 || !actionsToken) {
      throw new Error('Unable to identify comment author');
    }
    return comment => comment.user?.type === 'Bot' && comment.user?.login === 'github-actions[bot]';
  }
}

async function publishComment(github, target, body, marker, actionsToken) {
  const owns = await commentAuthor(github, actionsToken);
  let existing;
  for (let page = 1; page <= 100; page++) {
    const { data: comments } = await github.rest.issues.listComments({
      owner: target.owner,
      repo: target.repo,
      issue_number: target.pr,
      per_page: 100,
      page,
      request,
    });
    requireValue(Array.isArray(comments));
    for (const comment of comments) {
      if (
        owns(comment) &&
        typeof comment.body === 'string' &&
        comment.body.startsWith(marker + '\n')
      ) {
        requireValue(!existing && positive(comment.id));
        existing = comment;
      }
    }
    if (comments.length < 100) {
      break;
    }
    requireValue(page < 100);
  }
  if (existing) {
    await github.rest.issues.updateComment({
      owner: target.owner,
      repo: target.repo,
      comment_id: existing.id,
      body,
      request,
    });
  } else {
    await github.rest.issues.createComment({
      owner: target.owner,
      repo: target.repo,
      issue_number: target.pr,
      body,
      request,
    });
  }
}

async function report({ github, core, context, options }) {
  let target;
  try {
    target = identity(context, options);
  } catch {
    core.setFailed('Invalid Sonar reporter identity; no publication target is safe.');
    return {
      passed: false,
      published: false,
      statusPublished: false,
    };
  }
  let evidence;
  let validOptions = false;
  try {
    const sonarUrl = validateOptions(options, target);
    validOptions = true;
    evidence = validateResult(await readResult(options.resultPath), target, options, sonarUrl);
    try {
      validateDetails(evidence);
    } catch {
      core.warning(
        'Invalid advisory Sonar details were omitted; the exact analysis result remains usable.',
      );
      evidence = {
        ...evidence,
        detailsComplete: false,
        totalIssues: null,
        issues: [],
        detailsScope: null,
        detailsCapturedAt: null,
      };
    }
  } catch {
    core.warning(
      validOptions
        ? 'Sonar analysis result could not be verified.'
        : 'Invalid Sonar reporting configuration.',
    );
  }
  let reason = validOptions
    ? analysisFailure(evidence, options.scanResult)
    : 'invalid reporting configuration';
  let passed = Boolean(
    evidence &&
      evidence.passed &&
      evidence.gateStatus === 'OK' &&
      evidence.high === 0 &&
      evidence.blocker === 0 &&
      options.scanResult === 'success',
  );
  let published = false;
  if (validOptions) {
    let prVerified = false;
    try {
      const { data: pr } = await github.rest.pulls.get({
        owner: target.owner,
        repo: target.repo,
        pull_number: target.pr,
        request,
      });
      requireValue(
        pr?.number === target.pr &&
          pr.base?.repo?.full_name === target.repository &&
          text(pr.base.ref, 1024) &&
          !/\s/.test(pr.base.ref) &&
          typeof pr.head?.sha === 'string' &&
          shaPattern.test(pr.head.sha),
      );
      prVerified = true;
      const retargeted = pr.base.ref !== options.baseRef;
      passed = passed && !retargeted;
      if (retargeted) {
        reason = 'target branch changed; rerun scan';
      }
      const marker = `<!-- sonar-check:${target.repository}:${target.pr}:${target.runId}:${options.sourceAttempt} -->`;
      const body = summary(
        target,
        options,
        evidence,
        passed,
        pr.head.sha.toLowerCase() !== target.sha,
        retargeted,
        marker,
        reason,
      );
      await publishComment(github, target, body, marker, options.actionsToken === true);
      published = true;
    } catch {
      reason = prVerified
        ? 'summary publication was not confirmed'
        : 'pull request could not be verified';
      core.warning(
        `Sonar ${reason}; no automatic retry was attempted.`,
      );
    }
  }
  // A failed or ambiguous comment write must never leave a successful status.
  passed = passed && published;
  let statusPublished = false;
  try {
    await github.rest.repos.createCommitStatus({
      owner: target.owner,
      repo: target.repo,
      sha: target.sha,
      context: 'Sonar check',
      state: passed ? 'success' : 'failure',
      description: passed
        ? 'Sonar passed: 0 High, 0 Blocker issues.'
        : `Sonar failed: ${reason}.`,
      target_url: `${target.server}/${target.repository}/actions/runs/${target.runId}/attempts/${target.runAttempt}`,
      request,
    });
    statusPublished = true;
  } catch {
    core.warning('Sonar status publication was not confirmed; no automatic retry was attempted.');
  }
  if (!passed || !statusPublished) {
    core.setFailed(
      `Sonar failed: ${statusPublished ? reason : 'status publication was not confirmed'}.`,
    );
  }
  return {
    passed: passed && statusPublished,
    published,
    statusPublished,
  };
}

module.exports = {
  report,
  optionsFromEnv,
};
