import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAdapter, ClaudeCodeAdapter, FileStateStore, validateTasks, QuotaPolicy } from '../lib/index.mjs';
import { agentEnvironment } from '../lib/security.mjs';
import { runProcess } from '../lib/process.mjs';
async function temp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-security-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }

test('prompt text cannot inject Codex CLI flags', () => {
  const adapter = new CodexAdapter();
  const prompt = '--dangerously-bypass-approvals-and-sandbox';
  for (const session of [undefined, 'session-id']) {
    const args = adapter.buildArgs({ prompt }, session);
    const separator = args.indexOf('--'); assert.ok(separator > 0);
    assert.equal(args.length, separator + 2);
    assert.ok(!args.slice(0, separator).includes(prompt));
  }
  assert.throws(() => adapter.buildArgs({ prompt: 'work' }, '--dangerously-bypass-approvals-and-sandbox'), /session ID/);
  assert.throws(() => new ClaudeCodeAdapter().buildArgs({ prompt: 'work' }, '--dangerously-skip-permissions'), /session ID/);
});
test('reserved IDs are rejected without modifying Object.prototype', () => {
  for (const id of ['__proto__', 'constructor', 'toString', 'prototype']) assert.throws(() => validateTasks([{ id, cwd: '.', prompt: 'work' }], '.'), /Task id/);
  assert.equal(Object.prototype.status, undefined);
});
test('workers do not inherit unrelated secrets or automatic API billing keys', () => {
  const keys = ['GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    keys.forEach(key => process.env[key] = 'test-secret');
    const env = agentEnvironment(); keys.forEach(key => assert.equal(env[key], undefined));
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(agentEnvironment({ OPENAI_API_KEY: 'explicit' }).OPENAI_API_KEY, 'explicit');
    assert.equal(new CodexAdapter().env.GH_TOKEN, undefined);
    assert.equal(new ClaudeCodeAdapter().env.ANTHROPIC_API_KEY, undefined);
  } finally { for (const key of keys) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key]; }
});
test('state rejects symlink storage and non-private directories', async t => {
  const dir = await temp(t); const actual = path.join(dir, 'actual'), link = path.join(dir, 'link');
  await fs.mkdir(actual, { mode: 0o700 }); await fs.symlink(actual, link);
  await assert.rejects(new FileStateStore(link).lock(), /symlink/);
  if (process.platform !== 'win32') {
    await fs.chmod(actual, 0o755); await assert.rejects(new FileStateStore(actual).lock(), /0700/);
  }
});
test('log paths cannot follow a symlink or overwrite an existing file', async t => {
  const dir = await temp(t), target = path.join(dir, 'target'), log = path.join(dir, 'log');
  await fs.writeFile(target, 'unchanged'); await fs.symlink(target, log);
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.log("message");setTimeout(()=>{},200)'], { logFile: log }), /EEXIST/);
  assert.equal(await fs.readFile(target, 'utf8'), 'unchanged');
});
test('oversized logs and unterminated event lines stop the worker', async t => {
  const dir = await temp(t);
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.log("x".repeat(2048));setTimeout(()=>{},200)'], { logFile: path.join(dir, 'log'), maxLogBytes: 1000 }), /log size/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(2048));setTimeout(()=>{},200)'], { onEvent() {}, maxEventLineBytes: 1000 }), /event line/);
});
