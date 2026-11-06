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

const {createHash} = require('node:crypto');
const {setTimeout: sleep} = require('node:timers/promises');
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const tagPattern = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/;
const indexTypes = new Set(['application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json']);
const imageTypes = new Set(['application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json']);

function optionsFromEnv(env) {
  const jsonArray = key => {
    let values;
    try { values = JSON.parse(env[key]); } catch { throw new Error(`${key} must be a JSON array`); }
    if (!Array.isArray(values)) throw new Error(`${key} must be a JSON array`);
    return values;
  };
  const integer = (key, min, max) => {
    const value = env[key];
    if (!/^\d+$/.test(value || '') || Number(value) < min || Number(value) > max) {
      throw new Error(`${key} must be an integer from ${min} to ${max}`);
    }
    return Number(value);
  };
  const patterns = key => {
    const values = jsonArray(key);
    if (values.some(v => typeof v !== 'string' ||
      !/^[a-zA-Z0-9_*][a-zA-Z0-9_.*-]{0,127}$/.test(v))) {
      throw new Error(`${key} must be a JSON array of tag patterns (only * is a wildcard)`);
    }
    return values;
  };
  const options = {
    owner: env.CLEANUP_OWNER, package: env.CLEANUP_PACKAGE, ownerType: env.CLEANUP_OWNER_TYPE,
    patterns: patterns('CLEANUP_PATTERNS'), protectedPatterns: patterns('CLEANUP_PROTECTED_PATTERNS'),
    protectedDigests: jsonArray('CLEANUP_PROTECTED_DIGESTS'),
    days: integer('CLEANUP_DAYS', 1, 3650), keep: integer('CLEANUP_KEEP', 0, 1000),
    limit: integer('CLEANUP_LIMIT', 1, 100), dryRun: env.CLEANUP_DRY_RUN === 'true',
    token: env.CLEANUP_TOKEN, actor: env.GITHUB_ACTOR,
  };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(options.owner || '') ||
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(options.package || '') ||
    !['organization', 'user'].includes(options.ownerType) || !options.patterns.length ||
    !Array.isArray(options.protectedDigests) || options.protectedDigests.some(v => !digestPattern.test(v)) ||
    !['true', 'false'].includes(env.CLEANUP_DRY_RUN) || !options.token || !options.actor) {
    throw new Error('Invalid GHCR cleanup inputs; owner, package, patterns, token and actor are required');
  }
  return options;
}

function matches(tag, patterns) {
  return patterns.some(pattern => new RegExp('^' + pattern.split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(tag));
}

function normalize(versions) {
  if (!Array.isArray(versions)) throw new Error('Invalid package version list');
  const ids = new Set();
  const digests = new Set();
  return versions.map(v => {
    const tags = v.metadata?.container?.tags;
    const created = Date.parse(v.created_at);
    const updated = Date.parse(v.updated_at);
    if (!Number.isSafeInteger(v.id) || v.id <= 0 || ids.has(v.id) ||
      typeof v.name !== 'string' || !digestPattern.test(v.name) || digests.has(v.name) ||
      !Array.isArray(tags) || tags.some(tag => typeof tag !== 'string' || !tagPattern.test(tag)) ||
      !Number.isFinite(created) || !Number.isFinite(updated)) {
      throw new Error('Incomplete or inconsistent package metadata; no cleanup is safe');
    }
    ids.add(v.id);
    digests.add(v.name);
    return {id: v.id, digest: v.name, tags: [...tags].sort(), created, updated,
      modified: Math.max(created, updated)};
  }).sort((a, b) => a.id - b.id);
}

async function plan(versions, options, manifest, now = Date.now()) {
  const eligible = versions.filter(v => v.tags.length &&
    v.tags.every(tag => matches(tag, options.patterns)) &&
    !v.tags.some(tag => matches(tag, options.protectedPatterns)) &&
    !options.protectedDigests.includes(v.digest)).sort((a, b) => b.modified - a.modified || b.id - a.id);
  const cutoff = now - options.days * 86400000;
  const candidates = eligible.slice(options.keep).filter(v => v.modified < cutoff)
    .reverse().slice(0, options.limit);
  if (!candidates.length) return [];
  const removable = new Set(candidates.map(v => v.digest));
  const retained = new Set();
  // Untagged versions and candidates outside the batch remain roots too. Never
  // delete a platform/attestation manifest still referenced by any retained root.
  const pending = versions.filter(v => !removable.has(v.digest)).map(v => v.digest)
    .concat(options.protectedDigests);
  while (pending.length) {
    const digest = pending.pop();
    if (retained.has(digest)) continue;
    if (!digestPattern.test(digest) || retained.size >= 10000) throw new Error('Invalid or oversized manifest graph');
    retained.add(digest);
    const value = await manifest(digest);
    if (value.schemaVersion !== 2 || (!indexTypes.has(value.mediaType) && !imageTypes.has(value.mediaType))) {
      throw new Error(`Unsupported manifest ${digest}; no cleanup is safe`);
    }
    if (indexTypes.has(value.mediaType)) {
      if (!Array.isArray(value.manifests) || !value.manifests.length ||
        value.manifests.some(child => !digestPattern.test(child.digest))) {
        throw new Error(`Invalid manifest index ${digest}`);
      }
      pending.push(...value.manifests.map(child => child.digest));
    } else if (!value.config || !Array.isArray(value.layers)) {
      throw new Error(`Incomplete image manifest ${digest}`);
    }
    if (value.subject) {
      if (!digestPattern.test(value.subject.digest)) throw new Error(`Invalid manifest subject ${digest}`);
      pending.push(value.subject.digest);
    }
  }
  return candidates.filter(v => !retained.has(v.digest));
}

async function readWithRetry(read, wait = sleep) {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); } catch (error) {
      const status = error.status;
      if (attempt === 2 || (status !== undefined && status !== 408 && status !== 429 && status < 500)) throw error;
      const retryAfter = error.response?.headers?.['retry-after'];
      const hinted = retryAfter === undefined ? 0 : /^\d+$/.test(retryAfter) ?
        Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
      // Do not ignore a long server-requested pause or wait without a bound.
      if (!Number.isFinite(hinted) || hinted > 30000) throw error;
      await wait(Math.max(1000 * (attempt + 1), hinted));
    }
  }
}

function registryReader(options, fetchImpl, wait) {
  let token;
  const repository = `${options.owner.toLowerCase()}/${options.package}`;
  async function read(url, headers) {
    return readWithRetry(async () => {
      let response;
      try {
        response = await fetchImpl(url, {headers, redirect: 'error', signal: AbortSignal.timeout(30000)});
      } catch {
        throw new Error('GHCR read failed or timed out');
      }
      if (!response.ok) {
        const error = new Error(`GHCR read returned HTTP ${response.status}; no cleanup is safe`);
        error.status = response.status;
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter !== null) error.response = {headers: {'retry-after': retryAfter}};
        throw error;
      }
      return response.text();
    }, wait);
  }
  return async digest => {
    if (!token) {
      const query = new URLSearchParams({service: 'ghcr.io', scope: `repository:${repository}:pull`});
      const auth = Buffer.from(`${options.actor}:${options.token}`).toString('base64');
      const data = JSON.parse(await read(`https://ghcr.io/token?${query}`, {Authorization: `Basic ${auth}`}));
      token = data.token || data.access_token;
      if (typeof token !== 'string' || !token) throw new Error('GHCR did not return a read token');
    }
    const text = await read(`https://ghcr.io/v2/${repository}/manifests/${digest}`, {
      Authorization: `Bearer ${token}`, Accept: [...indexTypes, ...imageTypes].join(', '),
    });
    if (`sha256:${createHash('sha256').update(text).digest('hex')}` !== digest) {
      throw new Error(`Registry content does not match ${digest}`);
    }
    return JSON.parse(text);
  };
}

async function cleanup({github, core, options, fetchImpl = fetch, wait = sleep, now = Date.now()}) {
  const base = `/${options.ownerType === 'organization' ? 'orgs' : 'users'}/${encodeURIComponent(options.owner)}` +
    `/packages/container/${encodeURIComponent(options.package)}/versions`;
  const get = route => readWithRetry(() => github.request(`GET ${route}`, {request: {timeout: 30000}}), wait);
  async function list() {
    const versions = [];
    for (let page = 1; page <= 100; page++) {
      const {data} = await get(`${base}?state=active&per_page=100&page=${page}`);
      if (!Array.isArray(data) || data.length > 100) throw new Error('Invalid package pagination');
      versions.push(...data);
      if (data.length < 100) return normalize(versions);
    }
    throw new Error('Package exceeds the 10,000-version scan limit; no cleanup performed');
  }

  core.setOutput('deleted', 0);
  const initial = await list();
  const candidates = await plan(initial, options, registryReader(options, fetchImpl, wait), now);
  core.setOutput('candidates', candidates.length);
  core.info(`${options.dryRun ? 'Dry run' : 'Cleanup'}: ${options.owner}/${options.package}; ` +
    `${initial.length} versions, ${candidates.length} eligible, retention ${options.days} days, limit ${options.limit}`);
  for (const v of candidates) core.info(`Candidate ${v.id}: ${v.digest} [${v.tags.join(', ')}]`);
  await core.summary.addHeading('Image cleanup').addRaw(
    `${options.owner}/${options.package}: ${options.dryRun ? 'dry run' : 'deletion enabled'}. ` +
    `${candidates.length} eligible versions older than ${options.days} days.\n\n` +
    candidates.map(v => `- ${v.id}: \`${v.digest}\` (${v.tags.join(', ')})`).join('\n') + '\n').write();
  if (options.dryRun || !candidates.length) return;

  // The caller must serialize publishers and cleanup. Also reject changes seen
  // during planning and recheck each version immediately before its DELETE.
  if (JSON.stringify(await list()) !== JSON.stringify(initial)) {
    throw new Error('Package changed during planning; no versions deleted. Retry after publishers finish.');
  }
  let deleted = 0;
  for (const candidate of candidates) {
    const {data} = await get(`${base}/${candidate.id}`);
    if (JSON.stringify(normalize([data])[0]) !== JSON.stringify(candidate)) {
      throw new Error(`Version ${candidate.id} changed; stopping after ${deleted} deletions`);
    }
    try {
      const result = await github.request(`DELETE ${base}/${candidate.id}`, {request: {timeout: 30000}});
      if (result.status !== 204) throw new Error('Unexpected DELETE response');
    } catch (error) {
      const status = Number.isInteger(error.status) ? `HTTP ${error.status}` : 'transport or unexpected response';
      throw new Error(`DELETE ${base}/${candidate.id}: ${status}, failed or uncertain outcome; ` +
        `not retried. ${deleted} prior deletions confirmed. Inspect package permissions and version state.`);
    }
    deleted++;
    core.setOutput('deleted', deleted);
    core.info(`Deleted version ${candidate.id}: ${candidate.digest}`);
  }
  await core.summary.addRaw(`\nDeleted ${deleted} versions.\n`).write();
}

module.exports = {cleanup, optionsFromEnv, normalize, plan, readWithRetry};
