#!/usr/bin/env python3
# Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
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

"""Fingerprint an explicitly described image recipe, without registry or CI access."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import sys


def require(condition, message):
    if not condition:
        raise ValueError(message)


def file_metadata(root, name):
    require(isinstance(name, str) and name and not Path(name).is_absolute(),
            "Recipe files must be nonempty checkout-relative paths")
    require("\\" not in name and all(part not in ("", ".", "..") for part in name.split("/")),
            f"Use a normalized checkout-relative recipe path: {name}")
    path = (root / name).resolve()
    require(path.is_relative_to(root), f"Recipe file escapes checkout: {name}")
    require(path.is_file(), f"Recipe file is missing or not a regular file: {name}")
    digest = hashlib.sha256()
    with path.open("rb") as source:
        mode = stat.S_IMODE(os.fstat(source.fileno()).st_mode)
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"sha256": digest.hexdigest(), "mode": format(mode, "04o")}


def string_list(value, field):
    require(isinstance(value, list) and all(isinstance(item, str) and item for item in value),
            f"{field} must be an array of nonempty strings")
    require(len(set(value)) == len(value), f"{field} contains duplicates")
    return value


def fingerprint(config, root):
    """Return the recipe version; callers own tags, toolchains and file declarations."""
    root = Path(root).resolve()
    require(root.is_dir(), f"Checkout root is not a directory: {root}")
    require(isinstance(config, dict), "Image config must be an object")
    platform = config.get("platform")
    require(isinstance(platform, str) and
            re.fullmatch(r"[a-z0-9]+/[a-z0-9_]+(?:/[a-z0-9]+)?", platform),
            "Metadata requires one resolved platform, e.g. linux/amd64")
    args = config.get("build-args", {})
    require(isinstance(args, dict) and all(
        isinstance(key, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) and
        isinstance(value, (str, int, float, bool)) and
        (not isinstance(value, float) or math.isfinite(value))
        for key, value in args.items()), "build-args must contain resolved scalar arguments")
    inputs = string_list(config.get("recipe-inputs", []), "recipe-inputs")
    excluded = string_list(config.get("recipe-exclude-args", []), "recipe-exclude-args")
    require(set(excluded).issubset(args), "recipe-exclude-args names an absent build argument")
    recipe = {
        "dockerfile": file_metadata(root, config.get("dockerfile"))["sha256"],
        "platform": platform,
        "build-args": {key: value for key, value in args.items() if key not in excluded},
    }
    # Preserve the existing no-file-input recipe format.
    if inputs:
        recipe["inputs"] = {name: file_metadata(root, name) for name in sorted(inputs)}
    canonical = json.dumps(recipe, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "recipe-" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="Project checkout root (default: current directory)")
    args = parser.parse_args()
    print(json.dumps({"version": fingerprint(json.load(sys.stdin), args.root)}, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        sys.exit(f"Image metadata: {error}")
