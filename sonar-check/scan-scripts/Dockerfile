# Copyright (c) 2026, NVIDIA CORPORATION.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Malcontent 1.28.1 includes its scanner and YARA rules for offline use.
FROM cgr.dev/chainguard/malcontent:latest

LABEL org.opencontainers.image.source="https://github.com/NVIDIA/spark-rapids-common" \
      com.nvidia.script-scan.contract="1" \
      com.nvidia.script-scan.scanner-version="1.28.1"

USER 65532:65532
ENTRYPOINT ["/usr/bin/mal"]
CMD ["--help"]
