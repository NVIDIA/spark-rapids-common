#!/usr/bin/env node
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
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const failure = process.env.MOCK_FAILURE;
const previous = fs.existsSync(process.env.MOCK_EVENTS) ?
  fs.readFileSync(process.env.MOCK_EVENTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const event = {command, args};
const option = name => args[args.indexOf(name) + 1];
if (command === 'docker') {
  event.directory = args[0] === '--config' ? args[1] : process.env.DOCKER_CONFIG;
  const configFile = path.join(event.directory, 'config.json');
  event.config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
  event.buildx = process.env.BUILDX_CONFIG;
  event.certs = process.env.DOCKER_CERT_PATH;
  event.authOverride = process.env.DOCKER_AUTH_CONFIG ?? null;
  event.contexts = fs.realpathSync(path.join(event.directory, 'contexts'));
  event.plugins = fs.realpathSync(path.join(event.directory, 'cli-plugins'));
}
fs.appendFileSync(process.env.MOCK_EVENTS, JSON.stringify(event) + '\n');

// These stand-ins never contact Docker or a registry; unexpected commands fail.
if (command === 'sleep') {
  process.exit(args.length === 1 && args[0] === '15' ? 0 : 90);
} else if (command === 'timeout' && args[0] === '300s' && args[1] === 'docker') {
  const result = spawnSync(args[1], args.slice(2), {stdio: 'inherit'});
  if (result.error) throw result.error;
  process.exit(result.status ?? 91);
} else if (command === 'docker' && args[0] === 'buildx' && args[1] === 'build') {
  if (failure === 'build') process.exit(42);
  if (args.includes('--metadata-file') && failure !== 'missing-metadata') {
    const digest = failure === 'bad-digest' ? 'invalid' : 'sha256:' + 'a'.repeat(64);
    fs.writeFileSync(option('--metadata-file'), JSON.stringify({'containerimage.digest': digest}));
  }
} else if (command === 'docker' && args[0] === '--config' && args[2] === 'pull') {
  const platform = option('--platform');
  const attempts = previous.filter(e => e.command === 'docker' &&
    e.args[0] === '--config' && e.args.includes(platform)).length;
  if (failure === 'pull-arm64' && platform === 'linux/arm64') process.exit(43);
  if (failure === 'pull-timeout') process.exit(124);
  if (attempts < Number(process.env.MOCK_PULL_FAILURES || 0)) process.exit(43);
} else if (command === 'docker' && args[0] === 'smoke') {
  if (failure === 'smoke-arm64' && args[2] === 'linux/arm64') process.exit(44);
} else if (command === 'docker' && args[0] === 'buildx' && args[1] === 'imagetools' &&
    args[2] === 'create') {
  if (failure === 'promotion') process.exit(45);
} else {
  console.error('Unexpected mock command:', command, args);
  process.exit(99);
}
