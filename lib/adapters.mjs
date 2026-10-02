import { agentEnvironment, validateSessionId } from './security.mjs';
import { runProcess } from './process.mjs';
import { CodexQuotaReader, UnknownQuotaReader } from './quota.mjs';

const CONTINUE = 'Continue the task interrupted by a usage limit. Inspect the current files and previous tool results first; continue only unfinished work and do not repeat completed side effects.';
function failure(messages) {
  const text = messages.join('\n');
  if (/permission_denied|permission request|permission.*denied|approval.*required/i.test(text)) return 'needs_attention';
  if (/unauthorized|authentication|invalid.*token|not logged in|login required/i.test(text)) return 'auth_error';
  if (/usage_limit|rate_limit|quota.*exceed|hit your.*limit|too many requests|\b429\b/i.test(text)) return 'quota_blocked';
  return 'failed';
}

export class CodexAdapter {
  constructor({ quotaPool = 'codex', command = 'codex', model, sandbox = 'workspace-write', env, timeoutMs, quotaReader } = {}) {
    if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('Codex sandbox must be read-only or workspace-write');
    env = agentEnvironment(env);
    Object.assign(this, { quotaPool, command, model, sandbox, env, timeoutMs });
    this.quotaReader = quotaReader ?? new CodexQuotaReader({ command, env });
  }
  readQuota() { return this.quotaReader.read(); }
  buildArgs(task, sessionId) {
    const args = ['exec'];
    if (sessionId) args.push('resume', validateSessionId(sessionId));
    args.push('--json', '--skip-git-repo-check');
    // Resume lacks --sandbox in some CLI versions; config overrides work for both paths.
    args.push('-c', `sandbox_mode=${JSON.stringify(task.warmup ? 'read-only' : this.sandbox)}`, '-c', 'approval_policy="never"');
    if (task.warmup) args.push('--ephemeral');
    if (this.model) args.push('--model', this.model);
    args.push('--', sessionId ? `${CONTINUE}\n\nOriginal task:\n${task.prompt}` : task.prompt);
    return args;
  }
  async run(task, { cwd, sessionId, signal, onSession, logFile }) {
    let completed = false, output = '', id = sessionId, errors = [], usage;
    const result = await runProcess(this.command, this.buildArgs(task, sessionId), {
      cwd, env: this.env, timeoutMs: this.timeoutMs, signal, logFile,
      onEvent(event) {
        if (event.type === 'thread.started' && event.thread_id) { id = validateSessionId(event.thread_id); onSession?.(id); }
        if (event.type === 'turn.completed') { completed = true; usage = event.usage; }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') output = event.item.text;
        if (event.type === 'turn.failed' || event.type === 'error') errors.push(JSON.stringify(event.error ?? event));
      },
    });
    if (result.aborted) return { status: 'interrupted', sessionId: id, output };
    if (completed && result.code === 0 && !errors.length) return { status: 'review', sessionId: id, output, usage };
    return { status: failure([...errors, result.stderr]), sessionId: id, output, error: [...errors, result.stderr].join('\n').slice(-4000) || 'No completed Codex turn was received' };
  }
}

export class ClaudeCodeAdapter {
  constructor({ quotaPool = 'claude', command = 'claude', model, allowedTools = [], env, timeoutMs, quotaReader } = {}) {
    if (!Array.isArray(allowedTools) || allowedTools.some(x => typeof x !== 'string')) throw new Error('allowedTools must be an array of strings');
    env = agentEnvironment(env);
    Object.assign(this, { quotaPool, command, model, allowedTools, env, timeoutMs });
    this.quotaReader = quotaReader ?? new UnknownQuotaReader();
  }
  readQuota() { return this.quotaReader.read(); }
  buildArgs(task, sessionId) {
    const args = ['-p', sessionId ? `${CONTINUE}\n\nOriginal task:\n${task.prompt}` : task.prompt, '--output-format', 'stream-json', '--verbose'];
    if (sessionId) args.push('--resume', validateSessionId(sessionId));
    if (this.model) args.push('--model', this.model);
    if (this.allowedTools.length) args.push('--allowedTools', this.allowedTools.join(','));
    // Never select bypassPermissions or bare mode; keep vendor credential and permission policy.
    return args;
  }
  async run(task, { cwd, sessionId, signal, onSession, logFile }) {
    let id = sessionId, final, errors = [];
    const result = await runProcess(this.command, this.buildArgs(task, sessionId), {
      cwd, env: this.env, timeoutMs: this.timeoutMs, signal, logFile,
      onEvent(event) {
        if (event.session_id && id !== event.session_id) { id = validateSessionId(event.session_id); onSession?.(id); }
        if (event.type === 'result') final = event;
        if (event.type === 'error') errors.push(JSON.stringify(event));
      },
    });
    if (result.aborted) return { status: 'interrupted', sessionId: id, output: final?.result ?? '' };
    if (final?.permission_denials?.length) return { status: 'needs_attention', sessionId: id, output: final.result, error: 'Tool permissions need review' };
    if (result.code === 0 && final && !final.is_error && final.subtype === 'success' && !errors.length) return { status: 'review', sessionId: id, output: final.result, usage: final.usage };
    const messages = [...errors, ...(final?.errors ?? []), final?.is_error ? final.result ?? final.subtype : '', result.stderr];
    return { status: failure(messages), sessionId: id, output: final?.result ?? '', error: messages.join('\n').slice(-4000) || 'No successful Claude result received' };
  }
}
