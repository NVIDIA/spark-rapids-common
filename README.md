# spark-rapids-common

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/NVIDIA/spark-rapids-common)

## Introduction

This repository contains reusable GitHub Action workflows and common scripts used by Spark RAPIDS.

- [Runner queue fallback](runner-queue-fallback/README.md): shared runner acquisition
  and cleanup for repository-owned CPU and GPU workflows.
- [Workflow suite selector](workflow-suite-selector/README.md): select suites and
  required jobs from a PR's changed files in a `push` workflow on `pull-request/<number>`.
- [Workflow result gate](workflow-result-gate/README.md): aggregate conditional jobs
  into one final check.
