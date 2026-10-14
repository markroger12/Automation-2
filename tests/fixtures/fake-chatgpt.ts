import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import sharp from 'sharp';

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
  // A generated-image file as the image CDN would serve it (a different colour per file id).
  const imageFor = (id: string) => {
    const n = Number(/(\d+)/.exec(id)?.[1] ?? '1');
    return sharp({ create: { width: 1024, height: 576, channels: 3, background: { r: (n * 70) % 255, g: (n * 130) % 255, b: (n * 50 + 90) % 255 } } })
      .png()
      .toBuffer();
  };
  await context.route('https://chatgpt.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === '/backend-api/estuary/content') return route.fulfill({ status: 200, contentType: 'image/png', body: await imageFor(url.searchParams.get('id') ?? '') });
    if (req.resourceType() !== 'document') return route.fulfill({ status: 404, body: '' });
    const config = JSON.stringify(getConfig()).replace(/</g, '\\u003c');
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ChatGPT</title></head><body><div id="root"></div><script>window.__FAKE=${config};</script><script>${APP}</script></body></html>`,
    });
  });
}
