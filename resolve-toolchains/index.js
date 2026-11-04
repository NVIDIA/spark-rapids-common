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

function resolveToolchains(config, versionKey, allowDefault) {
  if (!config || Array.isArray(config) || typeof config !== 'object') {
    throw new Error('Toolchain configuration must be a version-to-toolchains object');
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(versionKey) || versionKey === 'default') {
    throw new Error('version-key must be a project version, not the reserved default key');
  }
  const selectedKey = Object.hasOwn(config, versionKey) ? versionKey :
    (allowDefault ? 'default' : null);
  if (!selectedKey || !Object.hasOwn(config, selectedKey)) {
    throw new Error('Missing toolchain requirements for ' + versionKey +
      (allowDefault ? ' and no default is configured' : '; default fallback is disabled'));
  }
  const toolchains = config[selectedKey];
  if (!toolchains || typeof toolchains !== 'object' || Array.isArray(toolchains) ||
      !Object.keys(toolchains).length ||
      Object.entries(toolchains).some(([name, value]) =>
        !/^[A-Za-z0-9_.-]+$/.test(name) || typeof value !== 'string' ||
        !value.trim() || /[\x00-\x1f]/.test(value))) {
    throw new Error('Invalid toolchain map for ' + selectedKey + '; refusing fallback');
  }
  return {toolchains, selectedKey};
}

function main() {
  const allowDefault = process.env['INPUT_ALLOW-DEFAULT'] || 'false';
  if (!['true', 'false'].includes(allowDefault)) {
    throw new Error('allow-default must be true or false');
  }
  const versionKey = process.env['INPUT_VERSION-KEY'] || '';
  const config = JSON.parse(fs.readFileSync(process.env.INPUT_CONFIG, 'utf8'));
  const result = resolveToolchains(config, versionKey, allowDefault === 'true');
  console.log('Toolchain requirements: project ' + versionKey + ', selected ' +
    result.selectedKey + (result.selectedKey === 'default' ? ' (explicitly allowed default)' : ''));
  fs.appendFileSync(process.env.GITHUB_OUTPUT,
    'toolchains=' + JSON.stringify(result.toolchains) + '\nselected-key=' + result.selectedKey + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('::error::' + error.message);
    process.exitCode = 1;
  }
}

module.exports = {resolveToolchains};
