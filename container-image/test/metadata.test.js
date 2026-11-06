// Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
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
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {test} = require('node:test');

const helper = path.resolve(__dirname, '../metadata.py');
const sha256 = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'image-metadata-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'ci'));
  fs.mkdirSync(path.join(root, 'integration_tests'));
  fs.writeFileSync(path.join(root, 'ci/Dockerfile'), 'FROM scratch\n');
  fs.writeFileSync(path.join(root, 'integration_tests/requirements.txt'), 'numpy==1.26.4\n');
  const config = {dockerfile: 'ci/Dockerfile', platform: 'linux/amd64',
    'build-args': {CUDA: '12.9.1', PARALLEL_LEVEL: '4'},
    'recipe-exclude-args': ['PARALLEL_LEVEL']};
  return {
    root, config,
    run(value = config, input) {
      const result = spawnSync('python3', [helper, '--root', root], {
        cwd: os.tmpdir(), input: input ?? JSON.stringify(value), encoding: 'utf8',
        env: {PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1'}, timeout: 10000,
      });
      assert.ifError(result.error);
      return result;
    },
    version(value = config) {
      const result = this.run(value);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      const output = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(output), ['version']);
      assert.match(output.version, /^recipe-[0-9a-f]{64}$/);
      return output.version;
    },
  };
}

test('standalone CLI preserves the existing no-input JNI fingerprint without CI environment', t => {
  const f = fixture(t);
  const recipe = {'build-args': {CUDA: '12.9.1'}, dockerfile: sha256('FROM scratch\n'), platform: 'linux/amd64'};
  assert.equal(f.version(), 'recipe-' + sha256(JSON.stringify(recipe)));
  assert.equal(f.version({...f.config, 'recipe-inputs': []}), f.version());
  const imported = spawnSync('python3', ['-c',
    'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("metadata",sys.argv[1]); ' +
    'm=importlib.util.module_from_spec(s); s.loader.exec_module(m); ' +
    'print(m.fingerprint(json.load(sys.stdin),sys.argv[2]))', helper, f.root], {
    input: JSON.stringify(f.config), encoding: 'utf8', timeout: 10000,
    env: {PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1'},
  });
  assert.ifError(imported.error);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout.trim(), f.version());
});

test('explicit copied requirements and context configuration affect the fingerprint', t => {
  const f = fixture(t);
  f.config['recipe-inputs'] = ['integration_tests/requirements.txt', '.dockerignore'];
  fs.writeFileSync(path.join(f.root, '.dockerignore'), '.git\n');
  const original = f.version();
  fs.writeFileSync(path.join(f.root, 'integration_tests/requirements.txt'), 'numpy==2.0.0\n');
  assert.notEqual(f.version(), original);
  const updated = f.version();
  fs.writeFileSync(path.join(f.root, '.dockerignore'), '.git\nprivate\n');
  assert.notEqual(f.version(), updated);
  assert.equal(f.version(), f.version({...f.config, 'recipe-inputs': [...f.config['recipe-inputs']].reverse()}));
});

test('recipe, platform and semantic build arguments matter; excluded scheduling args do not', t => {
  const f = fixture(t);
  const original = f.version();
  assert.equal(original, f.version({...f.config, 'build-args': {PARALLEL_LEVEL: '8', CUDA: '12.9.1'}}));
  assert.notEqual(original, f.version({...f.config, platform: 'linux/arm64'}));
  assert.notEqual(original, f.version({...f.config, 'build-args': {...f.config['build-args'], CUDA: '13.4.3'}}));
  assert.notEqual(original, f.version({...f.config, 'recipe-exclude-args': []}));
  fs.writeFileSync(path.join(f.root, 'ci/Dockerfile'), 'FROM scratch\nENV LANG=C\n');
  assert.notEqual(original, f.version());
});

test('there is no Dockerfile parsing or implicit directory scan', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'ci/Dockerfile'), 'FROM scratch\nCOPY integration_tests/requirements.txt /tmp/\n');
  const original = f.version();
  fs.writeFileSync(path.join(f.root, 'integration_tests/requirements.txt'), 'different\n');
  assert.equal(f.version(), original, 'the owning project must explicitly list copied inputs');
});

test('metadata rejects missing, directory, escaping and malformed recipe inputs', t => {
  const f = fixture(t);
  fs.symlinkSync(os.tmpdir(), path.join(f.root, 'outside'));
  const invalid = [
    null, [], {...f.config, dockerfile: '/tmp/Dockerfile'}, {...f.config, dockerfile: '../Dockerfile'},
    {...f.config, platform: ''}, {...f.config, 'build-args': {ARG: null}},
    {...f.config, 'recipe-inputs': ['missing']}, {...f.config, 'recipe-inputs': ['ci']},
    {...f.config, 'recipe-inputs': ['outside/escape']}, {...f.config, 'recipe-inputs': ['ci/*.txt']},
    {...f.config, 'recipe-inputs': '../escape'}, {...f.config, 'recipe-inputs': ['ci/Dockerfile', 'ci/Dockerfile']},
    {...f.config, 'recipe-inputs': ['./ci/Dockerfile']}, {...f.config, 'recipe-inputs': [false]},
    {...f.config, 'recipe-exclude-args': ['TYPO']}, {...f.config, 'recipe-exclude-args': 'CUDA'},
  ];
  for (const config of invalid) {
    const result = f.run(config);
    assert.notEqual(result.status, 0, JSON.stringify(config));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Image metadata:/);
    assert.doesNotMatch(result.stderr, /Traceback/);
  }
  assert.notEqual(f.run(f.config, '{').status, 0);
});
