import fs from 'node:fs/promises';

export function safeIdentifier(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_.-]+$/.test(id) && !Object.hasOwn(Object.prototype, id) && id !== 'prototype';
}
export function validateSessionId(id) {
  if (typeof id !== 'string' || !id || id.startsWith('-') || /[\x00-\x1f\x7f]/.test(id) || id.length > 256) throw new Error('Invalid provider session ID');
  return id;
}
/** Inherit OS/runtime settings, not unrelated secrets such as GH_TOKEN or cloud credentials. */
export function agentEnvironment(overrides = {}) {
  const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'TERM', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key) || key.startsWith('LC_')));
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.entries(overrides).some(([key, value]) => key.includes('\0') || typeof value !== 'string' || value.includes('\0'))) throw new Error('Agent env must contain string values');
  return { ...env, ...overrides };
}
export async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Private directory must not be a symlink: ${directory}`);
  if (process.platform !== 'win32' && ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()))) throw new Error(`Private directory must be owned by this user and mode 0700: ${directory}`);
}
