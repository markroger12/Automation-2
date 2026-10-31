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
  /**
   * A rich-text composer that turns a typed markdown link `[label](https://…)` into a link showing only its label
   * (suspected for the owner's “Could not place the complete prompt in the composer” on SEO corrections).
   */
  markdownLinks?: boolean;
  /** The composer puts a space between “](” and a typed address, as the real one did (owner report: “]( https://…”). */
  linkParenSpace?: boolean;
  /** 'short': user messages longer than 300 characters are shown shortened, with a "Show more" button. */
  userDisplay?: 'full' | 'short';
  chunkMs?: number;
  chunkSize?: number;
  challengeClearsAfterMs?: number;
  answers?: string[];
  /** The page sits in a canvas-classed container (ChatGPT's “Work” layout). */
  workLayout?: boolean;
  /** 'unknown': generated pictures carry an address and alt text that match none of the known markers. */
  imageMarkup?: 'default' | 'unknown';
  /** A page-wide “streaming” marker stays after the picture is finished (owner report: 600 s “generating”). */
  staleStreaming?: boolean;
  /** Image-search answers (prompt mentions an “image gallery”): show this many gallery thumbnails with a viewer. */
  galleryCount?: number;
  /** Extra gallery pictures on other hosts (the extension reports these as links). */
  galleryLinks?: string[];
  /** Only this many thumbnails are on the page, the last one with “+N” (owner report: 3 shown of 10). */
  galleryShown?: number;
  /**
   * 'strip': the viewer keeps every picture in the page, hidden except the one shown, and shows the next one a moment
   * after “Next” (owner report: only some of ChatGPT's 10 pictures were saved).
   * 'carousel': every picture stays shown side by side on a track that slides behind a window (the ones beside it are
   * outside it); 'fade': every picture stacked in one place, all but one faded out; 'lightbox': one picture and Close,
   * no “Next” (owner report: ChatGPT showed 6 photos, 2 were used).
   * 'overlay': the viewer in the owner's screen recording (2026-10-30): a full-screen overlay (not a role="dialog";
   * the page keeps another, hidden dialog), “Image”, zoom, Download and Close at the top, unnamed ← / → at the edges
   * halfway down, “1 of 10” and the source's link at the bottom, and each next picture loading for a moment (blank
   * meanwhile).
   */
  galleryViewer?: 'single' | 'strip' | 'carousel' | 'fade' | 'lightbox' | 'arrows' | 'keys' | 'filmstrip' | 'overlay';
  /**
   * Owner report (screenshot: 3 tiles, the third with a stacked-pictures icon and “5”; 3 photos were used): the count
   * sits on the last tile, and the viewer is the only way to the other pictures. With 'arrows' its Previous/Next are
   * icon-only buttons with no name; with 'keys' only the arrow keys step; with 'filmstrip' a row of small pictures in
   * the viewer picks the one shown.
   */
  galleryBadge?: boolean;
  /** Answers are shown in a writing block with a “Writing” label and Copy/expand buttons (owner report). */
  writingBlock?: boolean;
  /**
   * Image-search answers show these pictures as a grid of captioned cards that the page cannot load (broken-picture
   * icon with its alt text), while the address itself works (owner report: “Open image in new tab” shows the photo).
   */
  galleryBroken?: string[];
}

const APP = fs.readFileSync(path.join(__dirname, 'fake-chatgpt', 'app.js'), 'utf8');

/**
 * Serve the FAKE ChatGPT app for every https://chatgpt.com/ document in this
 * browser context (Playwright routing; nothing reaches the real site).
 */
export async function installFakeChatGPT(context: BrowserContext, getConfig: () => FakeChatGptConfig): Promise<void> {
  // A generated-image file as the image CDN would serve it (a different colour per file id).
  const imageFor = (id: string, thumb = false) => {
    const n = Number(/(\d+)/.exec(id)?.[1] ?? '1');
    // Gallery thumbnails are small (like the real gallery); the viewer shows the large picture.
    return sharp({ create: { width: thumb ? 240 : 1024, height: thumb ? 135 : 576, channels: 3, background: { r: (n * 70) % 255, g: (n * 130) % 255, b: (n * 50 + 90) % 255 } } })
      .png()
      .toBuffer();
  };
  // A news site's picture shown in the gallery: it loads in the page, but the extension may not read it (other host).
  await context.route('https://news.example/**', async (route) => route.fulfill({ status: 200, contentType: 'image/png', body: await imageFor('news_9') }));
  // A picture host that refuses pictures embedded in another site's page (the card shows a broken-picture icon).
  await context.route('https://broken.example/**', async (route) => route.fulfill({ status: 403, contentType: 'text/html', body: 'Forbidden' }));
  await context.route('https://chatgpt.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === '/backend-api/files/download') return route.fulfill({ status: 200, contentType: 'image/png', body: await imageFor(url.searchParams.get('f') ?? '') });
    if (url.pathname === '/backend-api/estuary/content') return route.fulfill({ status: 200, contentType: 'image/png', body: await imageFor(url.searchParams.get('id') ?? '', url.searchParams.get('thumb') === '1') });
    if (req.resourceType() !== 'document') return route.fulfill({ status: 404, body: '' });
    const config = JSON.stringify(getConfig()).replace(/</g, '\\u003c');
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ChatGPT</title></head><body><div id="root"></div><script>window.__FAKE=${config};</script><script>${APP}</script></body></html>`,
    });
  });
}
