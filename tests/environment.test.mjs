import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseEnvFile, loadEnvironment, expandConfigEnvironment, schedulerFromConfig } from '../lib/index.mjs';
import { runProcess } from '../lib/process.mjs';
async function temp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-env-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }

test('env file parses comments and quotes without executing shell syntax', () => {
  const data = parseEnvFile('# comment\nexport NAME="hello world" # comment\nSINGLE=\'literal\'\nCOMMAND=$(echo secret)\nHASH=word#part\nCOMMENT=word # part');
  assert.equal(data.NAME, 'hello world'); assert.equal(data.SINGLE, 'literal'); assert.equal(data.COMMAND, '$(echo secret)'); assert.equal(data.HASH, 'word#part'); assert.equal(data.COMMENT, 'word');
  assert.throws(() => parseEnvFile('broken line'), /line 1/);
  assert.throws(() => parseEnvFile('A="unterminated'), /line 1/);
});
test('environment overrides optional file and does not mutate process.env', async t => {
  const dir = await temp(t), file = path.join(dir, '.env');
  await fs.writeFile(file, 'SCHEDULER_TEST_ONLY=in-file\nOTHER=file-only');
  const before = process.env.SCHEDULER_TEST_ONLY;
  const result = await loadEnvironment({ envFile: file, env: { SCHEDULER_TEST_ONLY: 'in-process' } });
  assert.equal(result.SCHEDULER_TEST_ONLY, 'in-process'); assert.equal(result.OTHER, 'file-only'); assert.equal(process.env.SCHEDULER_TEST_ONLY, before);
});
test('substitution changes values only, is single-pass and cannot inject JSON structure', () => {
  const value = { '${KEY}': '${VALUE}', nested: ['${MISSING:-fallback}', '${EMPTY:-default}'] };
  const env = { KEY: 'changed', VALUE: '"},"agents":{"evil":true}', EMPTY: '' };
  const result = expandConfigEnvironment(value, env);
  assert.deepEqual(Object.keys(result), ['${KEY}', 'nested']); assert.equal(result['${KEY}'], env.VALUE);
  assert.deepEqual(result.nested, ['fallback', 'default']);
  assert.equal(expandConfigEnvironment('${A}', { A: '${B}', B: 'recursive' }), '${B}');
  assert.throws(() => expandConfigEnvironment('${MISSING}', {}), /Required environment variable is missing: MISSING/);
});
test('personal config resolves repository, paths and numeric settings from env file', async t => {
  const dir = await temp(t), config = path.join(dir, 'scheduler.json'), envFile = path.join(dir, '.env');
  await fs.writeFile(config, JSON.stringify({ version: 1, sources: [{ type: 'github-issues', repository: '${REPO}', cwd: '${CHECKOUT}', labels: ['${LABEL:-agent-ready}'] }], agents: { codex: { type: 'codex', quota: { type: 'unknown' } } }, stateDir: '${STATE}', maxParallel: '${PARALLEL:-3}', policy: { reservePercent: '${RESERVE:-20}' } }));
  await fs.writeFile(envFile, `AGENT_SCHEDULER_CONFIG=${config}\nREPO=alice/project\nCHECKOUT=${dir}\nSTATE=${dir}/state\nPARALLEL=2\n`);
  const scheduler = await schedulerFromConfig(undefined, { envFile, env: {} });
  assert.equal(scheduler.source.sources[0].repository, 'alice/project'); assert.equal(scheduler.source.sources[0].cwd, dir); assert.equal(scheduler.maxParallel, 2); assert.equal(scheduler.policy.reservePercent, 20); assert.equal(scheduler.store.directory, path.join(dir, 'state'));
});
test('missing and invalid env settings fail before task execution', async t => {
  const dir = await temp(t), file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, sources: [{ type: 'github-issues', repository: '${REPO}', cwd: '${WORKSPACE}' }], agents: { codex: { type: 'codex' } }, maxParallel: '${MAX:-3}' }));
  await assert.rejects(schedulerFromConfig(file, { env: {} }), /REPO/);
  await assert.rejects(schedulerFromConfig(file, { env: { REPO: 'alice/project', WORKSPACE: dir, MAX: 'NaN' } }), /numeric/);
  await assert.rejects(schedulerFromConfig(file, { env: { REPO: 'alice/project', WORKSPACE: dir, MAX: '0' } }), /limits/);
});
test('CLI accepts an explicitly chosen env file without a --config argument', async t => {
  const dir = await temp(t), tasks = path.join(dir, 'tasks.json'), config = path.join(dir, 'config.json'), envFile = path.join(dir, '.env');
  await fs.writeFile(tasks, '[]');
  await fs.writeFile(config, JSON.stringify({ version: 1, sources: [{ type: 'json', path: tasks }], agents: { codex: { type: 'codex', quota: { type: 'unknown' } } }, stateDir: '${STATE}' }));
  await fs.writeFile(envFile, `AGENT_SCHEDULER_CONFIG=${config}\nSTATE=${dir}/state`);
  const result = await runProcess(process.execPath, [path.resolve('bin/agent-task-scheduler.mjs'), 'status', '--env-file', envFile]);
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).version, 1); await assert.rejects(fs.access(path.join(dir, 'state')));
});
test('loaded personal variables do not automatically reach model workers', async t => {
  const dir = await temp(t), config = path.join(dir, 'config.json');
  await fs.writeFile(config, JSON.stringify({ version: 1, sources: [{ type: 'github-issues', repository: '${REPO}', cwd: dir }], agents: { codex: { type: 'codex', quota: { type: 'unknown' } } } }));
  const scheduler = await schedulerFromConfig(config, { env: { REPO: 'alice/project', GH_TOKEN: 'test-private-token', ANTHROPIC_API_KEY: 'test-private-key' } });
  assert.equal(scheduler.agents.codex.env.GH_TOKEN, undefined); assert.equal(scheduler.agents.codex.env.ANTHROPIC_API_KEY, undefined);
});
