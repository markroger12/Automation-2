import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { createTask, createWebsite } from '../helpers/fixtures';
import { configureTestBrowser } from '../helpers/browser';
import { startAgentServer } from '../helpers/agent-server';
import { launchWithExtension, waitFor } from '../helpers/extension';
import type { FakeChatGptConfig } from '../fixtures/fake-chatgpt';

declare const chrome: { tabs: { remove: (id: number) => Promise<void> } };

/**
 * Loads the ACTUAL unpacked extension into Chromium against a FAKE ChatGPT
 * page (tests/fixtures/fake-chatgpt). These are not live ChatGPT tests.
 */

let client: PrismaClient;
let server: Awaited<ReturnType<typeof startAgentServer>>;
let key: string;
let jobs: typeof import('@/lib/chatgpt/jobs');
let fake: FakeChatGptConfig = {};
let browser: Awaited<ReturnType<typeof launchWithExtension>> | null = null;
let siteId: string;

async function request(prompt: string, opts: { conversationUrl?: string | null; newChat?: boolean; expectImages?: boolean; expectGallery?: boolean; attachments?: { mediaAssetId: string; name: string; mime: string }[] } = {}) {
  const task = await createTask(client, siteId, { keyword: prompt.slice(0, 30) });
  if (opts.conversationUrl) await client.articleTask.update({ where: { id: task.id }, data: { conversationUrl: opts.conversationUrl } });
  const fresh = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
  const res = await jobs.createChatGPTRequest({ task: fresh, stageKey: 'TITLES', attempt: 1, operationId: `${task.id}:TITLES:a1`, prompt, newChat: opts.newChat ?? !opts.conversationUrl, timeoutSec: 120, attachments: opts.attachments, expectImages: opts.expectImages, expectGallery: opts.expectGallery });
  return { taskId: task.id, ...res };
}

async function responseDone(responseId: string, timeoutMs = 60_000) {
  return waitFor(
    async () => {
      await browser!.tick().catch(() => {});
      const r = await client.chatGPTResponse.findUniqueOrThrow({ where: { id: responseId } });
      return r.status !== 'PENDING' ? r : null;
    },
    timeoutMs,
    'ChatGPT response',
    1000,
  );
}

async function jobOf(responseId: string) {
  return client.queueJob.findFirstOrThrow({ where: { relatedId: responseId } });
}

async function waitJob(responseId: string, predicate: (job: Awaited<ReturnType<typeof jobOf>>) => boolean, timeoutMs = 60_000, label = 'job state') {
  return waitFor(
    async () => {
      await browser!.tick().catch(() => {});
      const job = await jobOf(responseId);
      return predicate(job) ? job : null;
    },
    timeoutMs,
    label,
    700,
  );
}

function chatPage() {
  return browser!.context.pages().find((p) => p.url().startsWith('https://chatgpt.com/'));
}

async function fakeStats() {
  const page = browser!.context.pages().find((p) => p.url().startsWith('https://chatgpt.com/'));
  return page!.evaluate(() => (window as unknown as { __fakeStats: () => { sends: number; lastPrompt: string | null; lastFiles: string | null } }).__fakeStats());
}

beforeAll(async () => {
  configureTestBrowser();
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  const { updateSettings } = await import('@/lib/settings');
  await updateSettings({ advanced: { humanCheckPauseMinutes: 0.1, extensionBusyPollSec: 1, composerReadyTimeoutSec: 8 }, browser: { chatgptTabs: 2 }, workflow: { taskConcurrency: 2 } });
  jobs = await import('@/lib/chatgpt/jobs');
  const keys = await import('@/lib/agent/keys');
  key = (await keys.createConnectionKey()).key;
  server = await startAgentServer();
  siteId = (await createWebsite(client)).id;
});

afterEach(async () => {
  await browser?.close();
  browser = null;
  await client.queueJob.updateMany({ where: { status: { in: ['WAITING', 'ACTIVE'] } }, data: { status: 'CANCELLED' } });
  await client.setting.deleteMany({ where: { key: 'chatgpt.rate' } });
});

afterAll(async () => {
  await server.close();
});

describe('Chrome extension against a fake ChatGPT page', () => {
  it('handshake + claim + progress + complete: one stored prompt → one saved answer', async () => {
    fake = { variant: 'standard', mode: 'normal' };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const req = await request('Generate several credible titles for "Tom Kaulitz Heidi Klum".\nRecommended Title: <best>');
    const done = await responseDone(req.responseId);
    expect(done.status).toBe('COMPLETED');
    expect(done.resultText).toContain('## Answer heading');
    expect(done.resultText).toContain('| Full Name | Example Person |');
    expect(done.resultText).toContain('**bold**');
    expect(done.resultText).toContain('[link](https://example.org/page)');
    expect(done.conversationUrl).toMatch(/^https:\/\/chatgpt\.com\/c\/[0-9a-f-]{36}$/);
    expect(done.recovered).toBe(false);
    const stats = await fakeStats();
    expect(stats.sends).toBe(1);
    expect(stats.lastPrompt?.replace(/\s+/g, ' ').trim()).toBe('Generate several credible titles for "Tom Kaulitz Heidi Klum". Recommended Title: <best>');
    const ext = await client.workerStatus.findFirst({ where: { kind: 'EXTENSION' } });
    expect(ext?.version).toBe('3.2.3');
    const actions = new Set(server.requests.map((r) => r.action));
    for (const a of ['hello', 'claim', 'progress', 'complete']) expect(actions.has(a)).toBe(true);
  });
  it('works with an alternate DOM (no data-testids, textarea composer, article turns)', async () => {
    fake = { variant: 'alternate', mode: 'normal' };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const req = await request('Alternate DOM prompt');
    const done = await responseDone(req.responseId);
    expect(done.status).toBe('COMPLETED');
    expect(done.resultText).toContain('## Answer heading');
    expect(done.resultText).toContain('| Profession | Writer |');
  });

  it('waits for a late answer and handles "Continue generating" for a multipart answer', async () => {
    fake = { variant: 'standard', mode: 'late' };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const late = await request('Late answer prompt');
    const lateDone = await responseDone(late.responseId, 90_000);
    expect(lateDone.status).toBe('COMPLETED');
    expect(lateDone.resultText).toContain('final paragraph');
    await browser.close();
    fake = { variant: 'standard', mode: 'multipart' };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const multi = await request('Multipart prompt');
    const multiDone = await responseDone(multi.responseId, 90_000);
    expect(multiDone.status).toBe('COMPLETED');
    expect(multiDone.resultText).toContain('## Answer heading');
    expect(multiDone.resultText).toContain('A **bold** final paragraph');
  });

  it('returns only the final answer when a tool/planning preamble precedes it', async () => {
    fake = { variant: 'standard', mode: 'tool-preamble' };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const req = await request('Research prompt with tools');
    const done = await responseDone(req.responseId);
    expect(done.status).toBe('COMPLETED');
    expect(done.resultText).not.toContain('Searching the web');
    expect(done.resultText).not.toContain('Planning:');
    expect(done.resultText!.startsWith('## Answer heading')).toBe(true);
  });

  it('types a 20,000-character multi-line prompt as text (no "Pasted text" file) and verifies it', async () => {
    fake = { variant: 'standard', mode: 'normal' };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const prompt = Array.from({ length: 250 }, (_, i) => `Paragraph ${i + 1}: ${'research detail '.repeat(4).trim()} — keep facts.`).join('\n');
    expect(prompt.length).toBeGreaterThan(19_000);
    const req = await request(prompt);
    const done = await responseDone(req.responseId, 90_000);
    expect(done.status).toBe('COMPLETED');
    const stats = await fakeStats();
    expect(stats.sends).toBe(1);
    expect(stats.lastPrompt!.replace(/\s+/g, ' ').trim()).toBe(prompt.replace(/\s+/g, ' ').trim());
  });

  it('a composer that rewrites markdown links: the stop says where the text differed; the same prompt with link marks is sent', async () => {
    fake = { variant: 'standard', mode: 'normal', markdownLinks: true };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    // As the old SEO-correction prompt carried the article: markdown links (owner report).
    const withLinks = 'Revise the article below.\n\nArticle:\n\nDaphne Govers spielte für [**NOS**](https://nos.nl/artikel/1) und Ajax.';
    const bad = await request(withLinks);
    const job = await waitJob(bad.responseId, (j) => Boolean(j.error && /Could not place the complete prompt/.test(j.error)), 90_000, 'composer mismatch');
    expect(job.error).toMatch(/the composer showed \d+ of \d+ characters; first difference at character \d+: expected ".*\[\*\*NOS/);
    expect((await fakeStats()).sends).toBe(0); // never sent half a prompt
    // The new form (links as marks) is typed exactly and sent.
    const good = await request('Revise the article below.\n\nArticle:\n\nDaphne Govers spielte für {L1}NOS{/L1} und {b}Ajax{/b}.');
    expect((await responseDone(good.responseId, 90_000)).status).toBe('COMPLETED');
    expect((await fakeStats()).lastPrompt).toContain('{L1}NOS{/L1}');
  });

  it('a composer that puts a space after “](”: the prompt still counts as placed and is sent once (owner report)', async () => {
    fake = { variant: 'standard', mode: 'normal', linkParenSpace: true };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const prompt = 'Review the article below.\n\nArticle:\n\nSee [About the Crew](https://beaconsoft.net/about-the-crew/) and [the official website](https://dit-inc.us/freegate.html).';
    const req = await request(prompt);
    const done = await responseDone(req.responseId, 90_000);
    expect(done.status).toBe('COMPLETED');
    const stats = await fakeStats();
    expect(stats.sends).toBe(1);
    expect(stats.lastPrompt).toContain('[About the Crew]( https://beaconsoft.net/about-the-crew/)');
  });

  it('runs two jobs at once in two tabs', async () => {
    // Slow answers so both tabs are busy at the same time.
    fake = { variant: 'standard', mode: 'normal', chunkMs: 700, chunkSize: 8 };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const a = await request('First parallel prompt');
    const b = await request('Second parallel prompt');
    const both = await waitFor(
      async () => {
        await browser!.tick().catch(() => {});
        const active = await client.queueJob.findMany({ where: { relatedId: { in: [a.responseId, b.responseId] }, status: 'ACTIVE' } });
        return active.length === 2 ? active : null;
      },
      90_000,
      'two jobs active at once',
      500,
    );
    expect(new Set(both.map((j) => j.claimedByTab)).size).toBe(2);
    const [ra, rb] = await Promise.all([responseDone(a.responseId, 120_000), responseDone(b.responseId, 120_000)]);
    expect(ra.status).toBe('COMPLETED');
    expect(rb.status).toBe('COMPLETED');
    const [ja, jb] = [await jobOf(a.responseId), await jobOf(b.responseId)];
    expect(ja.claimedByTab).not.toBe(jb.claimedByTab);
    expect(ra.conversationUrl).not.toBe(rb.conversationUrl);
  });

  it('recovers the answer after the page reloads mid-generation without resending the prompt', async () => {
    fake = { variant: 'standard', mode: 'normal', chunkMs: 400, chunkSize: 15 };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const req = await request('Interrupted completion prompt');
    await waitJob(req.responseId, (j) => Boolean(j.progress && JSON.parse(j.progress).sent), 60_000, 'prompt sent');
    await chatPage()!.reload();
    const done = await responseDone(req.responseId, 90_000);
    expect(done.status).toBe('COMPLETED');
    expect(done.recovered).toBe(true);
    expect(done.resultText).toContain('final paragraph');
    expect((await fakeStats()).sends).toBe(1);
  });

  it('after a reload, waits for a slowly rendered conversation instead of reporting the sent prompt as missing', async () => {
    // Seen on the owner's PC: the real ChatGPT shows the composer before the conversation's turns after a reload.
    fake = { variant: 'standard', mode: 'normal', chunkMs: 400, chunkSize: 15, historyDelayMs: 6000 };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const req = await request('Slow history prompt');
    await waitJob(req.responseId, (j) => Boolean(j.progress && JSON.parse(j.progress).sent), 60_000, 'prompt sent');
    await chatPage()!.reload();
    const done = await responseDone(req.responseId, 90_000);
    expect(done.error).toBeNull();
    expect(done.status).toBe('COMPLETED');
    expect(done.recovered).toBe(true);
    expect(done.resultText).toContain('final paragraph');
    expect((await fakeStats()).sends).toBe(1);
  });

  it('nested turn markup: a long prompt shown shortened is still recognised after a reload (sent once)', async () => {
    fake = { variant: 'standard', mode: 'normal', chunkMs: 400, chunkSize: 15, historyDelayMs: 2000, turnMarkup: 'article', userDisplay: 'short' };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const prompt = ['Generate several credible blog titles for: "Gloria Krass" (reader-focused).', '', ...Array.from({ length: 30 }, (_, i) => `Rule ${i + 1}: keep every title natural and specific.`)].join('\n');
    const req = await request(prompt);
    await waitJob(req.responseId, (j) => Boolean(j.progress && JSON.parse(j.progress).sent), 60_000, 'prompt sent');
    await chatPage()!.reload();
    const done = await responseDone(req.responseId, 90_000);
    expect(done.error).toBeNull();
    expect(done.status).toBe('COMPLETED');
    expect(done.recovered).toBe(true);
    expect((await fakeStats()).sends).toBe(1);
  });

  it('nested turn markup: a follow-up prompt in the same conversation gets its own answer, not the previous one', async () => {
    fake = { variant: 'standard', mode: 'normal', turnMarkup: 'article', answers: ['First answer: alpha.', 'Second answer: beta.'] };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const first = await request('First prompt with nested turns');
    const one = await responseDone(first.responseId, 60_000);
    expect(one.resultText).toContain('alpha');
    const second = await request('Second prompt with nested turns', { conversationUrl: one.conversationUrl, newChat: false });
    const two = await responseDone(second.responseId, 60_000);
    expect(two.status).toBe('COMPLETED');
    expect(two.resultText).toContain('beta');
    expect(two.resultText).not.toContain('alpha');
    expect(two.conversationUrl).toBe(one.conversationUrl);
  });

  it('Chat/Work layout (no data-message-author-role): one prompt → one complete answer', async () => {
    fake = { variant: 'standard', mode: 'normal', turnMarkup: 'units' };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const req = await request('Prompt on the new layout');
    const done = await responseDone(req.responseId, 60_000);
    expect(done.error).toBeNull();
    expect(done.status).toBe('COMPLETED');
    expect(done.resultText).toContain('## Answer heading');
    expect(done.resultText).toContain('| Full Name | Example Person |');
    expect(done.resultText).toContain('final paragraph');
    expect(done.resultText).not.toContain('⧉');
    expect((await fakeStats()).sends).toBe(1);
  });

  it('Chat/Work layout: after a reload the sent prompt is found and its answer recovered (sent once)', async () => {
    fake = { variant: 'standard', mode: 'normal', chunkMs: 400, chunkSize: 15, historyDelayMs: 2000, turnMarkup: 'units' };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const req = await request('Reloaded prompt on the new layout');
    await waitJob(req.responseId, (j) => Boolean(j.progress && JSON.parse(j.progress).sent), 60_000, 'prompt sent');
    await chatPage()!.reload();
    const done = await responseDone(req.responseId, 90_000);
    expect(done.error).toBeNull();
    expect(done.status).toBe('COMPLETED');
    expect(done.recovered).toBe(true);
    expect(done.resultText).toContain('final paragraph');
    expect((await fakeStats()).sends).toBe(1);
  });

  it('Chat/Work layout: a follow-up prompt in the same conversation gets its own answer', async () => {
    fake = { variant: 'standard', mode: 'normal', turnMarkup: 'units', answers: ['First answer: alpha.', 'Second answer: beta.'] };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const first = await request('First prompt on the new layout');
    const one = await responseDone(first.responseId, 60_000);
    expect(one.resultText).toContain('alpha');
    const second = await request('Second prompt on the new layout', { conversationUrl: one.conversationUrl, newChat: false });
    const two = await responseDone(second.responseId, 60_000);
    expect(two.resultText).toContain('beta');
    expect(two.resultText).not.toContain('alpha');
  });

  it('Chat/Work layout: line breaks the page shows inside a paragraph are kept (FAQ pairs parse)', async () => {
    // The owner's FAQ answer: QUESTION/ANSWER lines in one paragraph, broken by CSS-kept newlines rather than <br>.
    const pairs = Array.from({ length: 5 }, (_, i) => `QUESTION: Frage ${i + 1} zu Gloria Krass?\nANSWER: Antwort ${i + 1} in einem Satz.`);
    fake = { variant: 'standard', mode: 'normal', turnMarkup: 'units', softBreaks: true, answers: [pairs.join('\n\n')] };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const req = await request('FAQ prompt on the new layout');
    const done = await responseDone(req.responseId, 60_000);
    expect(done.status).toBe('COMPLETED');
    expect(done.resultText).toContain('QUESTION: Frage 1 zu Gloria Krass?\nANSWER: Antwort 1 in einem Satz.');
    const { parseFaqs } = await import('@/modules/celebrity-writer/parsers');
    expect(parseFaqs(done.resultText!)).toHaveLength(5);
  });

  it('long conversation with only the last turns in the page: each follow-up finds its own prompt and answer', async () => {
    // The owner's live run: after the long article stages, QUICK_BIO waited 600 s although ChatGPT had answered.
    fake = { variant: 'standard', mode: 'normal', turnMarkup: 'units', virtualize: 2, answers: ['First answer: alpha.', 'Second answer: beta.', 'Third answer: gamma.'] };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const first = await request('First prompt in a long conversation');
    const one = await responseDone(first.responseId, 60_000);
    expect(one.resultText).toContain('alpha');
    const second = await request('Second prompt in a long conversation', { conversationUrl: one.conversationUrl, newChat: false });
    const two = await responseDone(second.responseId, 60_000);
    expect(two.status).toBe('COMPLETED');
    expect(two.resultText).toContain('beta');
    const third = await request('Third prompt in a long conversation', { conversationUrl: one.conversationUrl, newChat: false });
    const three = await responseDone(third.responseId, 60_000);
    expect(three.resultText).toContain('gamma');
    expect(three.recovered).toBe(false);
    expect((await fakeStats()).sends).toBe(3);
  });

  it('image search (celebrity photos, as in the owner’s earlier tool): opens the gallery, saves its pictures, reports other hosts as links', async () => {
    fake = { variant: 'standard', mode: 'normal', turnMarkup: 'units', galleryCount: 4, galleryLinks: ['https://news.example/photo-1.jpg'] };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const req = await request('Search the web for real photos of Gloria Krass and show them as an image gallery.', { expectGallery: true });
    const done = await responseDone(req.responseId, 90_000);
    expect(done.status).toBe('COMPLETED');
    expect(done.resultText).toContain('Here are recent photos.');
    const assets = await client.mediaAsset.findMany({ where: { responseId: req.responseId } });
    // The viewer's four large pictures (1024×576) were saved, plus the small thumbnails (filtered later by the app).
    expect(assets.filter((a) => (a.width ?? 0) >= 1000)).toHaveLength(4);
    expect(assets.every((a) => a.role === 'GALLERY' && a.origin === 'CHATGPT')).toBe(true);
    expect(JSON.parse(done.imageLinks!)).toEqual([expect.objectContaining({ url: 'https://news.example/photo-1.jpg' })]);
    expect(await chatPage()!.evaluate(() => (window as unknown as { __galleryOpened?: number }).__galleryOpened)).toBe(1);
    expect((await fakeStats()).sends).toBe(1);
  });

  it('a reload into a new chat: the recorded conversation is opened and the answer recovered (sent once)', async () => {
    fake = { variant: 'standard', mode: 'normal', chunkMs: 500, chunkSize: 10 };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const req = await request('Reloaded into a new chat prompt');
    await waitJob(req.responseId, (j) => Boolean(j.progress && JSON.parse(j.progress).conversationUrl), 60_000, 'conversation recorded');
    await chatPage()!.goto('https://chatgpt.com/');
    const done = await responseDone(req.responseId, 120_000);
    expect(done.error).toBeNull();
    expect(done.status).toBe('COMPLETED');
    expect(done.recovered).toBe(true);
    expect((await fakeStats()).sends).toBe(1);
  });

  it('a sent prompt that is really gone stops for review and says why', async () => {
    fake = { variant: 'standard', mode: 'normal', chunkMs: 500, chunkSize: 5 };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const req = await request('Prompt that disappears');
    await waitJob(req.responseId, (j) => Boolean(j.progress && JSON.parse(j.progress).conversationUrl), 60_000, 'conversation recorded');
    const page = chatPage()!;
    await page.evaluate(() => {
      const id = location.pathname.split('/').pop()!;
      const convs = JSON.parse(localStorage.getItem('fake:convs') || '{}');
      convs[id] = { turns: [] };
      localStorage.setItem('fake:convs', JSON.stringify(convs));
    });
    await page.reload();
    const done = await responseDone(req.responseId, 120_000);
    expect(done.status).toBe('FAILED');
    expect(done.error).toMatch(/^UNCERTAIN: The app recorded this prompt as sent/);
    expect(done.error).toContain('restarted after: the ChatGPT page reloaded');
    expect(done.error).toContain('0 user turn(s)');
    expect(done.error).toContain('markers: none of the known markers');
    expect(done.error).toContain('prompt text not on the page');
    expect((await fakeStats()).sends).toBe(1);
  });

  it('reports CONVERSATION_LOST for a stale saved conversation', async () => {
    fake = { variant: 'standard', mode: 'normal' };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const req = await request('Stale conversation prompt', { conversationUrl: 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000000', newChat: false });
    const done = await responseDone(req.responseId);
    expect(done.status).toBe('FAILED');
    expect(done.error).toMatch(/^CONVERSATION_LOST/);
    const task = await client.articleTask.findUniqueOrThrow({ where: { id: req.taskId } });
    expect(task.conversationUrl).toBeNull();
  });

  it('pauses for login instead of automating it', async () => {
    fake = { variant: 'standard', mode: 'login' };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const req = await request('Login required prompt');
    const job = await waitJob(req.responseId, (j) => j.errorCode === 'LOGIN', 60_000, 'LOGIN failure');
    expect(job.status).toBe('WAITING');
    const task = await client.articleTask.findUniqueOrThrow({ where: { id: req.taskId } });
    expect(task.status).toBe('LOGIN_REQUIRED');
    expect(task.pausedFor).toBe('chatgpt-login');
    expect((await fakeStats()).sends).toBe(0);
  });

  it('waits while the owner completes a human check, and pauses if it is not completed', async () => {
    fake = { variant: 'standard', mode: 'challenge-clears', challengeClearsAfterMs: 3000 };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const ok = await request('Challenge clears prompt');
    expect((await responseDone(ok.responseId, 90_000)).status).toBe('COMPLETED');
    await browser.close();
    fake = { variant: 'standard', mode: 'challenge' };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const blocked = await request('Challenge stays prompt');
    await waitJob(blocked.responseId, (j) => j.errorCode === 'HUMAN_CHECK', 60_000, 'HUMAN_CHECK failure');
    const task = await client.articleTask.findUniqueOrThrow({ where: { id: blocked.taskId } });
    expect(task.status).toBe('PAUSED');
    expect(task.pausedFor).toBe('chatgpt-human-check');
  });

  it('backs off on a usage limit / 429 and refuses new claims until the window passes', async () => {
    fake = { variant: 'standard', mode: 'usage-limit' };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const req = await request('Usage limit prompt');
    const job = await waitJob(req.responseId, (j) => j.errorCode === 'USAGE_LIMIT', 60_000, 'USAGE_LIMIT');
    expect(job.status).toBe('WAITING');
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
    const { getRateState } = await import('@/lib/chatgpt/rate');
    const rate = await getRateState();
    expect(new Date(rate.backoffUntil!).getTime()).toBeGreaterThan(Date.now() + 60_000);
    const refused = await jobs.claimChatGPTJob({ installId: 'other', tabId: 'x' });
    expect(refused).toEqual(expect.objectContaining({ reason: 'backoff' }));
    const task = await client.articleTask.findUniqueOrThrow({ where: { id: req.taskId } });
    expect(task.pausedFor).toBe('usage-limit');
  });

  it('closing a tab that owns a job releases it; the next claim reconciles instead of resending', async () => {
    fake = { variant: 'standard', mode: 'normal', chunkMs: 400, chunkSize: 15 };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const req = await request('Tab closed mid-run prompt');
    const active = await waitJob(req.responseId, (j) => j.status === 'ACTIVE' && Boolean(j.progress && JSON.parse(j.progress).sent), 60_000, 'sent');
    const tabId = Number(active.claimedByTab);
    await browser.sw.evaluate(async (id) => chrome.tabs.remove(id), tabId);
    await waitFor(async () => (await jobOf(req.responseId)).claimedByTab !== String(tabId), 20_000, 'release');
    const incident = await client.recoveryIncident.findFirst({ where: { taskId: req.taskId, kind: 'UNCERTAIN_PROMPT' } });
    expect(incident).not.toBeNull();
    const done = await responseDone(req.responseId, 120_000);
    expect(done.status).toBe('COMPLETED');
    expect(done.recovered).toBe(true);
    expect((await fakeStats()).sends).toBe(1);
  });

  it('attaches files only when the job asks for them', async () => {
    fake = { variant: 'standard', mode: 'normal' };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#3366aa' } }).png().toBuffer();
    const task = await createTask(client, siteId);
    const { storeImage } = await import('@/images/store');
    const { asset } = await storeImage({ buffer: png, taskId: task.id, role: 'GALLERY', origin: 'UPLOADED' });
    const fresh = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    const res = await jobs.createChatGPTRequest({ task: fresh, stageKey: 'PHOTO_CHECK', attempt: 1, operationId: `${task.id}:PHOTO:a1`, prompt: 'Check the attached photo.', newChat: true, timeoutSec: 120, attachments: [{ mediaAssetId: asset.id, name: 'photo-1.webp', mime: 'image/webp' }] });
    const done = await responseDone(res.responseId);
    expect(done.status).toBe('COMPLETED');
    const files = JSON.parse((await fakeStats()).lastFiles ?? '[]');
    expect(files).toEqual([expect.objectContaining({ name: 'photo-1.webp', type: 'image/webp' })]);
  });

  it('reports missing DOM markers with a debug snapshot instead of hanging', async () => {
    fake = { variant: 'broken', mode: 'normal' };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const req = await request('Broken DOM prompt');
    const job = await waitJob(req.responseId, (j) => Boolean(j.error && /composer did not become ready/.test(j.error)), 60_000, 'composer error');
    const snapshot = JSON.parse(job.progress ?? '{}').failureSnapshot;
    expect(snapshot).toEqual(expect.objectContaining({ composerFound: false, url: 'https://chatgpt.com/' }));
    expect((await fakeStats()).sends).toBe(0);
  });
  it('image answers: waits for the generated image, uploads it to the dashboard and completes with the image', async () => {
    fake = { variant: 'standard', mode: 'normal', answers: ['IMAGE: Here is your illustration.'], chunkMs: 60 };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const req = await request('Create one clean editorial illustration based on this approved image brief: a desk with a laptop', { expectImages: true });
    const done = await responseDone(req.responseId, 90_000);
    expect(done.status).toBe('COMPLETED');
    const assets = await client.mediaAsset.findMany({ where: { responseId: req.responseId } });
    expect(assets).toHaveLength(1);
    expect(assets[0].origin).toBe('CHATGPT');
    expect(assets[0].width).toBe(1024);
    expect(assets[0].sourceUrl).toContain('/backend-api/estuary/content?id=file_');
  });

  it("owner report: a picture with unknown markup, and a streaming marker that stays, still completes (earlier tool's rule)", async () => {
    fake = { variant: 'standard', mode: 'normal', answers: ['IMAGE: '], imageMarkup: 'unknown', staleStreaming: true, chunkMs: 60 };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const req = await request('Create this image now, landscape (wide) format:\n\nA header with the title "Pulsamento"\n\nOnly create the image — no text answer is needed.', { expectImages: true });
    const done = await responseDone(req.responseId, 150_000);
    expect(done.error).toBeNull();
    expect(done.status).toBe('COMPLETED');
    const assets = await client.mediaAsset.findMany({ where: { responseId: req.responseId } });
    expect(assets).toHaveLength(1);
    expect(assets[0].sourceUrl).toContain('/backend-api/files/download');
  });

  it("owner report: a recovered job takes the answer to its own prompt, not a later prompt's answer in the same chat", async () => {
    fake = { variant: 'standard', mode: 'normal', chunkMs: 500, chunkSize: 4 };
    browser = await launchWithExtension({ serverOrigin: server.origin, key, config: () => fake });
    const prompt = 'Featured image prompt that was interrupted';
    const req = await request(prompt);
    await waitJob(req.responseId, (j) => Boolean(j.progress && JSON.parse(j.progress).conversationUrl), 60_000, 'conversation recorded');
    const page = chatPage()!;
    // While the job was interrupted, another article's prompt was answered in the same chat (as in the report).
    await page.evaluate((p) => {
      const id = location.pathname.split('/').pop()!;
      const convs = JSON.parse(localStorage.getItem('fake:convs') || '{}');
      convs[id] = { turns: [{ role: 'user', text: p }, { role: 'assistant', text: 'The answer to the featured prompt.' }, { role: 'user', text: 'Humanize these paragraphs of another article.' }, { role: 'assistant', text: 'Cy Kass is the eldest son of journalist Alex Wagner.' }] };
      localStorage.setItem('fake:convs', JSON.stringify(convs));
    }, prompt);
    await page.reload();
    const done = await responseDone(req.responseId, 120_000);
    expect(done.status).toBe('COMPLETED');
    expect(done.recovered).toBe(true);
    expect(done.resultText).toContain('The answer to the featured prompt.');
    expect(done.resultText).not.toContain('Cy Kass');
  });
});
