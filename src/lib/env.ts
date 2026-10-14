import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './paths';

let loaded = false;

/**
 * Load .env for processes that Next.js does not manage (worker, scripts, tests).
 * Existing environment variables win, so tests can override values safely.
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const file = path.join(projectRoot(), '.env');
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function appOrigin(): string {
  return (process.env.APP_ORIGIN || 'http://localhost:3000').replace(/\/+$/, '');
}
