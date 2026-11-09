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
  (.tag as $tag |
    (if has("aliases") then .aliases else [] end) |
    type == "array" and length == (unique | length) and
    all(.[]; type == "string" and
      test("\\A[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}\\z") and . != $tag)) and
  ([.context, .dockerfile, ."smoke-test", (.version // .tag)] |
    all(type == "string" and length > 0)) and
  ((."build-args" // {}) | type == "object" and
    all(keys[]; test("^[A-Za-z_][A-Za-z0-9_]*$")) and
    all(.[]; (type == "string" or type == "number" or type == "boolean") and
      (tostring | contains("\u0000") | not))) and
  ((."smoke-args" // []) | type == "array" and
    all(.[]; type == "string" and (contains("\u0000") | not))) and
  ([."cache-from", ."cache-to"] |
    all(. == null or (type == "array" and all(.[]; type == "string" and
      test("\\S") and (explode | all(. >= 32 and . != 127))))))
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
for cache_option in cache-from cache-to; do
  while IFS= read -r -d '' cache; do
    if [[ "$cache_option" == cache-to ]]; then
      # Buildx accepts a bare registry ref too. Last duplicate attribute wins.
      [[ "$cache" == *=* ]] || cache="type=registry,ref=$cache"
      cache+=",ignore-error=true"
    fi
    build_options+=("--$cache_option" "$cache")
  done < <(jq -j --arg option "$cache_option" '.[$option] // [] | .[] | ., "\u0000"' <<< "$IMAGE_CONFIG")
done
if jq -e '([."cache-from", ."cache-to"] | map(. // []) | add | length) > 0' <<< "$IMAGE_CONFIG" >/dev/null; then
  echo 'Optional Buildx cache: unavailable import metadata is a cache miss; export errors are ignored. Build, push and smoke failures remain fatal.'
fi

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
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
# Matrix jobs share run identifiers; keep each invocation's candidate independent.
candidate="$image:build-${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${scratch##*/}"
caller_config=${DOCKER_CONFIG:-"$HOME/.docker"}
[[ "$caller_config" == /* ]] || caller_config="$PWD/$caller_config"
config_file="$caller_config/config.json"
[[ -f "$config_file" ]] || config_file=/dev/null
export BUILDX_CONFIG=${BUILDX_CONFIG:-"$caller_config/buildx"}
export DOCKER_CERT_PATH=${DOCKER_CERT_PATH:-"$caller_config"}
for profile in publisher anonymous; do
  mkdir "$scratch/$profile"
  # Keep the caller's Docker endpoint and installed CLI plugins available.
  for directory in contexts cli-plugins; do
    if [[ -d "$caller_config/$directory" ]]; then
      ln -s "$caller_config/$directory" "$scratch/$profile/$directory"
    fi
  done
done
# Bypass GHCR credential helpers without changing the caller's credential store.
jq -s '.[0] // {} |
  .auths["ghcr.io"] = {auth: ((env.GHCR_USER + ":" + env.GHCR_TOKEN) | @base64)} |
  .credHelpers["ghcr.io"] = ""
' "$config_file" > "$scratch/publisher/config.json"
# A nonempty auths map also prevents automatic native credential-helper detection.
jq 'del(.auths, .credsStore, .credHelpers) | .auths = {"ghcr.io": {}}' \
  "$scratch/publisher/config.json" > "$scratch/anonymous/config.json"
export DOCKER_CONFIG="$scratch/publisher"
unset DOCKER_AUTH_CONFIG
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

# Promote every consumer tag from the same digest after all platforms pass.
promotion_tags=(--tag "$image:$tag")
alias_tags=()
while IFS= read -r alias_tag; do
  promotion_tags+=(--tag "$image:$alias_tag")
  alias_tags+=("$alias_tag")
done < <(jq -r '.aliases // [] | .[]' <<< "$IMAGE_CONFIG")
docker buildx imagetools create --prefer-index=false "${promotion_tags[@]}" "$reference"
printf 'Published %s:%s\nDigest: %s\nSource: %s\nPlatforms: %s\nAnonymous pulls and smoke checks passed.\n' \
  "$image" "$tag" "$reference" "$GITHUB_SHA" "${platforms[*]}" | tee -a "$GITHUB_STEP_SUMMARY"
if (( ${#alias_tags[@]} > 0 )); then
  printf 'Aliases: %s\n' "${alias_tags[*]}" | tee -a "$GITHUB_STEP_SUMMARY"
fi
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'image=%s\ndigest=%s\nreference=%s\n' "$image" "$digest" "$reference" >> "$GITHUB_OUTPUT"
fi
