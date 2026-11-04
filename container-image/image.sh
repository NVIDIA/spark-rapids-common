#!/usr/bin/env bash
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

set -euo pipefail
: "${IMAGE_CONFIG:?Resolved image config required}"
publish=${PUBLISH_IMAGE:-false}
[[ "$publish" == true || "$publish" == false ]]
jq -e '
  (.image | type == "string") and (.tag | type == "string") and
  ([.context, .dockerfile, ."smoke-test", (.version // .tag)] |
    all(type == "string" and length > 0)) and
  ((."build-args" // {}) | type == "object" and
    all(keys[]; test("^[A-Za-z_][A-Za-z0-9_]*$")) and
    all(.[]; (type == "string" or type == "number" or type == "boolean") and
      (tostring | contains("\u0000") | not))) and
  ((."smoke-args" // []) | type == "array" and
    all(.[]; type == "string" and (contains("\u0000") | not)))
' <<< "$IMAGE_CONFIG" >/dev/null
image=$(jq -r '.image' <<< "$IMAGE_CONFIG")
tag=$(jq -r '.tag' <<< "$IMAGE_CONFIG")
version=$(jq -r '.version // .tag' <<< "$IMAGE_CONFIG")
context=$(jq -r '.context' <<< "$IMAGE_CONFIG")
dockerfile=$(jq -r '.dockerfile' <<< "$IMAGE_CONFIG")
smoke_test=$(jq -r '."smoke-test"' <<< "$IMAGE_CONFIG")
[[ "$image" =~ ^[a-z0-9]+([._-][a-z0-9]+)*$ ]]
[[ "$tag" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]]
[[ -d "$context" && -f "$dockerfile" && -f "$smoke_test" ]]
platform_json=$(jq -ce '.platforms // [.platform] |
  select(type == "array" and length > 0 and length == (unique | length) and
    all(.[]; . == "linux/amd64" or . == "linux/arm64"))' <<< "$IMAGE_CONFIG")
platforms=()
while IFS= read -r platform; do platforms+=("$platform"); done < <(jq -r '.[]' <<< "$platform_json")
build_args=()
while IFS= read -r -d '' argument; do
  build_args+=(--build-arg "$argument")
done < <(jq -j '."build-args" // {} | to_entries[] | "\(.key)=\(.value)", "\u0000"' <<< "$IMAGE_CONFIG")
smoke_args=()
while IFS= read -r -d '' argument; do smoke_args+=("$argument"); done \
  < <(jq -j '."smoke-args" // [] | .[] | ., "\u0000"' <<< "$IMAGE_CONFIG")
build_options=(--pull --file "$dockerfile" "${build_args[@]}"
  --label "org.opencontainers.image.version=$version")

if [[ "$publish" == false ]]; then
  reference="image-validation:$tag"
  for platform in "${platforms[@]}"; do
    docker buildx build "${build_options[@]}" --platform "$platform" --tag "$reference" --load "$context"
    bash "$smoke_test" "$reference" "$platform" "${smoke_args[@]}"
  done
  printf 'Validated %s on %s: image build and smoke checks passed. No image published.\n' \
    "$reference" "${platforms[*]}" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 0
fi

: "${GITHUB_REPOSITORY:?}" "${GITHUB_SHA:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}"
: "${GITHUB_SERVER_URL:?}" "${GHCR_TOKEN:?}" "${GHCR_USER:?}" "${GITHUB_STEP_SUMMARY:?}"
image="ghcr.io/${GITHUB_REPOSITORY,,}/$image"
candidate="$image:build-${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
scratch=$(mktemp -d)
mkdir "$scratch/anonymous"
trap 'docker logout ghcr.io; rm -rf "$scratch"' EXIT
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USER" --password-stdin
platform_list=$(IFS=,; printf '%s' "${platforms[*]}")
docker buildx build "${build_options[@]}" --no-cache --platform "$platform_list" \
  --label "org.opencontainers.image.source=$GITHUB_SERVER_URL/$GITHUB_REPOSITORY" \
  --label "org.opencontainers.image.revision=$GITHUB_SHA" \
  --tag "$candidate" --metadata-file "$scratch/metadata.json" --push "$context"
digest=$(jq -er '."containerimage.digest" | select(test("^sha256:[0-9a-f]{64}$"))' "$scratch/metadata.json")
reference="$image@$digest"

for platform in "${platforms[@]}"; do
  # Registry reads can lag a push; retry reads only, never rebuild or re-push.
  pulled=false
  for attempt in 1 2 3; do
    printf 'Anonymous pull %s, attempt %s/3: %s\n' "$platform" "$attempt" "$reference"
    if timeout 300s docker --config "$scratch/anonymous" pull --platform "$platform" "$reference"; then
      pulled=true
      break
    fi
    if (( attempt < 3 )); then sleep 15; fi
  done
  if [[ "$pulled" != true ]]; then
    echo "::error::Anonymous pull failed for $reference ($platform). Check GHCR availability and public package visibility, then rerun. Consumer tag $image:$tag was not updated."
    exit 1
  fi
  bash "$smoke_test" "$reference" "$platform" "${smoke_args[@]}"
done

# Promote only the registry digest verified on every requested platform.
docker buildx imagetools create --prefer-index=false --tag "$image:$tag" "$reference"
printf 'Published %s:%s\nDigest: %s\nSource: %s\nPlatforms: %s\nAnonymous pulls and smoke checks passed.\n' \
  "$image" "$tag" "$reference" "$GITHUB_SHA" "${platforms[*]}" | tee -a "$GITHUB_STEP_SUMMARY"
