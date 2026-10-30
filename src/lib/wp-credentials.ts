import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataPaths } from './paths';

/**
 * WordPress sign-ins the owner chose to save (owner request: “add the password with the website, then log in
 * automatically” — before, the app never asked for one). Each website's user name and password are encrypted with
 * AES-256-GCM and kept in data/credentials (file mode 600), next to their random key. They are never written to the
 * database, a log, a backup or a diagnostic bundle, and never sent back to the browser: the dashboard only learns
 * whether a sign-in is saved, for which user, and how the last automatic login went. The worker types them only into
 * the website's own login page (src/wordpress/session.ts → autoLogin).
 *
 * The key lies in the same folder: this protects against a copied database, log or screenshot, not against someone
 * who has the whole data folder (which holds the signed-in browser profiles anyway).
 */

interface Stored {
  username: string;
  iv: string;
  tag: string;
  data: string;
  savedAt: string;
  /** The last automatic login's outcome; a refused password is not tried again until it is changed. */
  last?: { at: string; ok: boolean; refused?: boolean; needsOwner?: boolean; detail: string };
}

export interface SavedLogin {
  username: string;
  savedAt: string;
  last: Stored['last'] | null;
}

function readAll(): Record<string, Stored> {
  try {
    return JSON.parse(fs.readFileSync(dataPaths.wpCredentials(), 'utf8')) as Record<string, Stored>;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Stored>) {
  const file = dataPaths.wpCredentials();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function key(): Buffer {
  const file = dataPaths.wpCredentialsKey();
  try {
    const k = fs.readFileSync(file);
    if (k.length === 32) return k;
  } catch {
    /* made below */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const k = randomBytes(32);
  fs.writeFileSync(file, k, { mode: 0o600 });
  return k;
}

export const USERNAME_MAX = 120;
export const PASSWORD_MAX = 300;

/** Save (or replace) a website's sign-in. */
export function saveLogin(websiteId: string, username: string, password: string, now = new Date()): SavedLogin {
  const user = username.trim();
  if (!user || user.length > USERNAME_MAX) throw new Error('Enter the WordPress user name or email (up to 120 characters).');
  if (!password || password.length > PASSWORD_MAX) throw new Error('Enter the WordPress password (up to 300 characters).');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  // The website id is bound to the ciphertext: a copied entry does not decrypt for another website.
  cipher.setAAD(Buffer.from(websiteId));
  const data = Buffer.concat([cipher.update(JSON.stringify({ u: user, p: password }), 'utf8'), cipher.final()]);
  const all = readAll();
  all[websiteId] = { username: user, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'), savedAt: now.toISOString() };
  writeAll(all);
  return { username: user, savedAt: all[websiteId].savedAt, last: null };
}

/** What the dashboard may know: the user name, when it was saved and the last automatic login. Never the password. */
export function savedLogin(websiteId: string): SavedLogin | null {
  const s = readAll()[websiteId];
  return s ? { username: s.username, savedAt: s.savedAt, last: s.last ?? null } : null;
}

/** For the worker's automatic login only. Null when nothing is saved or it cannot be decrypted. */
export function loginFor(websiteId: string): { username: string; password: string } | null {
  const s = readAll()[websiteId];
  if (!s) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(s.iv, 'base64'));
    decipher.setAAD(Buffer.from(websiteId));
    decipher.setAuthTag(Buffer.from(s.tag, 'base64'));
    const plain = JSON.parse(Buffer.concat([decipher.update(Buffer.from(s.data, 'base64')), decipher.final()]).toString('utf8')) as { u: string; p: string };
    return { username: plain.u, password: plain.p };
  } catch {
    return null;
  }
}

export function recordLoginResult(websiteId: string, result: { ok: boolean; refused?: boolean; needsOwner?: boolean; detail: string }, now = new Date()) {
  const all = readAll();
  if (!all[websiteId]) return;
  all[websiteId].last = { at: now.toISOString(), ok: result.ok, ...(result.refused ? { refused: true } : {}), ...(result.needsOwner ? { needsOwner: true } : {}), detail: result.detail.slice(0, 300) };
  writeAll(all);
}

export function deleteLogin(websiteId: string): boolean {
  const all = readAll();
  if (!all[websiteId]) return false;
  delete all[websiteId];
  writeAll(all);
  return true;
}
