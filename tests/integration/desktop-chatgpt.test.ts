import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { createTask, createWebsite } from '../helpers/fixtures';
import { startAgentServer } from '../helpers/agent-server';
import { waitFor } from '../helpers/extension';
import type { FakeChatGptConfig } from '../fixtures/fake-chatgpt';

/**
 * Owner request: “the browser inside the app”. The desktop app's REAL ChatGPT tab (desktop/chatgpt-tab.cjs, its agent,
 * preload and shim, and the extension's own ChatGPT scripts) runs in Electron (tests/fixtures/desktop-chatgpt-harness.cjs)
 * against the FAKE ChatGPT page, and talks to the same agent handlers as the dashboard with the app's key. These are
 * not live ChatGPT tests. Needs desktop/node_modules (npm ci in desktop/); on Linux without a display, xvfb-run.
 */
const repo = path.resolve(__dirname, '..', '..');
const electron = path.join(repo, 'desktop', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
const KEY = 'desktop-test-key-'.padEnd(48, 'x');

let client: PrismaClient;
let server: Awaited<ReturnType<typeof startAgentServer>>;
let jobs: typeof import('@/lib/chatgpt/jobs');
let siteId: string;
let app: { child: ChildProcess; lines: string[]; dir: string; fakeFile: string } | null = null;

async function request(prompt: string, opts: { expectImages?: boolean } = {}) {
  const task = await createTask(client, siteId, { keyword: prompt.slice(0, 30) });
  const fresh = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
  const res = await jobs.createChatGPTRequest({ task: fresh, stageKey: 'TITLES', attempt: 1, operationId: `${task.id}:TITLES:a1`, prompt, newChat: true, timeoutSec: 120, expectImages: opts.expectImages });
  return { taskId: task.id, ...res };
}

function launch(fake: FakeChatGptConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bas-desktop-chatgpt-'));
  const fakeFile = path.join(dir, 'fake.json');
  fs.writeFileSync(fakeFile, JSON.stringify(fake));
  const args = [path.join(repo, 'tests', 'fixtures', 'desktop-chatgpt-harness.cjs'), `--origin=${server.origin}`, `--key=${KEY}`, `--fake=${fakeFile}`, `--dir=${dir}`];
  // Chromium refuses to start as root without this (test containers only; the app never runs as root).
  if (process.getuid?.() === 0) args.push('--no-sandbox');
  const headless = process.platform === 'linux' && !process.env.DISPLAY;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = headless ? spawn('xvfb-run', ['-a', electron, ...args], { env }) : spawn(electron, args, { env });
  const lines: string[] = [];
  const read = (d: Buffer) => lines.push(...d.toString('utf8').split('\n').filter(Boolean));
  child.stdout!.on('data', read);
  child.stderr!.on('data', read);
  return (app = { child, lines, dir, fakeFile });
}

const lastPage = () => {
  const line = [...(app?.lines ?? [])].reverse().find((l) => l.startsWith('PAGE '));
  return line ? (JSON.parse(line.slice(5)) as { bridge: string; chrome: string; runtime: string; stats: { sends: number; lastPrompt: string | null } | null; url: string }) : null;
};

async function responseDone(responseId: string, timeoutMs = 90_000) {
  return waitFor(
    async () => {
      const r = await client.chatGPTResponse.findUniqueOrThrow({ where: { id: responseId } });
      return r.status !== 'PENDING' ? r : null;
    },
    timeoutMs,
    'ChatGPT response',
    1000,
  ).catch((e) => {
    throw new Error(`${(e as Error).message}\n--- app output ---\n${app?.lines.slice(-60).join('\n')}`);
  });
}

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  const { updateSettings } = await import('@/lib/settings');
  await updateSettings({ advanced: { humanCheckPauseMinutes: 0.1, extensionBusyPollSec: 1, extensionIdlePollSec: 5, composerReadyTimeoutSec: 8 } });
  jobs = await import('@/lib/chatgpt/jobs');
  process.env.BAS_DESKTOP_AGENT_KEY = KEY;
  server = await startAgentServer();
  siteId = (await createWebsite(client)).id;
});

afterEach(async () => {
  if (app) {
    app.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(app.dir, { recursive: true, force: true });
    app = null;
  }
  await client.queueJob.updateMany({ where: { status: { in: ['WAITING', 'ACTIVE'] } }, data: { status: 'CANCELLED' } });
});

afterAll(async () => {
  delete process.env.BAS_DESKTOP_AGENT_KEY;
  await server?.close();
});

describe.skipIf(!fs.existsSync(electron))("the desktop app's ChatGPT tab against a fake ChatGPT page", () => {
  it('one stored prompt → one saved answer, with the extension scripts in a world the page never sees', async () => {
    const { EXPECTED_EXTENSION_VERSION } = await import('@/lib/agent/version');
    launch({ variant: 'standard', mode: 'normal' });
    const req = await request('Generate several credible titles for "Tom Kaulitz Heidi Klum".\nRecommended Title: <best>');
    const done = await responseDone(req.responseId);
    expect(done.status).toBe('COMPLETED');
    expect(done.resultText).toContain('## Answer heading');
    expect(done.resultText).toContain('| Full Name | Example Person |');
    expect(done.conversationUrl).toMatch(/^https:\/\/chatgpt\.com\/c\/[0-9a-f-]{36}$/);
    // The app's own agent did it (its install id and the scripts' version).
    const agent = await client.workerStatus.findUniqueOrThrow({ where: { id: 'extension:desktop-app' } });
    expect(agent.version).toBe(EXPECTED_EXTENSION_VERSION);
    await waitFor(async () => (lastPage()?.stats?.sends ?? 0) >= 1, 10_000, 'page counters', 500);
    const page = lastPage()!;
    expect(page.stats!.sends).toBe(1);
    expect(page.stats!.lastPrompt?.replace(/\s+/g, ' ').trim()).toBe('Generate several credible titles for "Tom Kaulitz Heidi Klum". Recommended Title: <best>');
    // ChatGPT's own page never sees the app's channel or a chrome.runtime.
    expect(page.bridge).toBe('undefined');
    expect(page.runtime).toBe('undefined');
  });

  it('recovers the answer after the page reloads mid-generation without resending the prompt', async () => {
    launch({ variant: 'standard', mode: 'normal', chunkMs: 400, chunkSize: 15 });
    const req = await request('Interrupted completion prompt');
    await waitFor(
      async () => {
        const j = await client.queueJob.findFirstOrThrow({ where: { relatedId: req.responseId } });
        return Boolean(j.progress && JSON.parse(j.progress).sent);
      },
      60_000,
      'prompt sent',
      500,
    );
    fs.writeFileSync(path.join(app!.dir, 'command'), 'reload');
    const done = await responseDone(req.responseId);
    expect(done.status).toBe('COMPLETED');
    expect(done.recovered).toBe(true);
    expect(done.resultText).toContain('final paragraph');
    await new Promise((r) => setTimeout(r, 1500));
    expect(lastPage()?.stats?.sends).toBe(1);
  });

  it('image answers: the picture is fetched with the tab\'s own ChatGPT session and uploaded to the dashboard', async () => {
    launch({ variant: 'standard', mode: 'normal', answers: ['IMAGE: Here is your illustration.'], chunkMs: 60 });
    const req = await request('Create one clean editorial illustration based on this approved image brief: a desk with a laptop', { expectImages: true });
    const done = await responseDone(req.responseId);
    expect(done.status).toBe('COMPLETED');
    const assets = await client.mediaAsset.findMany({ where: { responseId: req.responseId } });
    expect(assets).toHaveLength(1);
    expect(assets[0].origin).toBe('CHATGPT');
    expect(assets[0].width).toBe(1024);
    expect(assets[0].sourceUrl).toContain('/backend-api/estuary/content?id=file_');
  });

  it('a sign-in page is never automated: the job waits for the owner, who is told in the app', async () => {
    launch({ variant: 'standard', mode: 'login' });
    const req = await request('Login required prompt');
    const job = await waitFor(
      async () => {
        const j = await client.queueJob.findFirstOrThrow({ where: { relatedId: req.responseId } });
        return j.errorCode === 'LOGIN' ? j : null;
      },
      90_000,
      'LOGIN failure',
      1000,
    ).catch((e) => {
      throw new Error(`${(e as Error).message}\n--- app output ---\n${app?.lines.slice(-60).join('\n')}`);
    });
    expect(job.status).toBe('WAITING');
    const task = await client.articleTask.findUniqueOrThrow({ where: { id: req.taskId } });
    expect(task.status).toBe('LOGIN_REQUIRED');
    expect(task.pausedFor).toBe('chatgpt-login');
    expect(app!.lines.some((l) => l.startsWith('NOTIFY ') && l.includes('ChatGPT asks you to sign in'))).toBe(true);
    expect(app!.lines).toContain('FRONT');
    expect(lastPage()?.stats?.sends ?? 0).toBe(0);
  });
});
