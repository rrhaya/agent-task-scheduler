import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

/** No shell interpolation. Process groups are killed on cancellation/timeouts (Unix). */
export function runProcess(command, args, { cwd, env, timeoutMs = 3_600_000, signal, onEvent, logFile, maxCapture = 1_000_000, maxLogBytes = 50_000_000, maxEventLineBytes = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve({ code: null, stdout: '', stderr: '', aborted: true });
    const child = spawn(command, args, { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', stopped = false, timer, forceTimer, callbackError, logBytes = 0, lineBytes = 0;
    const log = logFile ? fs.createWriteStream(logFile, { flags: 'wx', mode: 0o600 }) : null;
    log?.on('error', error => { callbackError = error; stop(); });
    function kill(sig) {
      try { process.platform !== 'win32' ? process.kill(-child.pid, sig) : child.kill(sig); } catch {}
    }
    function stop() { if (stopped) return; stopped = true; kill('SIGTERM'); forceTimer = setTimeout(() => kill('SIGKILL'), 3000); }
    signal?.addEventListener('abort', stop, { once: true });
    timer = setTimeout(stop, timeoutMs);
    const lines = onEvent ? readline.createInterface({ input: child.stdout }) : null;
    lines?.on('line', line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      try { onEvent?.(event); } catch (error) { callbackError = error; stop(); }
    });
    function writeLog(data) {
      if (!log || stopped) return;
      logBytes += data.length;
      if (logBytes > maxLogBytes) { callbackError = new Error('Worker log size limit exceeded'); stop(); return; }
      log.write(data);
    }
    child.stdout.on('data', data => {
      stdout = (stdout + data).slice(-maxCapture); writeLog(data);
      if (onEvent) {
        for (const part of data.toString().split(/(?<=\n)/)) {
          lineBytes += Buffer.byteLength(part);
          if (lineBytes > maxEventLineBytes) { callbackError = new Error('Worker event line size limit exceeded'); stop(); break; }
          if (part.endsWith('\n')) lineBytes = 0;
        }
      }
    });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-maxCapture); writeLog(data); });
    function cleanup() { clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', stop); lines?.close(); }
    child.on('error', error => { cleanup(); log?.end(); reject(error); });
    child.on('close', code => {
      cleanup();
      const finish = () => callbackError ? reject(callbackError) : resolve({ code, stdout, stderr, aborted: stopped });
      log ? log.end(finish) : finish();
    });
  });
}
