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
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {spawnSync} = require('node:child_process');
const {cleanup, optionsFromEnv, normalize, plan, readWithRetry} = require('../index');
const {selectSuites} = require('../../workflow-suite-selector/index');
const now = Date.parse('2026-11-06T00:00:00Z');
const old = '2026-09-01T00:00:00Z';
const recent = '2026-11-05T00:00:00Z';
const sha = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const imageType = 'application/vnd.oci.image.manifest.v1+json';
const indexType = 'application/vnd.oci.image.index.v1+json';
const env = {
  CLEANUP_OWNER: 'test-org', CLEANUP_PACKAGE: 'project/build-image', CLEANUP_OWNER_TYPE: 'organization',
  CLEANUP_PATTERNS: '["build-*"]', CLEANUP_PROTECTED_PATTERNS: '[]', CLEANUP_PROTECTED_DIGESTS: '[]',
  CLEANUP_DAYS: '30', CLEANUP_KEEP: '0', CLEANUP_LIMIT: '20', CLEANUP_DRY_RUN: 'true',
  CLEANUP_TOKEN: 'test-secret', GITHUB_ACTOR: 'test-actor',
};

function fixture() {
  const f = {versions: [], manifests: new Map(), requests: [], fetched: [], outputs: {}, logs: [],
    options: optionsFromEnv(env), waits: [], listReads: 0};
  f.add = (id, tags, modified = old, children) => {
    const manifest = children ? {schemaVersion: 2, mediaType: indexType,
      manifests: children.map(digest => ({digest, mediaType: imageType, size: 100}))} :
      {schemaVersion: 2, mediaType: imageType, config: {digest: sha(`config-${id}`)}, layers: []};
    // Distinct leaf manifests without relying on registry state.
    if (!children) manifest.annotations = {fixture: String(id)};
    const text = JSON.stringify(manifest);
    const digest = sha(text);
    f.manifests.set(digest, text);
    const v = {id, name: digest, created_at: modified, updated_at: modified,
      metadata: {container: {tags}}};
    f.versions.push(v);
    return digest;
  };
  f.github = {request: async (route, options) => {
    f.requests.push(route);
    assert.equal(options.request.timeout, 30000);
    if (f.onRequest) {
      const result = await f.onRequest(route);
      if (result !== undefined) return result;
    }
    if (route.startsWith('DELETE ')) return {status: 204};
    if (route.includes('?')) {
      f.listReads++;
      const page = Number(new URL(`https://api.github.com${route.slice(4)}`).searchParams.get('page'));
      return {data: structuredClone(f.versions.slice((page - 1) * 100, page * 100))};
    }
    const id = Number(route.split('/').pop());
    return {data: structuredClone(f.versions.find(v => v.id === id))};
  }};
  f.fetch = async (url, options) => {
    f.fetched.push(url);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    if (url.startsWith('https://ghcr.io/token?')) {
      assert.match(options.headers.Authorization, /^Basic /);
      return new Response(JSON.stringify({token: 'registry-secret'}));
    }
    assert.equal(options.headers.Authorization, 'Bearer registry-secret');
    const digest = url.split('/').pop();
    return new Response(f.manifests.get(digest) || '', {status: f.manifests.has(digest) ? 200 : 404});
  };
  const summary = {addHeading: () => summary, addRaw: text => {f.logs.push(text); return summary;}, write: async () => {}};
  f.core = {info: text => f.logs.push(text), setOutput: (key, value) => {f.outputs[key] = value;}, summary};
  f.run = () => cleanup({github: f.github, core: f.core, options: f.options,
    fetchImpl: f.fetch, wait: async ms => f.waits.push(ms), now});
  f.deletes = () => f.requests.filter(r => r.startsWith('DELETE '));
  return f;
}

test('dry run reports old build-only versions, never deletes or leaks credentials', async () => {
  const f = fixture();
  f.add(1, ['build-old']); f.add(2, ['v1']); f.add(3, ['build-new'], recent);
  await f.run();
  assert.equal(f.outputs.candidates, 1);
  assert.equal(f.outputs.deleted, 0);
  assert.equal(f.deletes().length, 0);
  assert.match(f.logs.join('\n'), /Candidate 1:/);
  assert.doesNotMatch(f.logs.join('\n'), /test-secret|registry-secret/);
});

test('deletion requires every tag to match; live main, release, v1 and cache aliases survive', async () => {
  const f = fixture(); f.options.dryRun = false;
  f.add(1, ['build-delete', 'build-also-delete']);
  for (const [i, tag] of ['main-cuda13', '26.10-cuda12', 'v1', 'cache-amd64'].entries()) {
    f.add(i + 2, ['build-shared', tag]);
  }
  f.add(6, []);
  await f.run();
  assert.deepEqual(f.deletes(), ['DELETE /orgs/test-org/packages/container/project%2Fbuild-image/versions/1']);
  assert.equal(f.listReads, 2);
  assert.equal(f.outputs.deleted, 1);
});

test('consumer patterns, protected tags/digests, retention and keep-latest are honored', async () => {
  const f = fixture();
  f.options.patterns = ['preview-*', 'build-*'];
  f.options.protectedPatterns = ['preview-pinned*'];
  f.options.keep = 1;
  f.add(1, ['preview-old']);
  f.add(2, ['preview-pinned-for-release']);
  const pinned = f.add(3, ['build-pinned-digest']); f.options.protectedDigests = [pinned];
  f.add(4, ['preview-newest'], recent);
  f.add(5, ['build-updated']); f.versions.at(-1).updated_at = recent;
  await f.run();
  assert.equal(f.outputs.candidates, 1);
  f.options.days = 100;
  await f.run();
  assert.equal(f.outputs.candidates, 0);
});

test('bounded deletion retains candidates outside the batch and their manifest dependencies', async () => {
  const f = fixture(); f.options.limit = 1;
  const leaf = f.add(1, ['build-leaf']);
  f.add(2, ['build-index'], old, [leaf]);
  await f.run();
  assert.equal(f.outputs.candidates, 0, 'retained index references first candidate');
});

test('retained indexes protect transitive platform and attestation manifests regardless of tags', async () => {
  const f = fixture(); f.options.dryRun = false;
  const platform = f.add(1, ['build-amd64']);
  const attestation = f.add(2, ['build-attestation']);
  const nested = f.add(3, ['build-nested'], old, [platform, attestation]);
  f.add(4, ['main', 'build-root'], old, [nested]);
  f.add(5, ['build-disposable']);
  await f.run();
  assert.equal(f.outputs.candidates, 1);
  assert.match(f.deletes()[0], /\/5$/);
  assert.equal(f.fetched.filter(url => url.includes('/manifests/')).length, 4);
});

test('retained untagged indexes also protect tagged descendants', async () => {
  const f = fixture();
  const child = f.add(1, ['build-child']);
  f.add(2, [], old, [child]);
  await f.run();
  assert.equal(f.outputs.candidates, 0);
});

test('complete pagination includes protected tags on later pages', async () => {
  const f = fixture();
  const child = f.add(1, ['build-old']);
  for (let id = 2; id <= 100; id++) f.add(id, []);
  f.add(101, ['main'], old, [child]);
  await f.run();
  assert.equal(f.listReads, 2);
  assert.equal(f.outputs.candidates, 0);
});

test('duplicate/incomplete metadata fails closed before deletion', async () => {
  for (const corrupt of [v => {v.updated_at = null;}, v => {delete v.metadata;},
    v => {v.name = 'unknown';}, v => {v.metadata.container.tags = ['bad tag'];}]) {
    const f = fixture(); f.options.dryRun = false; f.add(1, ['build-old']);
    corrupt(f.versions[0]);
    await assert.rejects(f.run(), /metadata/);
    assert.equal(f.deletes().length, 0);
  }
  const f = fixture(); f.add(1, ['build-old']); f.versions.push(f.versions[0]);
  await assert.rejects(f.run(), /metadata/);
});

test('registry failures, unsupported manifests and content mismatches never authorize deletion', async () => {
  for (const mode of ['missing', 'mismatch', 'unsupported']) {
    const f = fixture(); f.options.dryRun = false;
    f.add(1, ['build-old']);
    let root = f.add(2, ['v1']);
    if (mode === 'missing') f.manifests.delete(root);
    if (mode === 'mismatch') f.manifests.set(root, '{}');
    if (mode === 'unsupported') {
      const value = JSON.stringify({schemaVersion: 3}); root = sha(value);
      f.versions[1].name = root; f.manifests.set(root, value);
    }
    await assert.rejects(f.run(), /HTTP 404|does not match|Unsupported manifest/);
    assert.equal(f.deletes().length, 0);
  }
});

test('a package changing during planning stops before any mutation', async () => {
  const f = fixture(); f.options.dryRun = false; f.add(1, ['build-old']);
  f.onRequest = route => {
    if (route.includes('?') && f.listReads === 1) f.versions[0].metadata.container.tags.push('main');
  };
  await assert.rejects(f.run(), /Package changed/);
  assert.equal(f.deletes().length, 0);
});

test('a newly added alias on a candidate stops the immediate pre-delete check', async () => {
  const f = fixture(); f.options.dryRun = false; f.add(1, ['build-old']);
  f.onRequest = route => {
    if (route.startsWith('GET ') && route.endsWith('/1')) f.versions[0].metadata.container.tags.push('26.12');
  };
  await assert.rejects(f.run(), /Version 1 changed/);
  assert.equal(f.deletes().length, 0);
});

test('an ambiguous DELETE is never repeated and reports confirmed prior progress', async () => {
  const f = fixture(); f.options.dryRun = false;
  f.add(1, ['build-one']); f.add(2, ['build-two']);
  f.onRequest = route => {if (route.startsWith('DELETE ') && route.endsWith('/2')) throw new Error('timeout');};
  await assert.rejects(f.run(), /not retried. 1 prior deletions confirmed/);
  assert.equal(f.deletes().length, 2);
  assert.equal(f.outputs.deleted, 1);
});

test('read retries are bounded; permanent auth failures stop immediately', async () => {
  const waits = []; let calls = 0;
  const result = await readWithRetry(async () => {
    if (++calls < 3) throw Object.assign(new Error('busy'), {status: 503});
    return 'ok';
  }, async ms => waits.push(ms));
  assert.equal(result, 'ok'); assert.deepEqual(waits, [1000, 2000]);
  for (const status of [401, 403, 404, 429, 503]) {
    calls = 0;
    await assert.rejects(readWithRetry(async () => {
      calls++; throw Object.assign(new Error('failed'), {status});
    }, async () => {}), /failed/);
    assert.equal(calls, status >= 429 ? 3 : 1);
  }
});

test('API authorization failures cannot become empty inventories', async () => {
  const f = fixture(); f.options.dryRun = false;
  f.onRequest = () => {throw Object.assign(new Error('forbidden'), {status: 403});};
  await assert.rejects(f.run(), /forbidden/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.deletes().length, 0);
});

test('retry-after is honored within the read budget, otherwise cleanup stops', async () => {
  for (const hint of ['3', '120', 'invalid']) {
    let calls = 0; const waits = [];
    const request = () => readWithRetry(async () => {
      if (++calls === 1) throw Object.assign(new Error('rate limited'), {
        status: 429, response: {headers: {'retry-after': hint}},
      });
      return 'ok';
    }, async ms => waits.push(ms));
    if (hint === '3') {assert.equal(await request(), 'ok'); assert.deepEqual(waits, [3000]);}
    else {await assert.rejects(request(), /rate limited/); assert.equal(calls, 1);}
  }
});

test('DELETE permission error includes endpoint and status without echoing server secrets', async () => {
  const f = fixture(); f.options.dryRun = false; f.add(1, ['build-old']);
  f.onRequest = route => {
    if (route.startsWith('DELETE ')) throw Object.assign(new Error('test-secret'), {status: 403});
  };
  await assert.rejects(f.run(), error => {
    assert.match(error.message, /DELETE \/orgs\/test-org\/packages\/container\/project%2Fbuild-image\/versions\/1: HTTP 403/);
    assert.doesNotMatch(error.message, /test-secret/);
    return true;
  });
  assert.equal(f.deletes().length, 1);
});

test('empty or entirely recent inventories require no registry access', async () => {
  const f = fixture(); await f.run(); assert.equal(f.outputs.candidates, 0);
  f.add(1, ['build-new'], recent); await f.run();
  assert.equal(f.fetched.length, 0);
});

test('bad caller settings fail before API calls and user-owned packages have a distinct route', async () => {
  for (const changes of [
    {CLEANUP_DRY_RUN: 'yes'}, {CLEANUP_DAYS: '0'}, {CLEANUP_DAYS: '-1'}, {CLEANUP_DAYS: '1.5'},
    {CLEANUP_KEEP: '-1'}, {CLEANUP_LIMIT: '0'}, {CLEANUP_LIMIT: '101'},
    {CLEANUP_PATTERNS: '[]'}, {CLEANUP_PATTERNS: 'not json'}, {CLEANUP_PATTERNS: '["!main"]'},
    {CLEANUP_PACKAGE: '../bad'}, {CLEANUP_OWNER_TYPE: 'enterprise'},
    {CLEANUP_PROTECTED_DIGESTS: '["bad"]'}, {CLEANUP_TOKEN: ''},
  ]) assert.throws(() => optionsFromEnv({...env, ...changes}));
  const f = fixture(); f.options.ownerType = 'user'; await f.run();
  assert.match(f.requests[0], /^GET \/users\/test-org\//);
});

test('configuration is not parsed at module load; selected work rejects missing inputs clearly', () => {
  const result = spawnSync(process.execPath, ['-e',
    'require(process.argv[1]); process.stdout.write("loaded")', path.resolve(__dirname, '../index.js')],
  {encoding: 'utf8', env: {}, timeout: 10000});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'loaded');
  assert.throws(() => optionsFromEnv({}), /CLEANUP_PATTERNS must be a JSON array/);
});

test('OCI subject references and cyclic indexes are traversed once', async () => {
  const versions = normalize([{id: 1, name: sha('child'), created_at: old, updated_at: old,
    metadata: {container: {tags: ['build-child']}}},
  {id: 2, name: sha('root'), created_at: old, updated_at: old, metadata: {container: {tags: ['main']}}}]);
  let reads = 0;
  const candidates = await plan(versions, optionsFromEnv(env), async digest => {
    reads++;
    return {schemaVersion: 2, mediaType: imageType, config: {}, layers: [],
      subject: {digest: digest === sha('root') ? sha('child') : sha('root')}};
  }, now);
  assert.equal(candidates.length, 0); assert.equal(reads, 2);
});

test('cleanup folder and workflow select the existing required image-tooling suite', () => {
  const catalog = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../.github/cpu-ci-suites.json')));
  for (const file of ['ghcr-cleanup/index.js', 'ghcr-cleanup/action.yml',
    'ghcr-cleanup/test/cleanup.test.js', '.github/workflows/image-cleanup.yml']) {
    assert.ok(selectSuites([{filename: file}], catalog).includes('image-tooling'));
  }
  assert.ok(catalog.suites['image-tooling'].jobs.includes('image-tooling'));
});
