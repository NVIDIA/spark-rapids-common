# spark-rapids-common

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/NVIDIA/spark-rapids-common)

## Introduction

This repository contains reusable GitHub Action workflows and common scripts used by Spark RAPIDS.

- [Runner queue fallback](runner-queue-fallback/README.md): shared runner acquisition
  and cleanup for repository-owned CPU and GPU workflows.
- [Workflow suite selector](workflow-suite-selector/README.md): select suites and
  required jobs from a PR's changed files, for normal PR events or copied-head pushes.
- [Workflow result gate](workflow-result-gate/README.md): aggregate conditional jobs
  into one final check.
- [Sonar reporting](sonar-check/README.md): collect an exact analysis result and
  publish a PR summary and Sonar check with separate credentials.

[CPU CI](.github/workflows/cpu-ci.yml) runs affected suites using the PR's local
actions. Only `CPU CI gate` needs to be a
required check after rollout validation; daily image publishing stays separate.
