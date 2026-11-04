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
const {spawnSync} = require('node:child_process');
const {test} = require('node:test');

const digest = 'sha256:' + 'a'.repeat(64);
const reference = 'ghcr.io/example/consumer/toolchain@' + digest;
const consumerTag = 'ghcr.io/example/consumer/toolchain:test';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'container-image-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const caller = path.join(root, '.docker');
  for (const directory of ['bin', 'tmp', '.docker/contexts', '.docker/cli-plugins', '.docker/buildx']) {
    fs.mkdirSync(path.join(root, directory), {recursive: true});
  }
  for (const command of ['docker', 'timeout', 'sleep']) {
    const target = path.join(root, 'bin', command);
    fs.copyFileSync(path.join(__dirname, 'fixtures/commands.js'), target);
    fs.chmodSync(target, 0o755);
  }
  const original = {
    currentContext: 'caller-context', credsStore: 'fixture-helper',
    credHelpers: {'ghcr.io': 'fixture-helper', 'private.example': 'private-helper'},
    auths: {'ghcr.io': {auth: 'b2xkOm9sZA=='}, 'private.example': {auth: 'cHJpdmF0ZTpwYXNz'}},
  };
  const configFile = path.join(caller, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(original));
  fs.writeFileSync(path.join(root, 'Dockerfile'), 'FROM scratch\n');
  fs.writeFileSync(path.join(root, 'smoke.sh'), '#!/usr/bin/env bash\nexec docker smoke "$@"\n');
  const config = {
    image: 'toolchain', tag: 'test', version: '26.12.0-SNAPSHOT', context: '.',
    dockerfile: 'Dockerfile', platforms: ['linux/amd64', 'linux/arm64'],
    'build-args': {TEXT: 'first line\nsecond line', COUNT: 8, FLAG: false},
    'smoke-test': 'smoke.sh', 'smoke-args': ['13.4.3', 'two words'],
  };
  const env = {
    PATH: [path.join(root, 'bin'), path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
    HOME: root, TMPDIR: path.join(root, 'tmp'), DOCKER_CONFIG: caller,
    DOCKER_AUTH_CONFIG: '{"auths":{"ghcr.io":{"auth":"old"}}}',
    GITHUB_REPOSITORY: 'example/consumer', GITHUB_SHA: 'b'.repeat(40),
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_STEP_SUMMARY: path.join(root, 'summary'),
    GHCR_USER: 'fixture-user', GHCR_TOKEN: 'fixture-token',
    MOCK_EVENTS: path.join(root, 'events'),
  };
  return {
    root, caller, config, env, original,
    run(overrides = {}, {entrypoint = 'action'} = {}) {
      const environment = {...env, IMAGE_CONFIG: JSON.stringify(config), PUBLISH_IMAGE: 'true', ...overrides};
      if (entrypoint === 'action') {
        environment.INPUT_CONFIG = environment.IMAGE_CONFIG;
        environment.INPUT_PUBLISH = environment.PUBLISH_IMAGE;
        environment.INPUT_TOKEN = environment.GHCR_TOKEN;
        environment.GITHUB_ACTOR = environment.GHCR_USER;
        for (const key of ['IMAGE_CONFIG', 'PUBLISH_IMAGE', 'GHCR_TOKEN', 'GHCR_USER']) delete environment[key];
      }
      const result = spawnSync(entrypoint === 'action' ? process.execPath : 'bash',
        [path.join(__dirname, entrypoint === 'action' ? '../index.js' : '../image.sh')], {
        cwd: root, encoding: 'utf8', timeout: 15000,
        env: environment,
      });
      assert.ifError(result.error);
      const events = fs.existsSync(env.MOCK_EVENTS) ?
        fs.readFileSync(env.MOCK_EVENTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
      assert.equal(fs.readFileSync(configFile, 'utf8'), JSON.stringify(original));
      assert.deepEqual(fs.readdirSync(env.TMPDIR), [], 'temporary credentials must be removed');
      const summary = fs.existsSync(env.GITHUB_STEP_SUMMARY) ?
        fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8') : '';
      const docker = events.filter(e => e.command === 'docker');
      assert.ok(docker.every(e => !['login', 'logout'].includes(e.args[0])));
      return {...result, events, docker, summary};
    },
  };
}

const builds = result => result.docker.filter(e => e.args[0] === 'buildx' && e.args[1] === 'build');
const pulls = result => result.docker.filter(e => e.args[0] === '--config');
const smokes = result => result.docker.filter(e => e.args[0] === 'smoke');
const promotions = result => result.docker.filter(e => e.args[1] === 'imagetools');

test('publication isolates credentials and promotes the verified digest after every smoke check', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(builds(result).length, 1);
  assert.equal(promotions(result).length, 1);
  assert.equal(result.docker.at(-1), promotions(result)[0]);
  assert.ok(builds(result)[0].args.includes('--push'));
  assert.ok(builds(result)[0].args.includes('--no-cache'));
  assert.ok(!builds(result)[0].args.includes('--cache-from'));
  assert.ok(!builds(result)[0].args.includes('--cache-to'));
  assert.ok(builds(result)[0].args.includes('TEXT=first line\nsecond line'));
  assert.ok(builds(result)[0].args.includes('COUNT=8'));
  assert.ok(builds(result)[0].args.includes('FLAG=false'));
  assert.deepEqual(promotions(result)[0].args,
    ['buildx', 'imagetools', 'create', '--prefer-index=false', '--tag', consumerTag, reference]);
  assert.deepEqual(smokes(result).map(e => e.args),
    f.config.platforms.map(platform => ['smoke', reference, platform, '13.4.3', 'two words']));
  assert.equal(pulls(result).length, 2);
  for (const event of result.docker) {
    assert.notEqual(event.directory, f.caller);
    assert.equal(event.config.currentContext, f.original.currentContext);
    assert.equal(event.buildx, path.join(f.caller, 'buildx'));
    assert.equal(event.certs, f.caller);
    assert.equal(event.contexts, fs.realpathSync(path.join(f.caller, 'contexts')));
    assert.equal(event.plugins, fs.realpathSync(path.join(f.caller, 'cli-plugins')));
    assert.equal(event.authOverride, null);
    if (event.args[0] === '--config') {
      assert.deepEqual(event.config.auths, {'ghcr.io': {}});
      assert.equal(event.config.credsStore, undefined);
      assert.equal(event.config.credHelpers, undefined);
      assert.equal(event.args.at(-1), reference);
    } else {
      assert.equal(event.config.auths['ghcr.io'].auth,
        Buffer.from('fixture-user:fixture-token').toString('base64'));
      assert.equal(event.config.credHelpers['ghcr.io'], '');
      assert.equal(event.config.credsStore, f.original.credsStore);
      assert.deepEqual(event.config.auths['private.example'], f.original.auths['private.example']);
      assert.equal(event.config.credHelpers['private.example'], 'private-helper');
    }
    assert.equal(fs.existsSync(event.directory), false);
  }
  assert.match(result.summary, /Published ghcr.io\/example\/consumer\/toolchain:test/);
});

test('explicit Buildx and TLS paths are preserved', t => {
  const f = fixture(t);
  const result = f.run({BUILDX_CONFIG: '/custom/buildx', DOCKER_CERT_PATH: '/custom/certs'});
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.docker.every(e => e.buildx === '/custom/buildx' && e.certs === '/custom/certs'));
});

test('validation builds and checks each platform without credentials or registry operations', t => {
  const f = fixture(t);
  const result = f.run({PUBLISH_IMAGE: 'false', GHCR_USER: '', GHCR_TOKEN: ''});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(builds(result).length, 2);
  assert.ok(builds(result).every(e => e.args.includes('--load') && !e.args.includes('--push')));
  assert.equal(pulls(result).length, 0);
  assert.equal(promotions(result).length, 0);
  assert.equal(smokes(result).length, 2);
  assert.ok(result.docker.every(e => e.directory === f.caller));
  assert.match(result.summary, /No image published/);
});

test('single-platform configuration and optional argument defaults are accepted', t => {
  const f = fixture(t);
  delete f.config.platforms;
  delete f.config.version;
  delete f.config['build-args'];
  delete f.config['smoke-args'];
  f.config.platform = 'linux/amd64';
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(pulls(result).length, 1);
  assert.deepEqual(smokes(result)[0].args, ['smoke', reference, 'linux/amd64']);
  assert.ok(builds(result)[0].args.includes('org.opencontainers.image.version=test'));
});

test('delayed anonymous visibility retries only reads before one promotion', t => {
  const result = fixture(t).run({MOCK_PULL_FAILURES: '2'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(builds(result).length, 1);
  assert.equal(pulls(result).length, 6);
  assert.equal(result.events.filter(e => e.command === 'sleep').length, 4);
  assert.equal(promotions(result).length, 1);
});

for (const failure of ['build', 'missing-metadata', 'bad-digest', 'pull-arm64',
  'pull-timeout', 'smoke-arm64']) {
  test(failure + ' fails without promoting the consumer tag or leaking credentials', t => {
    const result = fixture(t).run({MOCK_FAILURE: failure});
    assert.notEqual(result.status, 0);
    assert.equal(builds(result).length, 1, 'builds/pushes are never retried');
    assert.equal(promotions(result).length, 0);
    assert.doesNotMatch(result.summary, /Published/);
    if (failure === 'pull-arm64' || failure === 'pull-timeout') {
      assert.equal(pulls(result).length, failure === 'pull-arm64' ? 4 : 3);
      assert.match(result.stdout, /Consumer tag .* was not updated/);
    }
    if (failure === 'smoke-arm64') assert.equal(smokes(result).length, 2);
  });
}

test('promotion failure is reported without retrying a registry mutation', t => {
  const result = fixture(t).run({MOCK_FAILURE: 'promotion'});
  assert.equal(result.status, 45);
  assert.equal(promotions(result).length, 1);
  assert.doesNotMatch(result.summary, /Published/);
});

test('invalid configuration fails before invoking Docker', t => {
  const f = fixture(t);
  f.config.platforms = ['linux/amd64', 'linux/amd64'];
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.events.length, 0);
});

test('validation forwards every cache option without splitting its value', t => {
  const f = fixture(t);
  f.config['cache-from'] = ['type=gha,version=2,scope=toolchain,timeout=2m',
    'type=local,src=/tmp/cache with spaces'];
  f.config['cache-to'] = ['type=gha,version=2,scope=toolchain,timeout=2m,ignore-error=true'];
  const result = f.run({PUBLISH_IMAGE: 'false'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(builds(result).length, 2);
  for (const build of builds(result)) {
    for (const option of ['cache-from', 'cache-to']) {
      assert.deepEqual(build.args.flatMap((argument, i) =>
        argument === '--' + option ? [build.args[i + 1]] : []), f.config[option]);
    }
    assert.ok(!build.args.includes('--no-cache'));
  }
  assert.equal(promotions(result).length, 0);
});

test('publishing can export a baseline without enabling cached publication', t => {
  const f = fixture(t);
  f.config['cache-to'] = ['type=gha,version=2,scope=toolchain,timeout=2m,ignore-error=true'];
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(builds(result).length, 1);
  assert.ok(builds(result)[0].args.includes('--no-cache'));
  assert.ok(builds(result)[0].args.includes('--pull'));
  assert.equal(builds(result)[0].args[builds(result)[0].args.indexOf('--cache-to') + 1],
    f.config['cache-to'][0]);
  assert.equal(promotions(result).length, 1);
});

test('action passes cache runtime credentials without writing job-wide environment', t => {
  const f = fixture(t);
  f.config['cache-from'] = ['type=gha,version=2,scope=toolchain,timeout=2m'];
  const githubEnv = path.join(f.root, 'github-env');
  fs.writeFileSync(githubEnv, 'EXISTING=value\n');
  const result = f.run({PUBLISH_IMAGE: 'false', GITHUB_ENV: githubEnv,
    ACTIONS_RUNTIME_TOKEN: 'test-runtime-token', ACTIONS_RESULTS_URL: 'https://cache.example.test'});
  assert.equal(result.status, 0, result.stderr);
  assert.ok(builds(result).every(e => e.hasRuntimeToken && e.resultsUrl === 'https://cache.example.test'));
  assert.equal(fs.readFileSync(githubEnv, 'utf8'), 'EXISTING=value\n');
  assert.ok(!result.stdout.includes('test-runtime-token'));
  assert.ok(!result.stderr.includes('test-runtime-token'));
});

test('invalid cache settings fail before Docker runs', t => {
  const f = fixture(t);
  for (const option of ['cache-from', 'cache-to']) {
    for (const invalid of ['type=gha', false, true, {}, [42], [''], [' '], ['type=gha\n'], ['type=gha\u0000'], ['type=gha\u007f']]) {
      const result = f.run({IMAGE_CONFIG: JSON.stringify({...f.config, [option]: invalid})});
      assert.notEqual(result.status, 0);
      assert.equal(result.events.length, 0);
    }
  }
});

test('cache-enabled build failure stays single-shot and never promotes', t => {
  const f = fixture(t);
  f.config['cache-from'] = ['type=gha,version=2,scope=toolchain,timeout=2m'];
  const result = f.run({MOCK_FAILURE: 'build'});
  assert.equal(result.status, 42);
  assert.equal(builds(result).length, 1);
  assert.equal(promotions(result).length, 0);
});

for (const publish of ['false', 'true']) {
  test('standalone shell entry point remains compatible: publish=' + publish, t => {
    const result = fixture(t).run({PUBLISH_IMAGE: publish}, {entrypoint: 'shell'});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(builds(result).length, publish === 'true' ? 1 : 2);
    assert.equal(promotions(result).length, publish === 'true' ? 1 : 0);
  });
}

test('missing Bash reports an actionable entry-point error', t => {
  const f = fixture(t);
  const result = f.run({PATH: path.join(f.root, 'bin')});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Ensure Bash is available on PATH/);
  assert.equal(result.events.length, 0);
});
