import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { createTask, createWebsite } from '../helpers/fixtures';
import type { NotifySnapshot } from '@/lib/notify/events';
import type { Toast } from '@/lib/notify/windows';

/** Owner request: Windows notifications (no outside service) when an article needs review — also from the workflow —,
 * ChatGPT is signed out, a campaign finished. */
// The database is set up before the modules load (they open it when imported).
let client: PrismaClient;
let ev: typeof import('@/lib/notify/events');
let win: typeof import('@/lib/notify/windows');
beforeAll(async () => {
  ({ client } = await setupTestDb());
  ev = await import('@/lib/notify/events');
  win = await import('@/lib/notify/windows');
});
const newEvents = (...a: Parameters<typeof ev.newEvents>) => ev.newEvents(...a);

const all = { review: true, chatgptSignedOut: true, campaignFinished: true };
const O = 'http://localhost:3000';
const snap = (over: Partial<NotifySnapshot> = {}): NotifySnapshot => ({ review: [], campaigns: [], chatgptSignedOut: false, ...over });
const task = (id: string, status = 'NEEDS_REVIEW', source = 'SINGLE') => ({ id, keyword: `Keyword ${id}`, status, source, website: 'Easy Vibs' });

describe('what is notified', () => {
  it('the first look only remembers what already waits; later, each new event once', () => {
    const first = newEvents(snap({ review: [task('a')], chatgptSignedOut: true, campaigns: [{ id: 'c1', name: 'Old', message: null }] }), null, all, O);
    expect(first.toasts).toEqual([]);
    const second = newEvents(snap({ review: [task('a'), task('b', 'NEEDS_REVIEW', 'WORKFLOW'), task('c', 'AWAITING_TITLE_APPROVAL')], chatgptSignedOut: true, campaigns: [{ id: 'c1', name: 'Old', message: null }, { id: 'c2', name: 'October', message: 'Finished: 9 draft(s), 1 need review, 0 failed.' }] }), first.state, all, O);
    expect(second.toasts).toEqual([
      { title: 'Workflow: article needs review', body: 'Keyword b · Easy Vibs', url: `${O}/articles/b` },
      { title: 'Title approval needed', body: 'Keyword c · Easy Vibs', url: `${O}/articles/c` },
      { title: 'Campaign finished', body: 'October: 9 draft(s), 1 need review, 0 failed.', url: `${O}/campaigns/c2` },
    ]);
    // Nothing new: nothing shown.
    expect(newEvents(snap({ review: [task('a'), task('b', 'NEEDS_REVIEW', 'WORKFLOW'), task('c', 'AWAITING_TITLE_APPROVAL')], chatgptSignedOut: true, campaigns: [{ id: 'c2', name: 'October', message: null }] }), second.state, all, O).toasts).toEqual([]);
  });

  it('an article back in review after a retry is notified again; ChatGPT signed out only when it changes', () => {
    let state = newEvents(snap({ review: [task('a')] }), null, all, O).state;
    state = newEvents(snap({ review: [] }), state, all, O).state;
    const back = newEvents(snap({ review: [task('a')], chatgptSignedOut: true }), state, all, O);
    expect(back.toasts.map((t) => t.title)).toEqual(['Article needs review', 'ChatGPT is signed out']);
    expect(back.toasts[1].url).toBe(`${O}/automation-chrome`);
    expect(newEvents(snap({ review: [task('a')], chatgptSignedOut: true }), back.state, all, O).toasts).toEqual([]);
  });

  it('more than 3 at once: one notification with the count; switched-off kinds are not shown', () => {
    const state = newEvents(snap(), null, all, O).state;
    const many = snap({ review: ['a', 'b', 'c', 'd', 'e'].map((id, i) => task(id, 'NEEDS_REVIEW', i < 2 ? 'WORKFLOW' : 'BULK')) });
    expect(newEvents(many, state, all, O).toasts).toEqual([{ title: '5 articles need your review', body: 'Keyword a, Keyword b, Keyword c… (2 from the workflow)', url: `${O}/queue?group=review` }]);
    expect(newEvents(many, state, { ...all, review: false }, O).toasts).toEqual([]);
  });
});

describe('the Windows toast', () => {
  it('escapes the text in its XML and opens the page on a click', () => {
    const xml = win.toastXml({ title: 'Article needs review', body: 'Tom & Jerry <script> “x” · Easy Vibs', url: `${O}/articles/a?x=1&y=2` });
    expect(xml).toContain('<text>Tom &amp; Jerry &lt;script&gt; “x” · Easy Vibs</text>');
    expect(xml).toContain(`launch="${O}/articles/a?x=1&amp;y=2"`);
    expect(xml).toContain('<action content="Open" activationType="protocol"');
    // The script never holds the text: it reads the XML from the environment.
    expect(win.TOAST_SCRIPT).toContain('$env:BAS_TOAST_XML');
    expect(win.TOAST_SCRIPT).not.toContain('Easy Vibs');
  });

  it('is shown on Windows only (nothing happens here)', async () => {
    expect(await win.showToast({ title: 't', body: 'b', url: O }, 'linux')).toEqual({ shown: false, error: 'Windows notifications appear on Windows only.' });
  });
});

describe('the worker loop', () => {
  it('finds review articles (workflow ones too) and a signed-out ChatGPT in the database, once each', async () => {
    const { notifyTick } = ev;
    const shown: Toast[] = [];
    const show = async (t: Toast) => {
      shown.push(t);
      return { shown: true };
    };
    const site = await createWebsite(client, { name: 'Notify Site' });
    await notifyTick(show);
    expect(shown).toEqual([]);
    const t1 = await createTask(client, site.id, { keyword: 'workflow keyword one' });
    await client.articleTask.update({ where: { id: t1.id }, data: { status: 'NEEDS_REVIEW', source: 'WORKFLOW' } });
    await client.workerStatus.create({ data: { id: 'extension:notify-test', kind: 'EXTENSION', version: '3.5.0', status: 'CONNECTED', lastSeenAt: new Date(), diagnostics: JSON.stringify({ loggedIn: false }) } });
    expect(await notifyTick(show)).toBe(2);
    expect(shown.map((t) => t.title)).toEqual(['Workflow: article needs review', 'ChatGPT is signed out']);
    expect(shown[0].body).toBe('workflow keyword one · Notify Site');
    expect(await notifyTick(show)).toBe(0);
    // Switched off in Settings → Notifications: still remembered, not shown.
    const { updateSettings } = await import('@/lib/settings');
    await updateSettings({ notifications: { windows: false } });
    const t2 = await createTask(client, site.id, { keyword: 'second keyword' });
    await client.articleTask.update({ where: { id: t2.id }, data: { status: 'NEEDS_REVIEW' } });
    expect(await notifyTick(show)).toBe(0);
    await updateSettings({ notifications: { windows: true } });
    expect(await notifyTick(show)).toBe(0);
  });
});
