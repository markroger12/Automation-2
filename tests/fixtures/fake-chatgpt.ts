import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright';

export interface FakeChatGptConfig {
  variant?: 'standard' | 'alternate' | 'broken';
  mode?: 'normal' | 'login' | 'challenge' | 'challenge-clears' | 'usage-limit' | 'late' | 'multipart' | 'tool-preamble';
  answerDelayMs?: number;
  chunkMs?: number;
  chunkSize?: number;
  challengeClearsAfterMs?: number;
  answers?: string[];
}

const APP = fs.readFileSync(path.join(__dirname, 'fake-chatgpt', 'app.js'), 'utf8');

/**
 * Serve the FAKE ChatGPT app for every https://chatgpt.com/ document in this
 * browser context (Playwright routing; nothing reaches the real site).
 */
export async function installFakeChatGPT(context: BrowserContext, getConfig: () => FakeChatGptConfig): Promise<void> {
  await context.route('https://chatgpt.com/**', async (route) => {
    const req = route.request();
    if (req.resourceType() !== 'document') return route.fulfill({ status: 404, body: '' });
    const config = JSON.stringify(getConfig()).replace(/</g, '\\u003c');
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ChatGPT</title></head><body><div id="root"></div><script>window.__FAKE=${config};</script><script>${APP}</script></body></html>`,
    });
  });
}
