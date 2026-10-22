import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Worker } from 'playwright';
import { installFakeChatGPT, type FakeChatGptConfig } from '../fixtures/fake-chatgpt';
import { installFakeSearchConsole, type FakeSearchConsoleConfig } from '../fixtures/fake-search-console';

// The extension APIs exist only inside the service worker (evaluate callbacks).
declare const chrome: { storage: { local: { set: (v: Record<string, unknown>) => Promise<void> } }; tabs: { query: (q: object) => Promise<{ id?: number; url?: string }[]>; remove: (id: number) => Promise<void> } };

/**
 * Launch Chromium with the ACTUAL unpacked extension from ./extension, the
 * fake ChatGPT app routed onto https://chatgpt.com/, and the extension paired
 * to a local agent server.
 */
export async function launchWithExtension(options: { serverOrigin: string; key: string; config: () => FakeChatGptConfig; searchConsole?: () => FakeSearchConsoleConfig }): Promise<{ context: BrowserContext; sw: Worker; tick: () => Promise<void>; close: () => Promise<void>; userDataDir: string; searchConsole: Awaited<ReturnType<typeof installFakeSearchConsole>> }> {
  const extensionPath = path.resolve(__dirname, '..', '..', 'extension');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bas-ext-'));
  const executablePath = process.env.BROWSER_EXECUTABLE_PATH || undefined;
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: !process.env.DISPLAY,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run', '--no-default-browser-check'],
  });
  await installFakeChatGPT(context, options.config);
  const searchConsole = await installFakeSearchConsole(context, options.searchConsole ?? (() => ({})));
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  // On a busy machine the worker can be reported before its extension APIs are bound: wait for chrome.storage.
  const ready = await waitFor(() => sw.evaluate(() => Boolean((globalThis as { chrome?: { storage?: { local?: unknown } } }).chrome?.storage?.local)).catch(() => false), 15_000, 'extension service worker APIs', 200);
  void ready;
  await sw.evaluate(async ({ origin, key }) => {
    await chrome.storage.local.set({ serverOrigin: origin, key });
  }, { origin: options.serverOrigin, key: options.key });
  const tick = async () => {
    await sw.evaluate(() => (self as unknown as { basTick: () => Promise<void> }).basTick());
  };
  return {
    context,
    sw,
    tick,
    userDataDir,
    searchConsole,
    close: async () => {
      await context.close().catch(() => {});
    },
  };
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, label: string, everyMs = 300): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${String(last)}` : ''}`);
}
