import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

/** No shell interpolation. Process groups are killed on cancellation/timeouts (Unix). */
export function runProcess(command, args, { cwd, env, timeoutMs = 3_600_000, signal, onEvent, logFile, maxCapture = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve({ code: null, stdout: '', stderr: '', aborted: true });
    const child = spawn(command, args, { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', stopped = false, timer, forceTimer, callbackError;
    const log = logFile ? fs.createWriteStream(logFile, { flags: 'a', mode: 0o600 }) : null;
    log?.on('error', error => { callbackError = error; stop(); });
    function kill(sig) {
      try { process.platform !== 'win32' ? process.kill(-child.pid, sig) : child.kill(sig); } catch {}
    }
    function stop() { if (stopped) return; stopped = true; kill('SIGTERM'); forceTimer = setTimeout(() => kill('SIGKILL'), 3000); }
    signal?.addEventListener('abort', stop, { once: true });
    timer = setTimeout(stop, timeoutMs);
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      try { onEvent?.(event); } catch (error) { callbackError = error; stop(); }
    });
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-maxCapture); log?.write(data); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-maxCapture); log?.write(data); });
    function cleanup() { clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', stop); lines.close(); }
    child.on('error', error => { cleanup(); log?.end(); reject(error); });
    child.on('close', code => {
      cleanup();
      const finish = () => callbackError ? reject(callbackError) : resolve({ code, stdout, stderr, aborted: stopped });
      log ? log.end(finish) : finish();
    });
  });
}
