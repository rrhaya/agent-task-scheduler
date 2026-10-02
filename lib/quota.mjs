import fs from 'node:fs/promises';
import { safeIdentifier } from './security.mjs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { runProcess } from './process.mjs';

export function normalizeQuota(value, now = Date.now()) {
  if (!value || !Array.isArray(value.windows) || !Number.isFinite(value.observedAt)) return { known: false, observedAt: now, windows: [], reason: 'Missing quota observation' };
  const windows = value.windows.map(w => ({ ...w, reservePercent: w.reservePercent ?? 0 }));
  if (value.known === false || windows.some(w => !safeIdentifier(w.id) || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100 || !Number.isFinite(w.reservePercent) || w.reservePercent < 0 || w.reservePercent > 100 || !Number.isFinite(w.durationMins) || w.durationMins <= 0 || (w.resetsAt !== null && !Number.isFinite(w.resetsAt)))) return { known: false, observedAt: now, windows: [], reason: 'Invalid or unavailable quota' };
  if (new Set(windows.map(w => w.id)).size !== windows.length) return { known: false, observedAt: now, windows: [], reason: 'Duplicate quota window' };
  return { ...value, known: true, windows };
}

export class FileQuotaReader {
  constructor(file) { this.file = file; }
  async read() { return normalizeQuota(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
}
export class CommandQuotaReader {
  constructor(argv, provider) { this.argv = argv; this.provider = provider; }
  async read() {
    const result = await runProcess(this.argv[0], this.argv.slice(1), { timeoutMs: 15_000 });
    if (result.code !== 0 || result.aborted) throw new Error('Quota command failed');
    const data = JSON.parse(result.stdout);
    if (!Array.isArray(data)) return normalizeQuota(data);
    // Optional CCLimitPing bridge. It uses unofficial endpoints; the scheduler never reads OAuth tokens.
    const entry = data.find(x => x.provider === this.provider);
    if (!entry) return normalizeQuota(null);
    const windows = ['five_hour', 'weekly'].filter(key => entry[key]).map(key => ({
      id: key, usedPercent: entry[key].used_percent,
      durationMins: (entry[key].window_seconds ?? (key === 'five_hour' ? 18000 : 604800)) / 60,
      resetsAt: entry[key].resets_at ? Date.parse(entry[key].resets_at) : null,
    }));
    // Missing windows are not proof of an unlimited plan.
    return normalizeQuota({ known: windows.length > 0, observedAt: Date.now(), windows });
  }
}

export function normalizeCodexQuota(data, now = Date.now()) {
  const buckets = data.rateLimitsByLimitId ? Object.values(data.rateLimitsByLimitId) : data.rateLimits ? [data.rateLimits] : [];
  if (!buckets.length) return normalizeQuota(null, now);
  const windows = [];
  for (const bucket of buckets) {
    for (const key of ['primary', 'secondary']) {
      const w = bucket[key];
      if (!w) continue;
      const kind = w.windowDurationMins === 300 ? 'five_hour' : w.windowDurationMins === 10080 ? 'weekly' : `${bucket.limitId ?? 'codex'}_${key}`;
      windows.push({ id: buckets.length === 1 ? kind : `${bucket.limitId}_${kind}`, usedPercent: w.usedPercent, durationMins: w.windowDurationMins, resetsAt: w.resetsAt == null ? null : w.resetsAt * 1000 });
    }
  }
  // Empty limits require explicit configuration; never infer unlimited capacity.
  return normalizeQuota({ known: windows.length > 0, observedAt: now, windows }, now);
}

/** Official metadata protocol only: initialize and account/rateLimits/read; no inference calls. */
export class CodexQuotaReader {
  constructor({ command = 'codex', env = process.env, timeoutMs = 15_000 } = {}) { Object.assign(this, { command, env, timeoutMs }); }
  async read() {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, ['app-server', '--listen', 'stdio://'], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
      const lines = readline.createInterface({ input: child.stdout });
      let settled = false;
      const timer = setTimeout(() => finish(new Error('Codex quota read timed out')), this.timeoutMs);
      function finish(error, value) {
        if (settled) return; settled = true; clearTimeout(timer); lines.close(); child.stdin.end(); child.kill();
        error ? reject(error) : resolve(value);
      }
      function send(value) { child.stdin.write(JSON.stringify(value) + '\n'); }
      child.stdin.on('error', e => finish(e));
      child.stderr.resume();
      child.on('error', e => finish(e));
      child.on('exit', () => finish(new Error('Codex app-server closed before returning quota')));
      lines.on('line', line => {
        let message; try { message = JSON.parse(line); } catch { return; }
        if (message.error) return finish(new Error(message.error.message || 'Quota RPC failed'));
        if (message.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'account/rateLimits/read' }); }
        if (message.id === 2) finish(null, normalizeCodexQuota(message.result));
        // Reject unexpected server requests; do not answer token/approval requests automatically.
        if (message.method && message.id != null) send({ id: message.id, error: { code: -32601, message: 'Unsupported by quota reader' } });
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-task-scheduler', version: '0.1.0' }, capabilities: { experimentalApi: true } } });
    });
  }
}

export class UnknownQuotaReader {
  async read() { return normalizeQuota(null); }
}

export class QuotaPolicy {
  constructor({ reservePercent = 20, weeklyReservePercent = 30, defaultEstimatePercent = 5, weeklyEstimatePercent = 1, maxSnapshotAgeMs = 120_000, resetBufferMs = 30_000, allowUnlimited = false, safetyFactor = 1.5, fitBeforeReset = true } = {}) {
    Object.assign(this, { reservePercent, weeklyReservePercent, defaultEstimatePercent, weeklyEstimatePercent, maxSnapshotAgeMs, resetBufferMs, allowUnlimited, safetyFactor, fitBeforeReset });
    for (const [name, value] of Object.entries({ reservePercent, weeklyReservePercent, defaultEstimatePercent, weeklyEstimatePercent })) if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`Invalid policy ${name}`);
    if (!(safetyFactor >= 1) || !(maxSnapshotAgeMs > 0) || !(resetBufferMs >= 0)) throw new Error('Invalid policy timing/safety factor');
  }
  estimate(task, window) {
    const specific = task.estimatePercent && Object.hasOwn(task.estimatePercent, window.id) ? task.estimatePercent[window.id] : undefined;
    const estimate = specific ?? (window.durationMins >= 10080 ? this.weeklyEstimatePercent : this.defaultEstimatePercent);
    if (!Number.isFinite(estimate) || estimate < 0 || estimate > 100) throw new Error('Invalid task quota estimate');
    return estimate * this.safetyFactor;
  }
  evaluate(task, snapshot, reservations = [], now = Date.now()) {
    snapshot = normalizeQuota(snapshot, now);
    if (!snapshot.known || now - snapshot.observedAt > this.maxSnapshotAgeMs || snapshot.observedAt > now + 5000) return { allowed: false, reason: 'quota_unknown_or_stale' };
    if (!snapshot.windows.length && !this.allowUnlimited) return { allowed: false, reason: 'no_enforced_windows_confirmed' };
    let headroom = 100;
    for (const window of snapshot.windows) {
      // An expired timestamp needs a new server observation, never a local percentage reset.
      if (window.resetsAt != null && window.resetsAt <= now) return { allowed: false, reason: `await_reset_observation:${window.id}` };
      const reserve = Math.max(window.reservePercent, window.durationMins >= 10080 ? this.weeklyReservePercent : this.reservePercent);
      const committed = reservations.reduce((n, r) => n + this.estimate(r, window), 0);
      const available = 100 - window.usedPercent - reserve - committed;
      headroom = Math.min(headroom, available);
      if (this.estimate(task, window) > available) return { allowed: false, reason: `insufficient_headroom:${window.id}` };
      if (this.fitBeforeReset && window.durationMins < 10080 && task.estimatedMinutes && window.resetsAt && task.estimatedMinutes * 60000 + this.resetBufferMs > window.resetsAt - now) return { allowed: false, reason: `does_not_fit_before_reset:${window.id}` };
    }
    return { allowed: true, headroom, reason: 'available' };
  }
}
