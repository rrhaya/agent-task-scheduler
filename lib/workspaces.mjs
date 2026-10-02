import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runProcess } from './process.mjs';

export class GitWorktreeManager {
  constructor(stateDirectory) { this.directory = path.join(path.resolve(stateDirectory), 'worktrees'); }
  async prepare(task, record = {}) {
    if (record.workspace) {
      await fs.access(record.workspace);
      return { workspace: record.workspace, branch: record.branch };
    }
    await fs.access(task.cwd);
    if (task.isolation === 'directory') return { workspace: task.cwd };
    const root = await runProcess('git', ['rev-parse', '--show-toplevel'], { cwd: task.cwd, timeoutMs: 10_000 });
    if (root.code !== 0) throw new Error(`Task ${task.id} needs a Git repository for worktree isolation. Use isolation: directory for non-Git work (serialized per directory).`);
    const repoRoot = await fs.realpath(root.stdout.trim());
    const taskRoot = await fs.realpath(task.cwd);
    const dirty = await runProcess('git', ['status', '--porcelain'], { cwd: repoRoot, timeoutMs: 10_000 });
    if (dirty.code !== 0 || dirty.stdout.trim()) throw new Error(`Repository for ${task.id} has uncommitted files. Commit them before creating a worktree; they would not be copied.`);
    const suffix = createHash('sha256').update(task.id).digest('hex').slice(0, 12);
    const branch = `agent-tasks/${suffix}`;
    const treeRoot = path.join(this.directory, suffix);
    await fs.mkdir(this.directory, { recursive: true });
    const add = await runProcess('git', ['worktree', 'add', '-b', branch, treeRoot, 'HEAD'], { cwd: repoRoot, timeoutMs: 30_000 });
    if (add.code !== 0) throw new Error(`Cannot create worktree: ${add.stderr}`);
    // Preserve subdirectory tasks within the checkout.
    const workspace = path.join(treeRoot, path.relative(repoRoot, taskRoot));
    return { workspace, branch };
  }
}
