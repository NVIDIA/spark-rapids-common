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

const {input, client, parentActive, currentSource, fail} = require('../lib');

async function main() {
  const api = client();
  const id = input('parent-run-id');
  const attempt = input('parent-run-attempt');
  const request = input('request-id');
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_RUN_ATTEMPT !== '1' ||
      process.env.GITHUB_RUN_ID === id || !request.startsWith(`gpu-${id}-${attempt}-`)) {
    throw new Error('GPU child must be a fresh coordinator dispatch, not a rerun');
  }
  await parentActive(api, id, attempt);
  await currentSource(api, input('source-ref'), input('source-sha'));
  console.log('Parent active and approved source unchanged');
}

main().catch(fail);
