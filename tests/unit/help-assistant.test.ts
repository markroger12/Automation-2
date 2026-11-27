import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { askGemini } from '@/lib/assistant/gemini';
import { DEFAULT_MODEL, assistantApiKey, assistantSettings, removeAssistantKey, saveAssistantSettings } from '@/lib/assistant/settings';
import { redactString } from '@/lib/redact';
import { ASSISTANT_SYSTEM, assistantInstructions } from '@/lib/assistant/context';

const KEY = 'AIzaSyTESTkey0123456789abcdefghijklmnopq';

/** Owner request 2026-11-12: a help assistant with the owner's own Gemini key, kept as safe as the WordPress passwords. */
describe('help assistant key (data/credentials)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bas-assistant-'));
    process.env.BAS_DATA_DIR = dir;
  });

  it('stores the key encrypted and tells the dashboard only its last 4 characters', () => {
    expect(assistantSettings()).toEqual({ configured: false, keyHint: null, model: DEFAULT_MODEL, savedAt: null });
    const s = saveAssistantSettings({ apiKey: ` ${KEY} `, model: 'gemini-flash-lite-latest' }, new Date('2026-11-12T10:00:00Z'));
    expect(s).toEqual({ configured: true, keyHint: 'nopq', model: 'gemini-flash-lite-latest', savedAt: '2026-11-12T10:00:00.000Z' });
    expect(JSON.stringify(s)).not.toContain(KEY);
    const file = fs.readFileSync(path.join(dir, 'credentials', 'assistant.json'), 'utf8');
    expect(file).not.toContain(KEY);
    expect(file).not.toContain('AIza');
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dir, 'credentials', 'assistant.json')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(dir, 'credentials', 'assistant.key')).mode & 0o777).toBe(0o600);
    }
    expect(assistantApiKey()).toBe(KEY);
    // Another data folder's key cannot read it.
    fs.writeFileSync(path.join(dir, 'credentials', 'assistant.key'), Buffer.alloc(32, 9));
    expect(assistantApiKey()).toBeNull();
  });

  it('keeps the key when only the model changes, refuses a non-key, and forgets it on remove', () => {
    saveAssistantSettings({ apiKey: KEY });
    expect(saveAssistantSettings({ model: 'gemini-flash-latest' }).configured).toBe(true);
    expect(assistantApiKey()).toBe(KEY);
    expect(() => saveAssistantSettings({ apiKey: 'my key with spaces in it 123' })).toThrow(/Gemini API key/);
    expect(saveAssistantSettings({ model: 'bad model/../x' }).model).toBe(DEFAULT_MODEL);
    expect(removeAssistantKey()).toMatchObject({ configured: false, keyHint: null });
    expect(assistantApiKey()).toBeNull();
  });

  it('never lets a Google API key into a log line', () => {
    expect(redactString(`request failed for ${KEY}`)).not.toContain(KEY);
    expect(redactString(`x-goog-api-key: ${KEY}`)).not.toContain(KEY);
  });
});

describe('askGemini', () => {
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  it('sends the key in the header (never in the address) with the instructions and the conversation', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Step 1. ' }, { text: 'Open Settings.' }] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const answer = await askGemini({ apiKey: KEY, model: 'gemini-flash-latest', system: 'You help.', turns: [{ role: 'user', text: 'Hi' }, { role: 'model', text: 'Hello' }, { role: 'user', text: 'How?' }], fetchImpl });
    expect(answer).toBe('Step 1. Open Settings.');
    expect(seen!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent');
    expect(seen!.url).not.toContain(KEY);
    expect((seen!.init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
    const body = JSON.parse(String(seen!.init.body));
    expect(body.systemInstruction.parts[0].text).toBe('You help.');
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(['user', 'model', 'user']);
  });

  it('says plainly when the key is refused, the free quota is used up, or the model is unknown', async () => {
    const base = { apiKey: KEY, model: 'gemini-flash-latest', system: 's', turns: [{ role: 'user' as const, text: 'q' }] };
    await expect(askGemini({ ...base, fetchImpl: reply(400, { error: { status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } }) })).rejects.toMatchObject({ code: 'ASSISTANT_KEY', status: 400 });
    await expect(askGemini({ ...base, fetchImpl: reply(429, { error: { status: 'RESOURCE_EXHAUSTED' } }) })).rejects.toMatchObject({ code: 'ASSISTANT_QUOTA' });
    await expect(askGemini({ ...base, fetchImpl: reply(404, { error: { status: 'NOT_FOUND' } }) })).rejects.toMatchObject({ code: 'ASSISTANT_MODEL' });
    await expect(askGemini({ ...base, fetchImpl: reply(200, { candidates: [{ finishReason: 'SAFETY' }] }) })).rejects.toMatchObject({ code: 'ASSISTANT_EMPTY' });
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(askGemini({ ...base, fetchImpl: offline })).rejects.toMatchObject({ code: 'ASSISTANT_OFFLINE' });
  });
});

describe('help assistant instructions', () => {
  it('always ask for answers in English, also to a question in Roman Urdu (owner rule, 2026-11-13)', () => {
    expect(ASSISTANT_SYSTEM).toMatch(/Always answer in clear, simple English/);
    const all = assistantInstructions('Worker: online.');
    expect(all).toContain('The app right now:\nWorker: online.');
    expect(all.trim().endsWith('Answer in English only, whatever language the question is in.')).toBe(true);
  });
});
