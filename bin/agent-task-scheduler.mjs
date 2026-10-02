#!/usr/bin/env node
import { schedulerFromConfig } from '../lib/index.mjs';

const HELP = `agent-task-scheduler <plan|run|watch|status|approve|retry> [--config <file>] [--env-file <file>] [--task <id>]

plan     Read tasks and live quotas; preview admissions without starting agents
run      Execute immediately eligible tasks; exit when no more can start
watch    Keep checking, discovering tasks, and resuming after quota recovery
status   Read durable task state
approve  Mark a reviewed task done, unlocking its dependents
retry    Explicitly retry failed/interrupted tasks in the recorded session

Sources are read-only. Results and worktrees remain in stateDir. No automatic merge.
Ctrl-C stops workers and records interrupted tasks for explicit review/retry.`;
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') { console.log(HELP); return; }
  if (!['plan', 'run', 'watch', 'status', 'approve', 'retry'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const opts = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--config', '--env-file', '--task'].includes(args[i]) || !args[i + 1]) throw new Error('Expected --config <file>, --env-file <file>, or --task <id>');
    opts[args[i].slice(2)] = args[i + 1];
  }
  const scheduler = await schedulerFromConfig(opts.config, { envFile: opts['env-file'], onEvent: event => console.error(JSON.stringify(event)) });
  if (command === 'plan') { console.log(JSON.stringify(await scheduler.plan(), null, 2)); return; }
  if (command === 'status') { console.log(JSON.stringify(await scheduler.store.read(), null, 2)); return; }
  if (command === 'approve' || command === 'retry') {
    if (!opts.task) throw new Error('--task is required');
    const unlock = await scheduler.store.lock();
    try {
      const state = await scheduler.store.read(), record = state.tasks[opts.task];
      if (!record) throw new Error(`Unknown task: ${opts.task}`);
      if (command === 'approve') {
        if (record.status !== 'review') throw new Error('Only review tasks may be approved');
        record.status = 'done'; record.approvedAt = Date.now();
      } else {
        if (!['failed', 'interrupted', 'needs_attention', 'auth_error', 'quota_blocked'].includes(record.status)) throw new Error('Task is not retryable');
        record.status = record.sessionId ? 'quota_blocked' : 'pending'; record.attempts = 0; record.retryAt = 0; delete record.reason;
      }
      await scheduler.store.write(state); console.log(`${opts.task}: ${record.status}`);
    } finally { await unlock(); }
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await scheduler.run({ watch: command === 'watch', signal: controller.signal }); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
