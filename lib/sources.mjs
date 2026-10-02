import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function validateTasks(tasks, baseDir) {
  if (!Array.isArray(tasks)) throw new Error('Task source must contain an array of tasks');
  const ids = new Set();
  const result = tasks.map(raw => {
    if (!raw || typeof raw.id !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(raw.id)) throw new Error('Task id must contain only letters, numbers, dots, underscores or hyphens');
    if (ids.has(raw.id)) throw new Error(`Duplicate task: ${raw.id}`);
    ids.add(raw.id);
    if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) throw new Error(`Missing prompt: ${raw.id}`);
    if (typeof raw.cwd !== 'string' || !raw.cwd.trim()) throw new Error(`Missing cwd: ${raw.id}`);
    const task = { ...raw, cwd: path.resolve(baseDir, raw.cwd), title: raw.title || raw.id, priority: raw.priority ?? 0, dependsOn: raw.dependsOn ?? [], agent: raw.agent ?? 'auto', isolation: raw.isolation ?? 'worktree' };
    if (!Number.isFinite(task.priority) || !Array.isArray(task.dependsOn) || task.dependsOn.some(x => typeof x !== 'string')) throw new Error(`Invalid priority/dependencies: ${raw.id}`);
    if (!['worktree', 'directory'].includes(task.isolation)) throw new Error(`Invalid isolation: ${raw.id}`);
    if (raw.estimatedMinutes !== undefined && (!Number.isFinite(raw.estimatedMinutes) || raw.estimatedMinutes <= 0)) throw new Error(`Invalid estimatedMinutes: ${raw.id}`);
    if (raw.estimatePercent !== undefined && (!raw.estimatePercent || typeof raw.estimatePercent !== 'object' || Array.isArray(raw.estimatePercent) || Object.values(raw.estimatePercent).some(x => !Number.isFinite(x) || x <= 0 || x > 100))) throw new Error(`Invalid estimatePercent: ${raw.id}`);
    const { initialStatus, ...definition } = task;
    task.fingerprint = createHash('sha256').update(JSON.stringify(definition)).digest('hex');
    return task;
  });
  const byId = new Map(result.map(t => [t.id, t]));
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error(`Dependency cycle at ${id}`);
    if (visited.has(id)) return;
    if (!byId.has(id)) throw new Error(`Unknown dependency: ${id}`);
    visiting.add(id);
    for (const dep of byId.get(id).dependsOn) visit(dep);
    visiting.delete(id); visited.add(id);
  }
  result.forEach(t => visit(t.id));
  return result;
}

/** Read-only inputs: execution state is stored separately, never written into task files. */
export class JsonTaskSource {
  constructor(file) { this.file = path.resolve(file); }
  async list() {
    const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
    return validateTasks(Array.isArray(data) ? data : data.tasks, path.dirname(this.file));
  }
}

/** Markdown starts with a fenced task-json metadata block; remaining text is the prompt. */
export class MarkdownDirectorySource {
  constructor(directory) { this.directory = path.resolve(directory); }
  async list() {
    const tasks = [];
    for (const name of (await fs.readdir(this.directory)).sort()) {
      if (!name.endsWith('.md')) continue;
      const content = await fs.readFile(path.join(this.directory, name), 'utf8');
      const match = /^```task-json\s*\n([\s\S]*?)\n```\s*\n([\s\S]*)$/.exec(content);
      if (!match) throw new Error(`${name}: expected a task-json metadata block`);
      tasks.push({ id: path.basename(name, '.md'), ...JSON.parse(match[1]), prompt: match[2].trim() });
    }
    return validateTasks(tasks, this.directory);
  }
}

export class CombinedTaskSource {
  constructor(sources) { this.sources = sources; }
  async list() {
    const lists = await Promise.all(this.sources.map(s => s.list()));
    // IDs are globally unique across sources, permitting cross-source dependencies.
    return validateTasks(lists.flat().map(({ fingerprint, ...task }) => task), process.cwd());
  }
}

/** Read selected GitHub Issues through the user's existing gh login; never posts/closes issues. */
export class GitHubIssuesSource {
  constructor({ repository, cwd, labels = ['agent-ready'], agent = 'auto', command = 'gh', maxIssues = 1000, baseDir = process.cwd() }) {
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository ?? '')) throw new Error('GitHub repository must be owner/repo');
    if (typeof cwd !== 'string' || !cwd) throw new Error('GitHub source cwd is required');
    if (!Array.isArray(labels) || !labels.length || labels.some(x => typeof x !== 'string' || !x)) throw new Error('Configure at least one GitHub task label');
    if (!Number.isInteger(maxIssues) || maxIssues < 1 || maxIssues > 10000) throw new Error('Invalid maxIssues');
    Object.assign(this, { repository, cwd: path.resolve(baseDir, cwd), labels, agent, command, maxIssues });
  }
  async list() {
    const { runProcess } = await import('./process.mjs');
    const args = ['issue', 'list', '--repo', this.repository, '--state', 'all', '--limit', String(this.maxIssues), '--json', 'number,title,body,url,labels,state'];
    for (const label of this.labels) args.push('--label', label);
    const result = await runProcess(this.command, args, { timeoutMs: 30_000, maxCapture: 16_000_000 });
    if (result.code !== 0 || result.aborted) throw new Error(`GitHub task read failed: ${result.stderr.slice(-1000)}`);
    const issues = JSON.parse(result.stdout);
    if (!Array.isArray(issues)) throw new Error('Invalid GitHub issue response');
    if (issues.length >= this.maxIssues) throw new Error('GitHub issue limit reached; narrow labels or increase maxIssues to avoid silently dropping tasks');
    const prefix = this.repository.replace('/', '.');
    return validateTasks(issues.map(issue => {
      const block = /```task-json\s*\n([\s\S]*?)\n```/.exec(issue.body ?? '');
      const metadata = block ? JSON.parse(block[1]) : {};
      // Repo path and identity are operator-configured, never supplied by remote issue metadata.
      const { priority, estimatedMinutes, estimatePercent, dependsOn = [] } = metadata;
      if (!Array.isArray(dependsOn) || dependsOn.some(x => !Number.isInteger(x) || x <= 0)) throw new Error(`Issue #${issue.number}: dependsOn must be issue numbers`);
      return {
        id: `${prefix}.${issue.number}`, title: issue.title, cwd: this.cwd, agent: this.agent,
        priority: priority ?? 0, estimatedMinutes, estimatePercent,
        dependsOn: dependsOn.map(number => `${prefix}.${number}`), isolation: 'worktree',
        initialStatus: issue.state === 'CLOSED' ? 'done' : 'pending',
        prompt: `Work on GitHub issue ${issue.url}\n\n${issue.title}\n\n${(issue.body ?? '').replace(/```task-json\s*\n[\s\S]*?\n```/, '').trim()}\n\nReport the implementation and validation evidence. Do not publish, merge, close the issue, or send external messages.`,
      };
    }), process.cwd());
  }
}
