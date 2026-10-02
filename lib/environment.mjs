import fs from 'node:fs/promises';

/** A deliberately small dotenv parser: no shell execution, substitution, or process.env mutation. */
export function parseEnvFile(text) {
  const values = Object.create(null);
  for (const [index, original] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = original.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid env file syntax at line ${index + 1}`);
    let value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0], end = value.indexOf(quote, 1);
      if (end < 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) throw new Error(`Invalid quoted env value at line ${index + 1}`);
      value = value.slice(1, end);
    } else value = value.replace(/\s+#.*$/, '').trim();
    if (value.includes('\0')) throw new Error(`Invalid env value at line ${index + 1}`);
    values[match[1]] = value;
  }
  return values;
}

export async function loadEnvironment({ envFile, env = process.env } = {}) {
  const fileValues = envFile ? parseEnvFile(await fs.readFile(envFile, 'utf8')) : {};
  // Explicit caller / process variables take precedence over the optional file.
  return { ...fileValues, ...env };
}

/** Expand JSON string values only; never JSON text or object keys. Values are not re-expanded. */
export function expandConfigEnvironment(value, env) {
  if (typeof value === 'string') return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
    const found = Object.hasOwn(env, name) ? env[name] : undefined;
    if (typeof found === 'string' && found !== '') return found;
    if (fallback !== undefined) return fallback;
    throw new Error(`Required environment variable is missing: ${name}`);
  });
  if (Array.isArray(value)) return value.map(item => expandConfigEnvironment(item, env));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandConfigEnvironment(item, env)]));
  return value;
}

export function numericSetting(value, name) {
  if (value === undefined) return undefined;
  // Numeric placeholder values are converted only for documented numeric fields.
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (typeof value === 'number') return value;
  throw new Error(`Invalid numeric configuration: ${name}`);
}
