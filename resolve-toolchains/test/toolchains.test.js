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
const {resolveToolchains} = require('../index');

const config = {
  '26.10': {cuda12: '12.9.1', cuda13: '13.3.0'},
  default: {cuda12: '12.9.1', cuda13: '13.4.3'},
};

function run(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-toolchains-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'toolchains.json');
  const output = path.join(directory, 'output');
  fs.writeFileSync(file, options.text ?? JSON.stringify(config));
  const result = spawnSync(process.execPath, [path.join(__dirname, '../index.js')], {
    encoding: 'utf8', timeout: 5000,
    env: {
      INPUT_CONFIG: file, 'INPUT_VERSION-KEY': '26.10', 'INPUT_ALLOW-DEFAULT': 'false',
      GITHUB_OUTPUT: output, ...options.env,
    },
  });
  assert.ifError(result.error);
  return {...result, output: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : ''};
}

test('exact requirements win with or without default permission', () => {
  for (const allowDefault of [false, true]) {
    assert.deepEqual(resolveToolchains(config, '26.10', allowDefault),
      {toolchains: config['26.10'], selectedKey: '26.10'});
  }
});

test('missing version uses default only when explicitly allowed', () => {
  assert.deepEqual(resolveToolchains(config, '27.02', true),
    {toolchains: config.default, selectedKey: 'default'});
  assert.throws(() => resolveToolchains(config, '27.02', false), /fallback is disabled/);
  assert.throws(() => resolveToolchains({}, '27.02', true), /no default is configured/);
});

test('malformed exact requirements fail rather than silently selecting default', () => {
  for (const entry of [null, [], {}, '12.9.1', {cuda: 12}, {cuda: ''},
    {cuda: '   '}, {cuda: '12.9.1\n'}, {'invalid name': '12.9.1'}]) {
    assert.throws(() => resolveToolchains({...config, '26.10': entry}, '26.10', true),
      /Invalid toolchain map.*refusing fallback/);
  }
});

test('malformed configuration, default entry and invalid version keys fail closed', () => {
  for (const invalid of [null, [], 'invalid', 42]) {
    assert.throws(() => resolveToolchains(invalid, '26.10', true), /configuration must be/);
  }
  assert.throws(() => resolveToolchains({default: []}, '27.02', true), /Invalid toolchain map/);
  for (const key of ['', 'default', '../26.10', '26.10\n']) {
    assert.throws(() => resolveToolchains(config, key, true), /version-key must be/);
  }
});

test('CLI writes exact-version outputs', t => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output,
    'toolchains=' + JSON.stringify(config['26.10']) + '\nselected-key=26.10\n');
});

test('CLI writes default outputs for an explicitly allowed new version', t => {
  const result = run(t, {env: {'INPUT_VERSION-KEY': '27.02', 'INPUT_ALLOW-DEFAULT': 'true'}});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output,
    'toolchains=' + JSON.stringify(config.default) + '\nselected-key=default\n');
});

test('CLI rejects missing requirements and malformed input without writing outputs', t => {
  for (const options of [
    {env: {'INPUT_VERSION-KEY': '27.02'}},
    {env: {'INPUT_ALLOW-DEFAULT': 'yes'}},
    {text: '{"26.10":'},
    {text: JSON.stringify({...config, '26.10': null}), env: {'INPUT_ALLOW-DEFAULT': 'true'}},
  ]) {
    const result = run(t, options);
    assert.equal(result.status, 1);
    assert.equal(result.output, '');
    assert.match(result.stderr, /^::error::/);
  }
});

test('CLI escapes percent, CR and LF in actual file-read errors', t => {
  const filename = path.join(os.tmpdir(), 'missing-toolchains-%0A\r\n', 'config.json');
  let message;
  try { fs.readFileSync(filename, 'utf8'); } catch (error) { message = error.message; }
  assert.ok(message, 'fixture path must not exist');
  const result = run(t, {env: {INPUT_CONFIG: filename}});
  assert.equal(result.status, 1);
  assert.equal(result.output, '');
  assert.equal(result.stderr, '::error::' + message.replaceAll('%', '%25')
    .replaceAll('\r', '%0D').replaceAll('\n', '%0A') + '\n');
});
