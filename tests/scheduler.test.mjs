import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Scheduler, FileStateStore, QuotaPolicy, JsonTaskSource, MarkdownDirectorySource, CombinedTaskSource, GitHubIssuesSource, CodexAdapter, ClaudeCodeAdapter, normalizeCodexQuota, validateTasks, schedulerFromConfig } from '../lib/index.mjs';
import { runProcess } from '../lib/process.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-scheduler-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const quota = (used = 0, weekly = 0) => ({ known: true, observedAt: Date.now(), windows: [
  { id: 'five_hour', usedPercent: used, durationMins: 300, resetsAt: Date.now() + 3_600_000 },
  { id: 'weekly', usedPercent: weekly, durationMins: 10080, resetsAt: Date.now() + 7 * 86400_000 },
] });
function task(id, cwd, rest = {}) { return { id, cwd, isolation: 'directory', prompt: `Do ${id}`, ...rest }; }
function source(tasks) { return { list: async () => validateTasks(tasks, process.cwd()) }; }
function scheduler(dir, tasks, agents, options = {}) { return new Scheduler({ source: source(tasks), store: new FileStateStore(path.join(dir, 'state')), agents, pollIntervalMs: 10, settleMs: 0, ...options }); }

// Admission tests cover reported quota lag, all enforced windows and shared provider pools.
test('policy rejects unknown, stale, invalid, expired and weekly exhausted quotas', () => {
  const p = new QuotaPolicy(); const work = task('a', '.');
  assert.equal(p.evaluate(work, undefined).allowed, false);
  assert.equal(p.evaluate(work, { ...quota(), observedAt: Date.now() - 200_000 }).allowed, false);
  assert.equal(p.evaluate(work, quota(0, 100)).allowed, false);
  assert.equal(p.evaluate(work, { ...quota(), windows: [{ ...quota().windows[0], usedPercent: NaN }] }).allowed, false);
  assert.equal(p.evaluate(work, { ...quota(), windows: [{ ...quota().windows[0], resetsAt: Date.now() - 1 }] }).allowed, false);
  assert.equal(p.evaluate(work, { known: true, observedAt: Date.now(), windows: [] }).allowed, false);
  assert.equal(new QuotaPolicy({ allowUnlimited: true }).evaluate(work, { known: true, observedAt: Date.now(), windows: [] }).allowed, true);
  assert.equal(p.evaluate(work, quota()).allowed, true);
});
test('policy reserves the estimated cost of workers and respects time until reset', () => {
  const p = new QuotaPolicy({ reservePercent: 20, safetyFactor: 1 }); const work = task('a', '.');
  assert.equal(p.evaluate(work, quota(70), [work, work]).allowed, false);
  assert.equal(p.evaluate({ ...work, estimatedMinutes: 120 }, quota()).reason, 'does_not_fit_before_reset:five_hour');
});
test('Codex normalization handles multiple buckets without inventing missing limits', () => {
  const data = { rateLimitsByLimitId: { a: { limitId: 'a', primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 2000000000 } }, b: { limitId: 'b', primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 2000000001 } } } };
  const result = normalizeCodexQuota(data);
  assert.deepEqual(result.windows.map(w => w.id), ['a_five_hour', 'b_weekly']);
  assert.equal(result.windows[0].resetsAt, 2000000000000);
  assert.equal(normalizeCodexQuota({ rateLimits: { primary: null, secondary: null } }).known, false);
});
test('parallel queue fills available slots and retains reviews without rerunning them', async t => {
  const dir = await fixture(t); let active = 0, peak = 0, calls = 0;
  const adapter = { readQuota: async () => quota(), run: async (work, ctx) => {
    calls++; active++; peak = Math.max(peak, active); ctx.onSession(`session-${work.id}`); await delay(20); active--; return { status: 'review', output: 'verified' };
  } };
  const tasks = ['a', 'b', 'c', 'd'].map(id => task(id, path.join(dir, id)));
  for (const work of tasks) await fs.mkdir(work.cwd);
  const s = scheduler(dir, tasks, { codex: adapter }, { maxParallel: 3 });
  const state = await s.run();
  assert.equal(peak, 3); assert.equal(calls, 4);
  assert.ok(Object.values(state.tasks).every(r => r.status === 'review' && r.sessionId));
  await s.run(); assert.equal(calls, 4);
});
test('same account pool shares reservations even across multiple model adapters', async t => {
  const dir = await fixture(t); await fs.mkdir(path.join(dir, 'b'));
  let calls = 0;
  const adapter = { quotaPool: 'same-account', readQuota: async () => quota(70), run: async () => { calls++; await delay(30); return { status: 'review' }; } };
  const s = scheduler(dir, [task('a', dir, { agent: 'one' }), task('b', path.join(dir, 'b'), { agent: 'two' })], { one: adapter, two: adapter }, { settleMs: 60_000 });
  const state = await s.run(); assert.equal(calls, 1); assert.equal(state.tasks.b.status, 'pending');
});
test('resume uses exact recorded session and retains provider after recovery', async t => {
  const dir = await fixture(t); const sessions = []; let count = 0;
  const adapter = { readQuota: async () => quota(), run: async (work, ctx) => { sessions.push(ctx.sessionId); ctx.onSession('specific-session'); return { status: ++count === 1 ? 'quota_blocked' : 'review', sessionId: 'specific-session' }; } };
  const s = scheduler(dir, [task('a', dir)], { codex: adapter });
  let state = await s.run(); assert.equal(state.tasks.a.status, 'quota_blocked');
  state.tasks.a.retryAt = 0; await s.store.write(state);
  state = await s.run(); assert.equal(state.tasks.a.status, 'review'); assert.deepEqual(sessions, [undefined, 'specific-session']);
});
test('weekly exhaustion prevents automatic resume even if short window recovered', async t => {
  const dir = await fixture(t); const tasks = await source([task('a', dir)]).list();
  const s = scheduler(dir, [task('a', dir)], { codex: { readQuota: async () => quota(0, 100), run: async () => assert.fail('must not run') } });
  await s.store.write({ version: 1, warmups: {}, tasks: { a: { status: 'quota_blocked', agent: 'codex', sessionId: 's', fingerprint: tasks[0].fingerprint, attempts: 1 } } });
  const state = await s.run(); assert.equal(state.tasks.a.status, 'quota_blocked');
});
test('quota failure without session is held for attention rather than replayed', async t => {
  const dir = await fixture(t); const s = scheduler(dir, [task('a', dir)], { codex: { readQuota: async () => quota(), run: async () => ({ status: 'quota_blocked' }) } });
  assert.equal((await s.run()).tasks.a.status, 'needs_attention');
});
test('crash recovery does not repeat uncertain side effects', async t => {
  const dir = await fixture(t); const tasks = await source([task('a', dir)]).list();
  const s = scheduler(dir, [task('a', dir)], { codex: { readQuota: async () => quota(), run: async () => assert.fail('must not replay') } });
  await s.store.write({ version: 1, tasks: { a: { status: 'running', attempts: 1, sessionId: 's', fingerprint: tasks[0].fingerprint } } });
  assert.equal((await s.run()).tasks.a.status, 'needs_attention');
});
test('dependencies stay blocked until explicit approval, then run on the next pass', async t => {
  const dir = await fixture(t); await fs.mkdir(path.join(dir, 'b')); const seen = [];
  const s = scheduler(dir, [task('a', dir), task('b', path.join(dir, 'b'), { dependsOn: ['a'] })], { codex: { readQuota: async () => quota(), run: async work => { seen.push(work.id); return { status: 'review' }; } } });
  const state = await s.run(); assert.deepEqual(seen, ['a']); assert.equal(state.tasks.b.status, 'pending');
  state.tasks.a.status = 'done'; await s.store.write(state); await s.run(); assert.deepEqual(seen, ['a', 'b']);
});
test('directory tasks are serialized and state locks reject duplicate supervisors', async t => {
  const dir = await fixture(t); let live = 0;
  const s = scheduler(dir, [task('a', dir), task('b', dir)], { codex: { readQuota: async () => quota(), run: async () => { assert.equal(++live, 1); await delay(10); live--; return { status: 'review' }; } } });
  const unlock = await s.store.lock(); await assert.rejects(s.run(), /locked/); await unlock(); await s.run();
});
test('dry-run reads sources without creating state or starting workers and respects maxParallel', async t => {
  const dir = await fixture(t);
  const s = scheduler(dir, [task('a', dir), task('b', path.join(dir, 'b'))], { codex: { readQuota: async () => quota(), run: async () => assert.fail() } }, { maxParallel: 1 });
  assert.deepEqual((await s.plan()).map(x => x.allowed), [true, false]); await assert.rejects(fs.access(s.store.directory));
});
test('task sources validate dependency cycles, duplicate IDs, and resolve paths', async t => {
  const dir = await fixture(t); await fs.writeFile(path.join(dir, 'tasks.json'), JSON.stringify([task('json', './repo')]));
  await fs.mkdir(path.join(dir, 'md')); await fs.writeFile(path.join(dir, 'md', 'markdown.md'), '```task-json\n{"cwd":"../repo","agent":"claude"}\n```\nFix docs.');
  const list = await new CombinedTaskSource([new JsonTaskSource(path.join(dir, 'tasks.json')), new MarkdownDirectorySource(path.join(dir, 'md'))]).list();
  assert.equal(list.length, 2); assert.equal(list[1].cwd, path.join(dir, 'repo'));
  assert.throws(() => validateTasks([task('a', dir, { dependsOn: ['b'] }), task('b', dir, { dependsOn: ['a'] })], dir), /cycle/);
  assert.throws(() => validateTasks([task('a', dir), task('a', dir)], dir), /Duplicate/);
});

async function executable(dir, filename, body) {
  const file = path.join(dir, filename); await fs.writeFile(file, '#!/usr/bin/env node\n' + body, { mode: 0o700 }); return file;
}
test('GitHub source filters labels, fixes cwd/provider, and loads closed dependencies', async t => {
  const dir = await fixture(t); const argsFile = path.join(dir, 'args.json');
  const issues = [
    { number: 1, title: 'Prerequisite', body: '', state: 'CLOSED', url: 'https://github.com/a/b/issues/1' },
    { number: 2, title: 'Implementation', body: '```task-json\n{"dependsOn":[1],"priority":7,"cwd":"/evil","agent":"evil"}\n```\nFix it.', state: 'OPEN', url: 'https://github.com/a/b/issues/2' },
  ];
  const gh = await executable(dir, 'fake-gh', `require('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2))); console.log(${JSON.stringify(JSON.stringify(issues))});`);
  const list = await new GitHubIssuesSource({ repository: 'a/b', cwd: dir, agent: 'codex', command: gh }).list();
  assert.equal(list[0].initialStatus, 'done'); assert.deepEqual(list[1].dependsOn, ['a.b.1']); assert.equal(list[1].cwd, dir); assert.equal(list[1].agent, 'codex');
  const args = JSON.parse(await fs.readFile(argsFile)); assert.ok(args.includes('agent-ready')); assert.ok(args.includes('all'));
});
test('Codex CLI adapter verifies turn completion and classifies structured quota failures', async t => {
  const dir = await fixture(t);
  const binary = await executable(dir, 'fake-codex', `console.log(JSON.stringify({type:'thread.started',thread_id:'exact'})); console.log(JSON.stringify({type:'turn.failed',error:{message:'usage_limit_exceeded'}})); process.exitCode=1;`);
  const adapter = new CodexAdapter({ command: binary }); let id;
  const result = await adapter.run(task('a', dir), { cwd: dir, onSession: value => id = value });
  assert.equal(id, 'exact'); assert.equal(result.status, 'quota_blocked');
  assert.ok(adapter.buildArgs(task('a', dir), 'exact').includes('exact')); assert.ok(!adapter.buildArgs(task('a', dir), 'exact').includes('--last'));
});
test('Claude CLI adapter reads exact session and holds denied permissions', async t => {
  const dir = await fixture(t);
  const binary = await executable(dir, 'fake-claude', `console.log(JSON.stringify({type:'system',session_id:'claude-session'})); console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done',permission_denials:[{tool_name:'Bash'}]}));`);
  const adapter = new ClaudeCodeAdapter({ command: binary });
  assert.equal((await adapter.run(task('a', dir), { cwd: dir })).status, 'needs_attention');
  assert.ok(adapter.buildArgs(task('a', dir), 's').includes('--resume')); assert.ok(!adapter.buildArgs(task('a', dir)).includes('--bare'));
});
test('worker process terminates promptly on abort', async () => {
  const controller = new AbortController(); const promise = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  assert.equal((await promise).aborted, true);
});
test('changed executed task definitions are rejected, configuration remains library-friendly', async t => {
  const dir = await fixture(t);
  const tasksFile = path.join(dir, 'tasks.json'); await fs.writeFile(tasksFile, JSON.stringify([task('a', dir)]));
  const config = path.join(dir, 'config.json'); await fs.writeFile(config, JSON.stringify({ version: 1, stateDir: './state', sources: [{ type: 'json', path: './tasks.json' }], agents: { codex: { type: 'codex', quota: { type: 'unknown' } } } }));
  const s = await schedulerFromConfig(config); assert.equal((await s.plan())[0].allowed, false);
  const tasks = await s.source.list(); await s.store.write({ version: 1, warmups: {}, tasks: { a: { status: 'review', attempts: 1, fingerprint: tasks[0].fingerprint } } });
  await fs.writeFile(tasksFile, JSON.stringify([task('a', dir, { prompt: 'different' })]));
  await assert.rejects(s.run(), /changed/);
});
test('real git worktrees preserve main checkout and are reused for continuation', async t => {
  const dir = await fixture(t); const repo = path.join(dir, 'repo'); await fs.mkdir(repo);
  for (const args of [['init', '-b', 'main'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial']]) assert.equal((await runProcess('git', args, { cwd: repo })).code, 0);
  let workspace;
  const s = scheduler(dir, [task('git-task', repo, { isolation: 'worktree' })], { codex: { readQuota: async () => quota(), run: async (work, ctx) => { workspace = ctx.cwd; await fs.writeFile(path.join(ctx.cwd, 'result.txt'), 'implementation'); return { status: 'review' }; } } });
  const state = await s.run(); assert.equal(state.tasks['git-task'].workspace, workspace); assert.notEqual(workspace, repo); await assert.rejects(fs.access(path.join(repo, 'result.txt'))); assert.equal(await fs.readFile(path.join(workspace, 'result.txt'), 'utf8'), 'implementation');
});

test('watch resumes a blocked task only after quota recovery, then stops cleanly', async t => {
  const dir = await fixture(t); const controller = new AbortController(); let limited = false, attempts = 0;
  const adapter = {
    readQuota: async () => quota(limited ? 100 : 0),
    run: async (work, ctx) => {
      ctx.onSession('watch-session'); attempts++;
      if (attempts === 1) { limited = true; setTimeout(() => { limited = false; }, 30); return { status: 'quota_blocked', sessionId: 'watch-session' }; }
      assert.equal(ctx.sessionId, 'watch-session'); controller.abort(); return { status: 'review', sessionId: 'watch-session' };
    }
  };
  const s = scheduler(dir, [task('a', dir)], { codex: adapter });
  // The production minimum quota-retry delay is 30s; advance only the durable deadline in this test.
  const save = s.save.bind(s);
  s.save = () => { if (s.state.tasks.a?.status === 'quota_blocked') s.state.tasks.a.retryAt = 0; return save(); };
  const watchdog = setTimeout(() => controller.abort(), 1000); t.after(() => clearTimeout(watchdog));
  const state = await s.run({ watch: true, signal: controller.signal }); assert.equal(attempts, 2); assert.equal(state.tasks.a.status, 'review');
});
test('warmup is opt-in, deduplicated, and only sent when no queued work exists', async t => {
  const dir = await fixture(t); let calls = 0;
  const adapter = { readQuota: async () => ({ ...quota(), windows: [{ ...quota().windows[0], resetsAt: null }, quota().windows[1]] }), run: async work => { assert.equal(work.warmup, true); calls++; return { status: 'review' }; } };
  const s = scheduler(dir, [], { codex: adapter }, { warmup: { at: ['00:00'] } }); s.warmupKey = () => 'scheduled-minute';
  await s.run(); await s.run(); assert.equal(calls, 1);
});
test('closed GitHub tasks in persisted pending state are never started', async t => {
  const dir = await fixture(t); const work = task('closed', dir, { initialStatus: 'done' });
  const s = scheduler(dir, [work], { codex: { readQuota: async () => quota(), run: async () => assert.fail('closed issue must not execute') } });
  const [def] = await s.source.list(); await s.store.write({ version: 1, tasks: { closed: { status: 'pending', attempts: 0, fingerprint: def.fingerprint } } });
  assert.equal((await s.run()).tasks.closed.status, 'done');
});
