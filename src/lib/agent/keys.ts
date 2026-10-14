import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db, type Tx } from '../db';
import { getValue, setValue } from '../settings';
import { audit } from '../audit';

/**
 * Extension connection key: "bas_" + 32 random bytes (base64url). Shown once;
 * only a SHA-256 hash is stored (the key is high-entropy, so a fast hash is
 * appropriate). Rotating replaces the hash and invalidates paired extensions.
 */
const KEY_SETTING = 'extension.connectionKey';

interface StoredKey {
  hash: string;
  prefix: string;
  createdAt: string;
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export async function createConnectionKey(client: Tx = db): Promise<{ key: string; prefix: string; createdAt: string }> {
  const key = `bas_${randomBytes(32).toString('base64url')}`;
  const stored: StoredKey = { hash: hashKey(key), prefix: key.slice(0, 8), createdAt: new Date().toISOString() };
  const previous = await getValue<StoredKey | null>(KEY_SETTING, null, client);
  await setValue(KEY_SETTING, stored, client);
  await audit(previous ? 'extension.key.rotate' : 'extension.key.create', 'Setting', KEY_SETTING, { prefix: stored.prefix }, client);
  return { key, prefix: stored.prefix, createdAt: stored.createdAt };
}

export async function connectionKeyInfo(client: Tx = db): Promise<{ configured: boolean; prefix: string | null; createdAt: string | null }> {
  const stored = await getValue<StoredKey | null>(KEY_SETTING, null, client);
  return { configured: Boolean(stored), prefix: stored?.prefix ?? null, createdAt: stored?.createdAt ?? null };
}

export async function verifyConnectionKey(presented: string | null | undefined, client: Tx = db): Promise<boolean> {
  if (!presented || !presented.startsWith('bas_') || presented.length < 40 || presented.length > 100) return false;
  const stored = await getValue<StoredKey | null>(KEY_SETTING, null, client);
  if (!stored) return false;
  const a = Buffer.from(hashKey(presented), 'hex');
  const b = Buffer.from(stored.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
