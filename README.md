# Agent Task Scheduler

**English** | [日本語](README.ja.md)

A local library and CLI that turns **GitHub Issues or your own task files** into parallel work for **Codex, Claude Code, or custom agent adapters**, while respecting reported subscription quotas.

Forked from [Grey-G/codex-task-queue](https://github.com/Grey-G/codex-task-queue). The MIT license, original implementation, and original `codex-task-queue` CLI are retained. See [the upstream README](docs/UPSTREAM_README.md). The new scheduler is an independent module: it does not invoke the legacy runner's automatic commit/merge path.

## What it does

- Reads labeled GitHub Issues, JSON task files, or a directory of Markdown tasks; input locations are configurable and can be combined.
- Routes independent tasks to eligible Codex / Claude Code adapters and fills up to `maxParallel` slots.
- Checks **every reported quota window**, reserves room for your own work, and reserves estimated consumption for workers already running. Multiple models sharing the same account also share reservations.
- Stops launching when quotas are unknown/stale or insufficient. Does not locally invent a quota reset.
- Records the exact provider, session ID, worktree, attempts, outputs, and logs; quota failures resume **that same session** after availability is confirmed.
- Keeps results in `review` until you approve them. Does not automatically publish, open PRs, close issues, or merge changes.
- Supports optional wall-clock warmups when there are no queued tasks and the quota reader reports no active five-hour window. Actual window-start behavior remains provider-dependent.

This is a first version, not a guarantee of precisely exhausting the final token. Percentage readings can lag and per-task consumption is variable. Admission uses configurable estimates and reservations, **not a learned cost model** or a hard spending cap. Running tasks are not preemptively stopped as percentages rise; the policy controls new admissions, and actual limit failures pause tasks. Use bounded task descriptions and timeouts. An external actor using the same account can consume the same allowance.

## Install

Node.js 18+; Git; signed-in provider CLI(s). For GitHub Issues, install GitHub CLI and run `gh auth login`.

```sh
git clone https://github.com/rrhaya/agent-task-scheduler.git
cd agent-task-scheduler
git checkout feat/quota-scheduler
npm install -g .
```

No runtime npm dependencies. Alternatively run `node bin/agent-task-scheduler.mjs` directly. The package is not published to npm yet.

## Start with GitHub Issues

Copy [examples/github-scheduler.json](examples/github-scheduler.json) to your own configuration file. Set:

1. `repository`: your GitHub `owner/repo`.
2. `cwd`: the absolute path to its **clean, committed local checkout**.
3. `labels`: only Issues you want the scheduler to work on (default: `agent-ready`). Multiple labels are AND-filtered by GitHub CLI.
4. `stateDir`: a private directory **outside your target repository**, shared by all scheduler processes controlling that queue.
5. Agents you actually have installed and logged in.

Read task previews before starting:

```sh
agent-task-scheduler plan --config /path/to/scheduler.json
agent-task-scheduler run --config /path/to/scheduler.json
# Continuous mode: discover new Issues and wait/resume after quota recovery.
agent-task-scheduler watch --config /path/to/scheduler.json
agent-task-scheduler status --config /path/to/scheduler.json
```

An Issue's title and body form the task. Optional metadata can be embedded in the body:

````markdown
```task-json
{
  "priority": 10,
  "estimatedMinutes": 15,
  "estimatePercent": { "five_hour": 5, "weekly": 1 },
  "dependsOn": [12]
}
```
Fix the retry bug and run the relevant tests.
````

Issue #42 in `alice/project` has task ID `alice.project.42`. Repository directory and agent selection come from your configuration, not from remote Issue metadata. Dependencies are Issue numbers in the same repository, and **must also carry the configured labels**, including closed prerequisites. Closed Issues are treated as done. Comment threads are not imported. Reading a label approves execution of its body: label only work whose scope you have reviewed.

Results remain in worktrees under `stateDir/worktrees`, including uncommitted changes. Inspect the output/logs, test and integrate the work into the source checkout, then approve:

```sh
agent-task-scheduler approve --config /path/to/scheduler.json --task alice.project.42
```

Approval changes local state only. It does not merge or close the Issue. Dependent workers branch from the local checkout's current `HEAD`, so **integrate their prerequisites before approving them**. If an executed task's title/body/metadata changes, use a new Issue/task ID or restore the original definition. This prevents silently resuming an old session against new instructions.

## Agent and quota configuration

### Codex

```json
"codex": {
  "type": "codex",
  "sandbox": "workspace-write",
  "timeoutMs": 3600000
}
```

Uses saved official CLI authentication. Reads quotas through official app-server `account/rateLimits/read`, with **no model invocation**. Task execution uses `codex exec --json`; continuing uses `codex exec resume <exact-session-id>`. Model defaults to your CLI configuration unless `model` is supplied. `sandbox` can be `read-only` or `workspace-write`; the scheduler never sets a sandbox-bypass flag. Unattended Codex runs use `approval_policy=never`: commands requiring escalation are denied rather than interactively approved.

### Claude Code

```json
"claude": {
  "type": "claude-code",
  "allowedTools": ["Read", "Glob", "Grep", "Edit", "Write"],
  "quota": { "type": "command", "argv": ["limitping", "status", "--json"] }
}
```

Uses `claude -p --output-format stream-json --verbose`, continuing with `--resume <exact-session-id>`. Uses the CLI's configured authentication and billing route; **verify your installed Claude version and account's headless billing behavior before relying on subscription-only operation**. The scheduler neither obtains API keys nor guarantees that a given vendor mode consumes a subscription pool. It does not set `--bare` or `--dangerously-skip-permissions`. Configure approved tools explicitly; permission denials require attention. The example does not approve shell commands.

Claude does not have an integrated quota reader in this version. You can use [CCLimitPing](https://github.com/wavever/CCLimitPing) as an optional read-only bridge. Its quota endpoint is unofficial. Without a quota reader Claude's quota is **unknown**, so it receives no tasks. Do not use estimates of API dollars as subscription utilization.

### Other quota readers

A command can emit normalized JSON (timestamps in **milliseconds**):

```json
{
  "known": true,
  "observedAt": 1790950000000,
  "windows": [
    { "id": "five_hour", "usedPercent": 40, "durationMins": 300, "resetsAt": 1790960000000 },
    { "id": "weekly", "usedPercent": 20, "durationMins": 10080, "resetsAt": 1791400000000 }
  ]
}
```

```json
"quota": { "type": "command", "argv": ["/path/to/read-quota", "--json"] }
```

Or `{"type":"file","path":"/path/to/live-quota.json"}` for a file updated by your own monitor. Readings older than `maxSnapshotAgeMs` (default 120 seconds) are rejected. No windows does not mean unlimited: an intentionally unlimited custom reader must return `known: true, windows: []`, and the operator must explicitly set `allowUnlimited: true`.

`quotaPool` defaults to `codex` or `claude`, so multiple adapters/models for the same provider share worker reservations. If you explicitly configure independently authorized accounts, give each account a distinct pool. The process does not identify account ownership or auto-switch accounts; do not assign separate pools to the same account.

## Reserve room or use spare capacity

```json
"policy": {
  "reservePercent": 20,
  "weeklyReservePercent": 30,
  "defaultEstimatePercent": 5,
  "weeklyEstimatePercent": 1,
  "safetyFactor": 1.5,
  "fitBeforeReset": true
},
"maxParallel": 3
```

A normal configuration keeps 20% of short windows and 30% of weekly windows reserved. For overnight work, reduce these reserves in a separate configuration **using the same stateDir**, with only one supervisor running. The scheduler does not automatically detect when you are away. A task with `estimatedMinutes` is admitted only if it fits before the next short-window reset; omit that estimate or disable `fitBeforeReset` to allow work to span resets and resume later.

Before admitting a worker, the scheduler checks:

```
reported remaining percentage
  - operator reserve
  - conservative estimates for active/recent workers
  >= this task's conservative estimate
```

Recent workers retain their reservations for `settleMs` (default 60 seconds), protecting against delayed usage reports. This is a margin, not a guarantee. Primary/secondary quotas and all returned buckets are conservatively checked; custom bucket-specific estimates can use the exact normalized window ID.

## Durable recovery

`watch` waits without model calls, then re-reads quotas. A quota-blocked task resumes only when all relevant windows pass admission checks. Retry backoff is at least 30 seconds. `maxAttempts` defaults to 10 total attempts per task. At the limit the task requires attention. Network, authentication, permission failures, user interruption, and uncertain process crashes do **not** automatically replay work.

```sh
agent-task-scheduler retry --config /path/to/scheduler.json --task alice.project.42
```

This is an explicit request to try again after inspecting prior side effects. If a session ID exists it is retained. A failed worker without a session ID cannot be automatically resumed. `retry` resets the attempt allowance. Ctrl-C stops process groups and records interrupted tasks. If a supervisor crashes, stale `running` records require review and the lock remains: verify that its PID and any worker descendants have stopped before removing `stateDir/scheduler.lock`. Never run two supervisors with different stateDirs against the same task queue.

State and logs may contain private task bodies or model outputs. Keep stateDir private and out of source control. The library does not read or copy OAuth tokens; vendor CLIs and any explicitly configured quota helper control their credentials. Logs are retained; clean them according to your own retention needs.

## Optional warmup

```json
"warmup": { "at": ["04:00"], "timeZone": "Asia/Tokyo", "agents": ["codex"] }
```

`watch` attempts one tiny read-only request during the scheduled minute if there are no pending/blocked tasks, no active workers, adequate weekly/short headroom, and a five-hour window reported with `resetsAt: null`. It does not infer inactive windows from moving timestamps; ambiguous readings cause the ping to be skipped. If the computer is asleep or polling misses that minute, it is skipped. No wake-from-sleep or catch-up is implemented. State is recorded before sending so a crash does not cause a duplicate warmup. This does not promise to set or force a server reset time.

## Local task lists

See [examples/scheduler.json](examples/scheduler.json), [JSON tasks](examples/tasks.json), and [Markdown tasks](examples/task-folder/review-tests.md). JSON can be an array or `{"tasks":[...]}`. Markdown starts with a `task-json` metadata block and uses the remainder as the prompt. Relative `cwd` paths resolve against the input file or Markdown directory. IDs must be unique across all sources. File sources are never edited by the scheduler.

## Library usage

```js
import {
  Scheduler, FileStateStore, GitHubIssuesSource,
  CodexAdapter, ClaudeCodeAdapter, CommandQuotaReader, QuotaPolicy
} from 'agent-task-scheduler';

const scheduler = new Scheduler({
  source: new GitHubIssuesSource({
    repository: 'alice/project', cwd: '/projects/project', labels: ['agent-ready']
  }),
  store: new FileStateStore('/private/agent-task-state'),
  agents: {
    codex: new CodexAdapter(),
    claude: new ClaudeCodeAdapter({
      allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
      quotaReader: new CommandQuotaReader(['limitping', 'status', '--json'], 'claude')
    })
  },
  policy: new QuotaPolicy({ reservePercent: 20, weeklyReservePercent: 30 }),
  maxParallel: 3,
  onEvent: event => console.log(event)
});

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
await scheduler.run({ watch: true, signal: controller.signal });
```

Adapters and sources are structural interfaces; see [TypeScript declarations](lib/index.d.ts):

- `TaskSource.list(): Promise<Task[]>`
- `AgentAdapter.readQuota(): Promise<QuotaSnapshot>`
- `AgentAdapter.run(task, {cwd, sessionId, signal, onSession, logFile}): Promise<RunResult>`
- `StateStore.read / write / lock`

This allows adding Notion, another Issue tracker, or another agent without changing the scheduler. A custom source must return absolute directories, validated globally unique IDs, dependencies, and stable fingerprints (call `validateTasks`). A custom adapter must distinguish completed turns from quota failures, emit its session ID early, honor cancellation, and retain provider-native permission policy. The built-in CLI currently supports `codex` and `claude-code`; other adapters are injected through the library.

## Verification and limitations

```sh
npm test
npm run pack:dry-run
```

Tests use fake vendor processes plus real temporary Git worktrees. They cover quota reservations, same-account pools, weekly exhaustion, exact-session resume, missing sessions, crash recovery, GitHub filtering, dependencies, cancellation and read-only planning. No inference calls are made by the tests. Codex quota reading has also been verified with the installed official CLI. Claude Code is not installed on the development machine, so real Claude execution remains unverified.

Not included: a web UI, published npm package, OS-service installation, automatic merging, live cost learning, hard total-spend enforcement, arbitrary warmup catch-up, or automatic API/provider billing failover. The legacy CLI has its upstream behavior; use the **new** `agent-task-scheduler` entrypoint for the quota-aware scheduler.

## Security

See [SECURITY.md](SECURITY.md) for trust boundaries, fixed findings, and residual risks. Worker environments inherit only selected OS/runtime settings. API keys, GitHub tokens, cloud credentials and `NODE_OPTIONS` are not inherited by default; intentionally needed variables must be explicitly configured in the agent’s `env`. State directories must be owned by the current user and mode `0700` on Unix; state files are `0600`. Logs are created exclusively and capped at 50 MB per attempt; worker event lines are capped at 1 MB. Quota-reader commands remain trusted operator configuration and inherit the scheduler environment.

Git worktrees isolate changes, **not security permissions**. Issue bodies, repository hooks, plugins, tests and instructions can influence the agent or execute code. Claude tool allowlists configure auto-approval; they do not constitute an OS sandbox. Use a disposable VM/container with narrowly scoped credentials for untrusted inputs. The retained upstream CLI has a different permission and automatic-integration model; these new protections do not retrofit its execution paths.
