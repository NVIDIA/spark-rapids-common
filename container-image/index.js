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

const {spawn} = require('node:child_process');
const path = require('node:path');

// GitHub supplies cache runtime credentials to JavaScript actions. Inherit them
// only in this process tree, without exporting credentials to later job steps.
const child = spawn('bash', [path.join(__dirname, 'image.sh')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    IMAGE_CONFIG: process.env.INPUT_CONFIG || '',
    PUBLISH_IMAGE: process.env.INPUT_PUBLISH || 'false',
    GHCR_TOKEN: process.env.INPUT_TOKEN || '',
    GHCR_USER: process.env.GITHUB_ACTOR || '',
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}
child.on('error', () => {
  console.error('::error::Unable to start the image builder. Ensure Bash is available on PATH.');
  process.exitCode = 1;
});
child.on('exit', code => { process.exitCode = code ?? 1; });
