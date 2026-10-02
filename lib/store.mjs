import fs from 'node:fs/promises';
import path from 'node:path';
import { privateDirectory, safeIdentifier } from './security.mjs';
import { randomUUID } from 'node:crypto';

export class FileStateStore {
  constructor(directory) { this.directory = path.resolve(directory); this.file = path.join(this.directory, 'state.json'); }
  async read() {
    try {
      const info = await fs.lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('State file must be a regular file');
      if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('State file permissions must be 0600');
      const state = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (state.version !== 1 || !state.tasks || typeof state.tasks !== 'object' || Array.isArray(state.tasks) || Object.keys(state.tasks).some(id => !safeIdentifier(id))) throw new Error('Unsupported state file');
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, tasks: {}, warmups: {} };
      throw error;
    }
  }
  async write(state) {
    await privateDirectory(this.directory);
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temp, this.file);
  }
  async lock() {
    await privateDirectory(this.directory);
    const file = path.join(this.directory, 'scheduler.lock');
    let handle;
    try { handle = await fs.open(file, 'wx', 0o600); }
    catch (e) {
      if (e.code === 'EEXIST') throw new Error(`Scheduler state is locked: ${file}. If the previous process crashed, verify it is no longer running before removing this lock.`);
      throw e;
    }
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    return async () => { await handle.close(); await fs.unlink(file); };
  }
}
