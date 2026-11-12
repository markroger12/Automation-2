import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { createTask, createWebsite } from '../helpers/fixtures';
import { configureTestBrowser } from '../helpers/browser';
import { startAgentServer } from '../helpers/agent-server';
import { launchWithExtension, waitFor } from '../helpers/extension';

declare const chrome: { runtime: { getManifest: () => { version: string } }; storage: { local: { get: (k: string) => Promise<Record<string, unknown>> } }; tabs: { query: (q: object) => Promise<{ id?: number; url?: string }[]> } };

/**
 * Owner request: after an app update the extension should not need a reload by hand. The ACTUAL extension, loaded
 * unpacked from a folder that an update rewrites, against the fake ChatGPT page. The version the app expects is
 * switched in the test, as a newer app would.
 */
const expected = vi.hoisted(() => ({ version: '3.4.99' }));
vi.mock('@/lib/agent/version', () => ({
  get EXPECTED_EXTENSION_VERSION() {
    return expected.version;
  },
  AGENT_PROTOCOL_VERSION: 1,
}));

const REAL = path.resolve(__dirname, '..', '..', 'extension');
const NEW = JSON.parse(fs.readFileSync(path.join(REAL, 'manifest.json'), 'utf8')).version as string;

/** A copy of the extension folder at another version (what was on disk before the update). */
function writeExtension(dir: string, version: string) {
  fs.cpSync(REAL, dir, { recursive: true });
  for (const file of ['manifest.json', 'background.js', 'content.js']) {
    const p = path.join(dir, file);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll(`"version": "${NEW}"`, `"version": "${version}"`).replaceAll(`EXTENSION_VERSION = '${NEW}'`, `EXTENSION_VERSION = '${version}'`));
  }
}

let client: PrismaClient;
let server: Awaited<ReturnType<typeof startAgentServer>>;
let key: string;
let jobs: typeof import('@/lib/chatgpt/jobs');
let siteId: string;
let browser: Awaited<ReturnType<typeof launchWithExtension>> | null = null;
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bas-ext-folder-'));

beforeAll(async () => {
  configureTestBrowser();
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  const { updateSettings } = await import('@/lib/settings');
  await updateSettings({ advanced: { extensionBusyPollSec: 1, composerReadyTimeoutSec: 8 }, browser: { chatgptTabs: 1 } });
  jobs = await import('@/lib/chatgpt/jobs');
  key = (await (await import('@/lib/agent/keys')).createConnectionKey()).key;
  server = await startAgentServer();
  siteId = (await createWebsite(client)).id;
});

afterAll(async () => {
  await browser?.close();
  await server.close();
});

async function prompt(text: string) {
  const task = await createTask(client, siteId, { keyword: text.slice(0, 30) });
  const res = await jobs.createChatGPTRequest({ task, stageKey: 'TITLES', attempt: 1, operationId: `${task.id}:TITLES:a1`, prompt: text, newChat: true, timeoutSec: 120 });
  return waitFor(
    async () => {
      await browser!.tick().catch(() => {});
      const r = await client.chatGPTResponse.findUniqueOrThrow({ where: { id: res.responseId } });
      return r.status !== 'PENDING' ? r : null;
    },
    90_000,
    'ChatGPT answer',
    1000,
  );
}

const chatTabs = async () => (await browser!.worker().evaluate(() => chrome.tabs.query({}))).filter((t) => t.url?.startsWith('https://chatgpt.com/'));

describe('the extension picks up an updated folder by itself', () => {
  it('reloads from its folder once the folder has the version the app expects, keeps its ChatGPT tab, and works on', async () => {
    writeExtension(folder, '3.4.99');
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => ({ variant: 'standard', mode: 'normal' }), extensionPath: folder, loadUnpacked: true });
    // Before the update: versions match, a prompt runs in the extension's ChatGPT tab.
    expect((await prompt('Before the update: generate titles for "Example Person".')).status).toBe('COMPLETED');
    const before = await chatTabs();
    expect(before).toHaveLength(1);

    // A newer app expects a newer extension, but the folder is still the old one: no reload, the badge says VER.
    expected.version = NEW;
    const message = await waitFor(
      async () => {
        await browser!.tick();
        return (await browser!.worker().evaluate(() => (self as unknown as { basState: () => { versionMessage: string | null } }).basState())).versionMessage;
      },
      40_000,
      'the version message',
      1000,
    );
    expect(message).toMatch(/reloads itself from .*folder when it is idle/);
    await browser.tick();
    expect(await browser.worker().evaluate(() => chrome.runtime.getManifest().version)).toBe('3.4.99');

    // The update writes the new files into the folder: the next poll reloads the extension from it.
    fs.cpSync(REAL, folder, { recursive: true });
    const reloaded = browser.context.waitForEvent('serviceworker', { timeout: 30_000 });
    // The poll (as the alarm does) sees the folder's version and reloads; its own call ends with the old worker.
    await browser.tick().catch(() => {});
    await reloaded;
    await waitFor(() => browser!.worker().evaluate((v) => chrome.runtime.getManifest().version === v, NEW).catch(() => false), 20_000, 'the reloaded extension');
    // Its start-up reloads the ChatGPT tab it managed (the old page scripts no longer reach the new extension).
    const mark = await waitFor(
      async () => {
        const m = (await browser!.worker().evaluate(() => chrome.storage.local.get('selfReload'))).selfReload as { from: string; to: string; restored?: boolean; tabs: number[] };
        return m?.restored ? m : null;
      },
      10_000,
      'the restored tab',
    );
    expect(mark).toMatchObject({ from: '3.4.99', to: NEW, restored: true, tabs: [before[0].id] });

    // The app sees the new version and hands out work again, in the same ChatGPT tab (reloaded, not a second one).
    await waitFor(async () => {
      await browser!.tick().catch(() => {});
      const ext = await client.workerStatus.findFirst({ where: { kind: 'EXTENSION' } });
      return ext?.version === NEW;
    }, 20_000, 'the new version at the app');
    expect((await prompt('After the update: generate titles for "Example Person".')).status).toBe('COMPLETED');
    expect((await chatTabs()).map((t) => t.id)).toEqual([before[0].id]);
  });
});
