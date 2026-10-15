import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import sharp from 'sharp';

export interface FakeChatGptConfig {
  variant?: 'standard' | 'alternate' | 'broken';
  mode?: 'normal' | 'login' | 'challenge' | 'challenge-clears' | 'usage-limit' | 'late' | 'multipart' | 'tool-preamble';
  answerDelayMs?: number;
  /** After loading a /c/<id> page, render its turns only after this delay (the composer is ready at once). */
  historyDelayMs?: number;
  /**
   * 'article': each turn is an <article data-turn> around the role <div> (both match the adapter's selectors).
   * 'units': the Chat/Work layout reported from Sept 2026 — no data-message-author-role; [data-turn-key] turns,
   * "…:user" / "…:assistant" search units, [data-user-message-bubble] and [data-markdown-text-style="assistant-message"].
   */
  turnMarkup?: 'default' | 'article' | 'units';
  /** Keep only the last N turns in the DOM, like a long virtualized conversation (turn indexes stay absolute). */
  virtualize?: number;
  /** Render a paragraph's single newlines as newlines kept by CSS (white-space: pre-wrap) instead of joining the lines. */
  softBreaks?: boolean;
  /** 'short': user messages longer than 300 characters are shown shortened, with a "Show more" button. */
  userDisplay?: 'full' | 'short';
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
