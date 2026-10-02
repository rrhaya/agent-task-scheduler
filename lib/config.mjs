import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JsonTaskSource, MarkdownDirectorySource, CombinedTaskSource, GitHubIssuesSource } from './sources.mjs';
import { FileStateStore } from './store.mjs';
import { CodexAdapter, ClaudeCodeAdapter } from './adapters.mjs';
import { FileQuotaReader, CommandQuotaReader, UnknownQuotaReader, QuotaPolicy } from './quota.mjs';
import { safeIdentifier } from './security.mjs';
import { Scheduler } from './scheduler.mjs';

export async function schedulerFromConfig(file, { onEvent } = {}) {
  const configFile = path.resolve(file), base = path.dirname(configFile);
  const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  if (config.version !== 1) throw new Error('Config version must be 1');
  if (!Array.isArray(config.sources) || !config.sources.length) throw new Error('Configure at least one task source');
  const sources = config.sources.map(s => {
    if (s.type === 'github-issues') return new GitHubIssuesSource({ ...s, baseDir: base });
    if (!s.path || typeof s.path !== 'string') throw new Error('Source path is required');
    if (s.type === 'json') return new JsonTaskSource(path.resolve(base, s.path));
    if (s.type === 'markdown-directory') return new MarkdownDirectorySource(path.resolve(base, s.path));
    throw new Error(`Unknown task source type: ${s.type}`);
  });
  if (!config.agents || Array.isArray(config.agents) || !Object.keys(config.agents).length) throw new Error('Configure at least one agent');
  const agents = Object.create(null);
  for (const [id, settings] of Object.entries(config.agents)) {
    if (!safeIdentifier(id)) throw new Error(`Invalid agent id ${id}`);
    if (!settings || !['codex', 'claude-code'].includes(settings.type)) throw new Error(`Unknown agent type: ${settings?.type}`);
    if (settings.command !== undefined && typeof settings.command !== 'string') throw new Error('Agent command must be an executable path');
    if (settings.timeoutMs !== undefined && (!Number.isFinite(settings.timeoutMs) || settings.timeoutMs <= 0)) throw new Error('Invalid agent timeoutMs');
    const env = settings.env;
    let quotaReader;
    if (settings.quota) {
      const q = settings.quota;
      if (q.type === 'file' && typeof q.path === 'string') quotaReader = new FileQuotaReader(path.resolve(base, q.path));
      else if (q.type === 'command' && Array.isArray(q.argv) && q.argv.length && q.argv.every(x => typeof x === 'string')) quotaReader = new CommandQuotaReader(q.argv, settings.type === 'codex' ? 'codex' : 'claude');
      else if (q.type === 'unknown') quotaReader = new UnknownQuotaReader();
      else throw new Error(`Invalid quota reader for ${id}`);
    }
    agents[id] = settings.type === 'codex' ? new CodexAdapter({ ...settings, env, quotaReader }) : new ClaudeCodeAdapter({ ...settings, env, quotaReader });
  }
  if (config.warmup) {
    if (!Array.isArray(config.warmup.at) || config.warmup.at.some(x => !/^([01]\d|2[0-3]):[0-5]\d$/.test(x))) throw new Error('warmup.at must contain HH:MM times');
    new Intl.DateTimeFormat('en', { timeZone: config.warmup.timeZone ?? 'UTC' });
    if (config.warmup.agents && (!Array.isArray(config.warmup.agents) || config.warmup.agents.some(id => !agents[id]))) throw new Error('Unknown warmup agent');
  }
  const stateDir = config.stateDir ? path.resolve(base, config.stateDir) : path.join(os.homedir(), '.local', 'state', 'agent-task-scheduler');
  return new Scheduler({ source: new CombinedTaskSource(sources), store: new FileStateStore(stateDir), agents, policy: new QuotaPolicy(config.policy), maxParallel: config.maxParallel ?? 3, pollIntervalMs: config.pollIntervalMs ?? 60_000, maxAttempts: config.maxAttempts ?? 10, settleMs: config.settleMs ?? 60_000, warmup: config.warmup, onEvent });
}
