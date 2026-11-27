import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { badRequest } from '../errors';
import { dataPaths } from '../paths';

/**
 * The help assistant's settings (owner request 2026-11-12: “Gemini Flash krde”): the owner's own Gemini API key and the
 * model. The key is encrypted with AES-256-GCM in data/credentials (file mode 600), next to its random key, as the
 * WordPress sign-ins are. It is never written to the database, a log, a backup or a diagnostic bundle, and never sent
 * back to the browser: the dashboard only learns whether a key is saved and its last 4 characters.
 */

export const DEFAULT_MODEL = 'gemini-flash-latest';
const AAD = Buffer.from('bas-assistant:gemini');

interface Stored {
  iv: string;
  tag: string;
  data: string;
  hint: string;
  model: string;
  savedAt: string;
}

export interface AssistantSettings {
  configured: boolean;
  /** The key's last 4 characters, to recognise it. */
  keyHint: string | null;
  model: string;
  savedAt: string | null;
}

function read(): Partial<Stored> {
  try {
    return JSON.parse(fs.readFileSync(dataPaths.assistantKeyFile(), 'utf8')) as Partial<Stored>;
  } catch {
    return {};
  }
}

function write(value: Partial<Stored>) {
  const file = dataPaths.assistantKeyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 1), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

function cipherKey(): Buffer {
  const file = dataPaths.assistantKeyKey();
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

const cleanModel = (model: string | undefined) => {
  const m = (model ?? '').trim();
  return /^[a-z0-9][a-z0-9.\-]{2,60}$/i.test(m) ? m : DEFAULT_MODEL;
};

export function assistantSettings(): AssistantSettings {
  const s = read();
  return { configured: Boolean(s.data && s.iv && s.tag), keyHint: s.hint ?? null, model: cleanModel(s.model), savedAt: s.savedAt ?? null };
}

/** Save the model, and the API key when one is given (an empty key keeps the saved one). */
export function saveAssistantSettings(input: { apiKey?: string; model?: string }, now = new Date()): AssistantSettings {
  const current = read();
  const next: Partial<Stored> = { ...current, model: cleanModel(input.model ?? current.model) };
  const apiKey = input.apiKey?.trim();
  if (apiKey) {
    if (apiKey.length < 20 || apiKey.length > 200 || /\s/.test(apiKey)) throw badRequest('This does not look like a Gemini API key. Copy it again from aistudio.google.com (it has no spaces).', { apiKey: ['Not a Gemini API key.'] });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', cipherKey(), iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
    Object.assign(next, { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'), hint: apiKey.slice(-4), savedAt: now.toISOString() });
  }
  write(next);
  return assistantSettings();
}

export function removeAssistantKey(): AssistantSettings {
  const { model } = read();
  write({ model: cleanModel(model) });
  return assistantSettings();
}

/** The saved API key, for the request to Gemini only (server side). */
export function assistantApiKey(): string | null {
  const s = read();
  if (!s.data || !s.iv || !s.tag) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', cipherKey(), Buffer.from(s.iv, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(s.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(s.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
