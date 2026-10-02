# Codex Task Queue

![Node.js 18+](https://img.shields.io/badge/node-%3E%3D18-43853d)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Codex workflow](https://img.shields.io/badge/Codex-workflow-111827)
![Parallel subagents](https://img.shields.io/badge/parallel-subagents-7c3aed)

## Core Responsibility / 核心职责

**Turn product and development docs into executable Codex workflows, then run them with parallel subagents.**

**把产品文档和开发文档自动转换成可执行的 Codex 工作流文档，并开启多个子 agent 并行完成工作流。**

`codex-task-queue` is not mainly a generic task runner. Its core advantage is the full workflow loop:

1. Read product docs, development docs, bug lists, and repository context.
2. Generate workflow documents such as `docs/PRODUCT.md`, `docs/TASK_QUEUE.md`, `docs/PATCH_QUEUE.md`, and `docs/SESSION_RUNBOOK.md`.
3. Split the work into bounded, reviewable tasks.
4. Start multiple Codex subagents in separate Git worktrees for independent `READY` tasks.
5. Preserve handoffs, commits, queue state, and native Codex session history.

`codex-task-queue` 不是普通的任务运行器。它最核心的优势是一整套闭环：

1. 读取产品文档、开发文档、bug 列表和仓库上下文。
2. 自动生成 `docs/PRODUCT.md`、`docs/TASK_QUEUE.md`、`docs/PATCH_QUEUE.md`、`docs/SESSION_RUNBOOK.md` 等工作流文档。
3. 把工作拆成边界清晰、可审查的任务。
4. 对互相独立的 `READY` 任务，在不同 Git worktree 中开启多个 Codex 子 agent 并行执行。
5. 保留 handoff、commit、队列状态和原生 Codex session 历史。

The queue is only the workflow format. The workflow is the product.

队列只是工作流的落地格式。真正的产品是这套工作流。

## Why This Exists

Codex is powerful for one-off changes, but larger repository work needs more structure:

- product and development docs must become executable implementation steps;
- long tasks need durable context instead of one chat thread;
- independent work should run in parallel without mixing changes;
- every automated task needs a handoff, validation notes, and a commit boundary.

`codex-task-queue` adds that workflow layer. It creates the workflow docs first, then uses Codex subagents to execute the workflow through scoped tasks.

## Before / After

| Before | After |
| --- | --- |
| Paste a long product request into one Codex chat | Generate `docs/PRODUCT.md`, `docs/TASK_QUEUE.md`, and `docs/SESSION_RUNBOOK.md` |
| Manually decide what to do next | Run `next` to preview the next executable task |
| One agent works serially through everything | Independent `READY` tasks can run through parallel Codex subagents |
| Changes pile up in one checkout | Each subagent works in its own Git worktree |
| Hard to resume or audit later | Handoffs, queue state, commits, and native Codex sessions are preserved |

## 60-Second Demo

From a target repository:

```bash
# Install from GitHub once.
npm install -g github:Grey-G/codex-task-queue

# 1. Inspect the repo and current workflow docs.
codex-task-queue doctor

# 2. Generate draft workflow docs from product/dev material.
codex-task-queue init

# 3. Preview the next executable task after review/confirmation.
codex-task-queue next

# 4. Run the workflow with parallel Codex subagents.
codex-task-queue run --max-parallel 5
```

Maintenance mode for bug batches:

```bash
codex-task-queue init --mode maintenance
codex-task-queue run --mode maintenance --max-parallel 5
```

## Real Example

Input material:

```text
We have a product doc, a few bug reports, and a repo with failing UI polish tasks.
Split the work safely, keep unrelated fixes separate, and let Codex run what can be parallelized.
```

Generated workflow docs:

```text
docs/PRODUCT.md
docs/TASK_QUEUE.md
docs/PATCH_QUEUE.md
docs/SESSION_RUNBOOK.md
docs/handoffs/<task-id>.md
```

Execution shape:

```text
main workflow branch
  worker T1 -> separate Git worktree -> Codex subagent -> handoff -> coordinator squash commit
  worker T2 -> separate Git worktree -> Codex subagent -> handoff -> coordinator squash commit
  worker T3 -> waits for T1/T2 prerequisites, then unlocks
```

## Overview

`codex-task-queue` inspects the repo, drafts workflow docs from project material, splits the work into bounded steps, runs explicit `READY` steps through one or more Codex subagents, and preserves handoffs/history.

It is intentionally conservative: draft first, confirm before execution, and keep each task scoped to one Codex session and one Git commit.

The tool includes two built-in workflow templates:

- **Project mode**: new product slices, larger features, milestones, or planned implementation work. Uses `docs/PRODUCT.md` and `docs/TASK_QUEUE.md`.
- **Maintenance mode**: bug batches, warnings, UI tweaks, small refactors, and unrelated patch sets in an existing repository. Uses `docs/PATCH_QUEUE.md` and does not require a product document.

## Repository Layout

```text
SKILL.md                         Codex skill instructions
scripts/codex-task-queue.mjs     CLI entrypoint
references/queue-format.md       Queue document format reference
agents/openai.yaml               Agent metadata/config
tests/                           Node test suite
```

## Requirements

- Node.js 18 or newer
- Git
- Codex CLI

The script uses Node built-ins only; there is no package install step for normal local use.

On macOS, the CLI defaults to the Codex Desktop app binary when present:

```text
/Applications/Codex.app/Contents/Resources/codex
```

Otherwise it uses `codex` from `PATH`. You can override this with `--codex <path>` or `CODEX_TASK_QUEUE_CODEX`.

## Install

Install directly from GitHub:

```bash
npm install -g github:Grey-G/codex-task-queue
codex-task-queue help
```

Run once without a global install:

```bash
npx --yes github:Grey-G/codex-task-queue doctor
```

Use a local clone while developing:

```bash
git clone https://github.com/Grey-G/codex-task-queue.git
cd codex-task-queue
npm link
codex-task-queue help
```

Fallback without installing:

```bash
node /path/to/codex-task-queue/scripts/codex-task-queue.mjs help
```

## Quick Start

Run commands from the repository you want to manage, not necessarily from this skill repository:

```bash
codex-task-queue doctor
codex-task-queue init
codex-task-queue next
codex-task-queue run
```

For maintenance queues:

```bash
codex-task-queue doctor --mode maintenance
codex-task-queue init --mode maintenance
codex-task-queue run --mode maintenance
```

Useful targeting option:

```bash
codex-task-queue doctor --cwd /path/to/project
```

## Command Summary

```bash
codex-task-queue help
codex-task-queue doctor
codex-task-queue init
codex-task-queue next
codex-task-queue run
codex-task-queue history
```

Common options:

- `--cwd <dir>`: operate on a different project root.
- `--mode project|maintenance`: choose queue type. Default is `project`.
- `--maintenance`: alias for `--mode maintenance`.
- `--max <n>`: run up to `n` READY tasks. Use `--max 1` for one task only.
- `--max-parallel <n>`: cap parallel task workers. Default is `5`; `--max-parallel 1` still uses a worker worktree.
- `--no-parallel`: use the legacy serial loop in the current checkout.
- `--until-blocked`: run until no READY task remains or a task fails.
- `--runner auto|app-server|exec`: default is `auto`.
- `--allow-exec-fallback`: allow invisible `codex exec` fallback when app-server cannot start.
- `--no-commit`: disable automatic task commits.
- `--allow-dirty-start`: allow an existing dirty tree to be included in the next task commit.
- `--model <model>`: override the Codex model.
- `--reasoning-effort <effort>`: override reasoning effort.
- `--service-tier <tier>` or `--speed <tier>`: override service tier.
- `--codex <path>`: use a specific Codex CLI binary.

Run `codex-task-queue help` for the full option list.

## Project Mode Flow

Project mode expects:

- `docs/PRODUCT.md`
- `docs/TASK_QUEUE.md`
- `docs/SESSION_RUNBOOK.md`
- `docs/handoffs/<task-id>.md`

Typical flow:

1. Run `doctor` in the target repository.
2. Run `init` if product or queue docs are missing.
3. Review the generated draft docs.
4. Remove draft status only after user confirmation.
5. Mark the first runnable task or independent task group as `READY`.
6. Run `next` to preview the prompt.
7. Run `run` / `run --until-blocked` for a queue pass, or `run --max 1` only when you explicitly want a single task.
8. Review handoffs, commits, and queue status before continuing.

## Maintenance Mode Flow

Maintenance mode expects:

- `docs/PATCH_QUEUE.md`
- `docs/SESSION_RUNBOOK.md`
- `docs/handoffs/<task-id>.md`

Typical flow:

1. Run `doctor --mode maintenance`.
2. Run `init --mode maintenance` if `docs/PATCH_QUEUE.md` is missing.
3. Fill the draft patch queue with issue evidence, expected behavior, validation, severity, and allowed paths.
4. Remove draft status only after the user confirms the patch list.
5. Mark independent first patches as `READY`.
6. Run `run --mode maintenance` for a queue pass, or use `--max 1` only when you explicitly want a single patch.

Maintenance tasks should stay narrowly scoped. `Allowed paths` are treated as a hard fence.

## Queue Rules

- Draft queues are not executable.
- READY tasks are the only runnable tasks.
- Parallel execution is the default.
- Independent READY tasks can run concurrently in separate Git worktrees.
- Dependent tasks unlock after their prerequisites are `DONE`.
- `--max-parallel 1` still uses a worker worktree; it limits concurrency without making the coordinator implement the task.
- `--no-parallel` serial mode executes in the current checkout and should be reserved for deliberate diagnosis or legacy workflows.
- Each task should fit in one Codex session and one Git commit; parallel workers are squashed into one coordinator commit when the task completes.
- Completed tasks write a handoff under `docs/handoffs/`.
- Queue runs prefer visible Codex Desktop/app-server sessions.
- Invisible `codex exec` fallback must be explicit with `--allow-exec-fallback`.
- Dirty Git trees are rejected unless `--allow-dirty-start` is used.

See `references/queue-format.md` before manually editing queue files.

## Output Files

The runner may create or update:

- `.codex-queue/`
- `.codex-queue/parallel-state.json`
- `docs/QUEUE_RUN_LOG.md`
- `docs/QUEUE_NATIVE_SESSIONS.md`
- `docs/handoffs/<task-id>.md`

These files preserve task handoffs, assistant messages, native Codex session references, and run history.

## Testing

Run the local test suite with:

```bash
node --test tests/*.test.mjs
```

The tests use a fake runner path through `CODEX_TASK_QUEUE_FAKE_RUNNER=1`, so they validate queue scheduling, branch creation, dependency unlocking, and worktree cleanup without starting real Codex task sessions.

## Skill Installation

To use this as a Codex skill, place this repository under your local Codex skills directory, for example:

```text
~/.codex/skills/codex-task-queue/
```

Codex discovers the skill from `SKILL.md`. The YAML frontmatter names the skill `codex-task-queue` and describes when it should be used.

## 中文说明

说白了，`codex-task-queue` 是一个给 Codex 创建仓库工作流的本地 skill。

它最核心的职责不是“跑任务”，而是从产品文档、开发文档、bug 列表和仓库上下文里生成工作流文档，再开启多个 Codex 子 agent 完成这套工作流。

它会先检查仓库，再生成工作流文档草稿，把工作拆成有边界的步骤，对互相独立的 `READY` 任务并行启动子 agent，并保留 handoff 和运行历史。

队列只是这个工作流的落地格式。真正的产品是这套工作流。

它的规则比较保守：先草稿，确认后再执行，每个任务尽量控制在一个 Codex session 和一个 Git commit 内。

它内置两类工作流模板：

- **项目模式**：适合新产品切片、大功能、里程碑或计划型实现。使用 `docs/PRODUCT.md` 和 `docs/TASK_QUEUE.md`。
- **维护模式**：适合 bug 批处理、告警修复、UI 小调整、小重构或互不相关的 patch。使用 `docs/PATCH_QUEUE.md`，不要求产品文档。

### 仓库结构

```text
SKILL.md                         Codex skill 指令
scripts/codex-task-queue.mjs     CLI 入口
references/queue-format.md       队列文档格式参考
agents/openai.yaml               Agent 元数据/配置
tests/                           Node 测试
```

### 环境要求

- Node.js 18 或更新版本
- Git
- Codex CLI

脚本只使用 Node 内置模块，正常本地使用不需要安装 npm 依赖。

在 macOS 上，如果存在 Codex Desktop app 的 CLI，脚本会默认使用：

```text
/Applications/Codex.app/Contents/Resources/codex
```

否则会使用 `PATH` 里的 `codex`。也可以通过 `--codex <path>` 或 `CODEX_TASK_QUEUE_CODEX` 指定。

### 快速开始

先从 GitHub 安装：

```bash
npm install -g github:Grey-G/codex-task-queue
```

这些命令应该在你要管理的目标仓库里执行，不一定是在这个 skill 仓库里执行：

```bash
codex-task-queue doctor
codex-task-queue init
codex-task-queue next
codex-task-queue run
```

维护模式：

```bash
codex-task-queue doctor --mode maintenance
codex-task-queue init --mode maintenance
codex-task-queue run --mode maintenance
```

指定目标仓库：

```bash
codex-task-queue doctor --cwd /path/to/project
```

### 命令概览

```bash
codex-task-queue help
codex-task-queue doctor
codex-task-queue init
codex-task-queue next
codex-task-queue run
codex-task-queue history
```

常用参数：

- `--cwd <dir>`：指定目标项目根目录。
- `--mode project|maintenance`：选择队列类型，默认是 `project`。
- `--maintenance`：`--mode maintenance` 的别名。
- `--max <n>`：最多执行 `n` 个 READY 任务。只跑一个任务时用 `--max 1`。
- `--max-parallel <n>`：限制并行任务数，默认是 `5`；`--max-parallel 1` 仍然会使用 worker worktree。
- `--no-parallel`：使用当前 checkout 的旧串行执行。
- `--until-blocked`：一直执行到没有 READY 任务或某个任务失败。
- `--runner auto|app-server|exec`：默认是 `auto`。
- `--allow-exec-fallback`：当 app-server 启动失败时，允许回退到不可见的 `codex exec`。
- `--no-commit`：关闭自动提交。
- `--allow-dirty-start`：允许把已有 dirty tree 混入下一个任务提交。
- `--model <model>`：覆盖 Codex 模型。
- `--reasoning-effort <effort>`：覆盖 reasoning effort。
- `--service-tier <tier>` 或 `--speed <tier>`：覆盖 service tier。
- `--codex <path>`：指定 Codex CLI 路径。

完整参数可以运行：

```bash
codex-task-queue help
```

### 项目模式流程

项目模式需要这些文件：

- `docs/PRODUCT.md`
- `docs/TASK_QUEUE.md`
- `docs/SESSION_RUNBOOK.md`
- `docs/handoffs/<task-id>.md`

典型流程：

1. 在目标仓库运行 `doctor`。
2. 如果产品文档或队列文档缺失，运行 `init`。
3. 检查生成的草稿文档。
4. 只有在用户确认后，才移除草稿状态。
5. 把第一个可执行任务或一组互相独立的任务标记为 `READY`。
6. 运行 `next` 预览任务 prompt。
7. 用 `run` / `run --until-blocked` 跑一轮队列；只有明确想跑单个任务时才用 `run --max 1`。
8. 继续前检查 handoff、commit 和队列状态。

### 维护模式流程

维护模式需要这些文件：

- `docs/PATCH_QUEUE.md`
- `docs/SESSION_RUNBOOK.md`
- `docs/handoffs/<task-id>.md`

典型流程：

1. 运行 `doctor --mode maintenance`。
2. 如果 `docs/PATCH_QUEUE.md` 缺失，运行 `init --mode maintenance`。
3. 在 patch 队列草稿里补充问题证据、期望行为、验证方式、严重程度和允许修改路径。
4. 只有在用户确认 patch 列表后，才移除草稿状态。
5. 把互相独立的首批 patch 标记为 `READY`。
6. 运行 `run --mode maintenance` 跑一轮队列；只有明确想跑单个 patch 时才加 `--max 1`。

维护任务应该保持窄范围。`Allowed paths` 是硬边界。

### 队列规则

- 草稿队列不能执行。
- 只有 `READY` 任务可以执行。
- 默认并行执行。
- 互相独立的 READY 任务可以在不同 Git worktree 里并行执行。
- 依赖任务会在前置任务 `DONE` 后解锁。
- `--max-parallel 1` 仍然使用 worker worktree，只是并发数限制为 1。
- `--no-parallel` 会在当前 checkout 串行执行，主要用于明确的诊断或旧流程。
- 每个任务应该能放进一个 Codex session 和一个 Git commit；并行 worker 的结果会在任务完成时由 coordinator squash 成一次提交。
- 完成的任务要在 `docs/handoffs/` 下写 handoff。
- 队列运行默认优先使用 Codex Desktop/app-server 的可见 session。
- 不可见的 `codex exec` 回退必须通过 `--allow-exec-fallback` 明确开启。
- dirty Git tree 默认会被拒绝，除非使用 `--allow-dirty-start`。

手动编辑队列文件前，先看 `references/queue-format.md`。

### 输出文件

运行器可能创建或更新：

- `.codex-queue/`
- `.codex-queue/parallel-state.json`
- `docs/QUEUE_RUN_LOG.md`
- `docs/QUEUE_NATIVE_SESSIONS.md`
- `docs/handoffs/<task-id>.md`

这些文件用于保存任务 handoff、assistant 最后一条消息、原生 Codex session 引用和运行历史。

### 测试

运行本地测试：

```bash
node --test tests/*.test.mjs
```

测试通过 `CODEX_TASK_QUEUE_FAKE_RUNNER=1` 使用 fake runner，因此可以验证队列调度、分支创建、依赖解锁和 worktree 清理，而不会启动真实 Codex 任务 session。

### Skill 安装

要把它作为 Codex skill 使用，可以把这个仓库放到本地 Codex skills 目录，例如：

```text
~/.codex/skills/codex-task-queue/
```

Codex 会从 `SKILL.md` 发现这个 skill。YAML frontmatter 里声明了 skill 名称 `codex-task-queue` 和适用场景。
