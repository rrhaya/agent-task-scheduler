import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { QuotaPolicy } from './quota.mjs';
import { GitWorktreeManager } from './workspaces.mjs';

const TERMINAL = new Set(['done', 'review', 'failed', 'needs_attention', 'auth_error', 'interrupted']);

export class Scheduler {
  constructor({ source, store, agents, policy = new QuotaPolicy(), maxParallel = 3, pollIntervalMs = 60_000, maxAttempts = 10, settleMs = 60_000, warmup = null, onEvent = () => {} }) {
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || !Number.isInteger(maxAttempts) || maxAttempts < 1 || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 10 || !Number.isFinite(settleMs) || settleMs < 0) throw new Error('Invalid scheduler limits');
    if (!agents || !Object.keys(agents).length) throw new Error('At least one agent is required');
    Object.assign(this, { source, store, agents, policy, maxParallel, pollIntervalMs, maxAttempts, settleMs, warmup, onEvent });
    this.workspaces = new GitWorktreeManager(store.directory);
    this.active = new Map(); this.recent = []; this.persistence = Promise.resolve();
  }
  emit(type, values = {}) { try { this.onEvent({ type, at: Date.now(), ...values }); } catch {} }
  save() { this.persistence = this.persistence.then(() => this.store.write(this.state)); return this.persistence; }
  async snapshots() {
    const pairs = await Promise.all(Object.entries(this.agents).map(async ([id, adapter]) => {
      try { return [id, await adapter.readQuota()]; }
      catch (error) { this.emit('quota_error', { agent: id, message: error.message }); return [id, { known: false, observedAt: Date.now(), windows: [] }]; }
    }));
    return Object.fromEntries(pairs);
  }
  reconcile(tasks) {
    for (const task of tasks) {
      const record = this.state.tasks[task.id];
      if (!record) this.state.tasks[task.id] = { status: task.initialStatus === 'done' ? 'done' : 'pending', attempts: 0, fingerprint: task.fingerprint };
      else if (record.fingerprint !== task.fingerprint) {
        if (record.status === 'pending' && !record.attempts) record.fingerprint = task.fingerprint;
        else throw new Error(`Task ${task.id} changed after execution began. Use a new id or restore its original definition.`);
      }
      if (task.initialStatus === 'done' && this.state.tasks[task.id].status !== 'running') this.state.tasks[task.id].status = 'done';
    }
  }
  reservationList(agentId, now) {
    this.recent = this.recent.filter(r => r.until > now);
    const pool = this.agents[agentId]?.quotaPool ?? agentId;
    return [...this.active.values(), ...this.recent].filter(r => (this.agents[r.agent]?.quotaPool ?? r.agent) === pool).map(r => r.task);
  }
  pickAgent(task, record, snapshots, now) {
    const ids = record.agent ? [record.agent] : task.agent === 'auto' ? Object.keys(this.agents) : [task.agent];
    const decisions = ids.map(id => ({ id, ...this.policy.evaluate(task, snapshots[id], this.reservationList(id, now), now) }));
    return decisions.filter(d => d.allowed).sort((a, b) => b.headroom - a.headroom)[0] ?? { allowed: false, reason: decisions.map(d => `${d.id}:${d.reason}`).join(', ') };
  }
  directoryBusy(task) {
    // Explicit directory tasks share a resource lock; worktrees may run concurrently.
    return task.isolation === 'directory' && [...this.active.values()].some(r => r.task.cwd === task.cwd);
  }
  async plan() {
    const tasks = await this.source.list();
    const state = await this.store.read(), snapshots = await this.snapshots();
    const reservations = {}; let slots = this.maxParallel; const directories = new Set();
    return tasks.sort((a, b) => b.priority - a.priority).map(task => {
      const record = state.tasks[task.id] ?? { status: task.initialStatus === 'done' ? 'done' : 'pending' };
      if (record.fingerprint && record.fingerprint !== task.fingerprint) return { id: task.id, allowed: false, reason: 'definition_changed' };
      if (TERMINAL.has(record.status) || record.status === 'running') return { id: task.id, allowed: false, reason: record.status };
      if (task.dependsOn.some(id => (state.tasks[id]?.status ?? tasks.find(t => t.id === id)?.initialStatus) !== 'done')) return { id: task.id, allowed: false, reason: 'dependencies_not_done' };
      if (!slots || (task.isolation === 'directory' && directories.has(task.cwd))) return { id: task.id, allowed: false, reason: 'parallel_limit' };
      if (record.retryAt > Date.now()) return { id: task.id, allowed: false, reason: 'retry_backoff' };
      const ids = record.agent ? [record.agent] : task.agent === 'auto' ? Object.keys(this.agents) : [task.agent];
      const decision = ids.map(id => ({ agent: id, ...this.policy.evaluate(task, snapshots[id], reservations[this.agents[id]?.quotaPool ?? id] ?? []) })).filter(x => x.allowed).sort((a, b) => b.headroom - a.headroom)[0];
      if (decision) { (reservations[this.agents[decision.agent]?.quotaPool ?? decision.agent] ??= []).push(task); slots--; if (task.isolation === 'directory') directories.add(task.cwd); }
      return decision ? { id: task.id, ...decision } : { id: task.id, allowed: false, reason: 'quota_unavailable' };
    });
  }
  async launch(task, agentId, signal) {
    const record = this.state.tasks[task.id];
    const slot = { task, agent: agentId }; this.active.set(task.id, slot);
    record.agent = agentId; record.status = 'running'; record.attempts += 1; record.startedAt = Date.now(); delete record.reason;
    await this.save();
    slot.promise = (async () => {
      try {
        Object.assign(record, await this.workspaces.prepare(task, record));
        await this.save();
        const logDir = path.join(this.store.directory, 'logs'); await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
        const key = createHash('sha256').update(task.id).digest('hex').slice(0, 12);
        record.logFile = path.join(logDir, `${key}-${record.attempts}.jsonl`);
        this.emit('task_started', { id: task.id, agent: agentId, workspace: record.workspace, attempt: record.attempts });
        const result = await this.agents[agentId].run(task, {
          cwd: record.workspace, sessionId: record.sessionId, signal, logFile: record.logFile,
          onSession: id => { record.sessionId = id; this.save().catch(() => {}); },
        });
        if (!['review', 'quota_blocked', 'failed', 'needs_attention', 'auth_error', 'interrupted'].includes(result.status)) throw new Error(`Invalid adapter result: ${result.status}`);
        Object.assign(record, result, { endedAt: Date.now() });
        if (result.status === 'quota_blocked') {
          if (!record.sessionId) { record.status = 'needs_attention'; record.reason = 'Limit reached without a resumable session; inspect before retrying'; }
          else record.retryAt = Date.now() + Math.max(this.pollIntervalMs, 30_000);
        }
        if (record.attempts >= this.maxAttempts && record.status === 'quota_blocked') { record.status = 'needs_attention'; record.reason = 'Maximum resume attempts reached'; }
        this.emit('task_finished', { id: task.id, status: record.status, sessionId: record.sessionId });
      } catch (error) { record.status = 'failed'; record.error = error.message; record.endedAt = Date.now(); this.emit('task_failed', { id: task.id, message: error.message }); }
      finally {
        this.active.delete(task.id);
        this.recent.push({ ...slot, until: Date.now() + this.settleMs });
        await this.save();
      }
    })();
    // Retain rejection for await below; avoid an unhandled rejection during the polling interval.
    slot.promise.catch(() => {});
  }
  warmupKey(now = Date.now()) {
    if (!this.warmup) return null;
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: this.warmup.timeZone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    const at = `${p.hour}:${p.minute}`;
    return this.warmup.at.includes(at) ? `${p.year}-${p.month}-${p.day}T${at}` : null;
  }
  async maybeWarmup(tasks, snapshots, signal) {
    const key = this.warmupKey();
    if (!key || this.active.size || tasks.some(t => ['pending', 'quota_blocked'].includes(this.state.tasks[t.id].status))) return;
    for (const id of this.warmup.agents ?? Object.keys(this.agents)) {
      if (!this.agents[id] || this.state.warmups[`${id}:${key}`]) continue;
      const snapshot = snapshots[id];
      const short = snapshot?.windows?.filter(w => w.durationMins === 300) ?? [];
      if (!short.length || short.some(w => w.resetsAt != null)) continue;
      const task = { id: `warmup-${id}`, prompt: 'Do not use any tools. Reply only OK.', warmup: true };
      if (!this.policy.evaluate(task, snapshot).allowed) continue;
      // Persist before sending to prevent duplicate sends after a crash; missed pings are safer than replay.
      this.state.warmups[`${id}:${key}`] = { startedAt: Date.now() }; await this.save();
      const cwd = path.join(this.store.directory, 'warmup'); await fs.mkdir(cwd, { recursive: true });
      try { const result = await this.agents[id].run(task, { cwd, signal }); this.state.warmups[`${id}:${key}`].status = result.status; }
      catch (e) { this.state.warmups[`${id}:${key}`].status = 'failed'; }
      this.emit('warmup_finished', { agent: id, status: this.state.warmups[`${id}:${key}`].status }); await this.save();
    }
  }
  async run({ watch = false, signal } = {}) {
    if (this.running) throw new Error('This scheduler is already running');
    this.running = true;
    let unlock;
    const externalSignal = signal;
    const runController = new AbortController();
    const stop = () => runController.abort();
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    signal = runController.signal;
    try {
      unlock = await this.store.lock(); this.state = await this.store.read(); this.state.warmups ??= {};
      for (const record of Object.values(this.state.tasks)) if (record.status === 'running') { record.status = 'needs_attention'; record.reason = 'Previous process ended during execution; inspect the session and worktree before explicit retry'; }
      await this.save();
      while (!signal?.aborted) {
        const tasks = await this.source.list(); this.reconcile(tasks);
        for (const t of tasks) if (t.agent !== 'auto' && !this.agents[t.agent]) throw new Error(`Unknown agent ${t.agent} in ${t.id}`);
        const snapshots = await this.snapshots();
        for (const task of tasks.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))) {
          if (signal?.aborted || this.active.size >= this.maxParallel) break;
          const record = this.state.tasks[task.id], now = Date.now();
          if (!['pending', 'quota_blocked'].includes(record.status) || record.retryAt > now || this.directoryBusy(task)) continue;
          if (task.dependsOn.some(id => this.state.tasks[id]?.status !== 'done')) { record.reason = 'dependencies_not_done'; continue; }
          const decision = this.pickAgent(task, record, snapshots, now);
          if (!decision.allowed) { record.reason = decision.reason; continue; }
          await this.launch(task, decision.id, signal);
        }
        await this.save(); await this.maybeWarmup(tasks, snapshots, signal);
        if (!this.active.size && !watch) break;
        const activePromises = [...this.active.values()].map(s => s.promise);
        const timerController = new AbortController();
        const cancelTimer = () => timerController.abort();
        signal.addEventListener('abort', cancelTimer, { once: true });
        try { await Promise.race([delay(this.pollIntervalMs, undefined, { signal: timerController.signal }), ...activePromises]); }
        catch (error) { if (error.name !== 'AbortError') throw error; }
        finally { timerController.abort(); signal.removeEventListener('abort', cancelTimer); }
      }
      return this.state;
    } finally {
      runController.abort();
      await Promise.allSettled([...this.active.values()].map(s => s.promise));
      await this.persistence.catch(() => {});
      externalSignal?.removeEventListener('abort', stop);
      if (unlock) await unlock(); this.running = false;
    }
  }
}
