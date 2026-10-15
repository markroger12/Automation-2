import type { Page, Response } from 'playwright';
import { LoginRequiredError, TransientError } from '@/lib/pipeline-errors';
import { anyOf, selectorsFor } from './selectors';
import { boundedGoto, captureScreenshot, dismissOverlays, type SiteRef } from './browser';
import { isLoggedIn } from './session';
import { restRouteOf } from './publish-guard';
import { parseRankMathScore, rankMathReadScript, type RankMathReading } from './rank-math';

/**
 * Opens a post in the WordPress editor (Gutenberg or Classic) and checks what
 * the editor itself sees: post ID, status, title, block validity, and the Rank
 * Math fields/score. Optionally saves through the editor and verifies the
 * post status WordPress returns. In-page scripts are plain strings so no
 * build-tool helper is injected into the page.
 */

export interface EditorInspection {
  editor: 'GUTENBERG' | 'CLASSIC' | 'UNKNOWN';
  postId: number | null;
  status: string | null;
  title: string | null;
  blockCount: number;
  invalidBlocks: { name: string; index: number }[];
  rankMath: RankMathReading | null;
  save: { attempted: boolean; ok: boolean; status: string | null; detail: string };
  overlaysHidden: number;
  screenshot: string | null;
}

interface InspectOptions {
  rankMath: boolean;
  save: boolean;
  timeoutMs: number;
  selectorOverrides: Record<string, string[]>;
  screenshots: boolean;
  taskId?: string | null;
  /** How long to wait for Rank Math's score to appear and settle. */
  rankMathWaitMs?: number;
}

const GUTENBERG_STATE = `(() => {
  const w = window;
  if (!(w.wp && w.wp.data && w.wp.data.select('core/editor'))) return null;
  const ed = w.wp.data.select('core/editor');
  const be = w.wp.data.select('core/block-editor');
  const flat = [];
  const walk = (bs) => { for (const b of bs) { flat.push(b); walk(b.innerBlocks || []); } };
  try { walk(be.getBlocks()); } catch (e) {}
  return {
    postId: ed.getCurrentPostId(),
    status: ed.getCurrentPostAttribute('status'),
    title: ed.getEditedPostAttribute('title'),
    blockCount: flat.length,
    invalid: flat.map((b, i) => ({ name: b.name, index: i, valid: b.isValid })).filter((b) => b.valid === false).map((b) => ({ name: b.name, index: b.index })),
    ready: typeof ed.__unstableIsEditorReady === 'function' ? ed.__unstableIsEditorReady() : true,
  };
})()`;

const CLASSIC_STATE = `(() => {
  const id = document.querySelector('#post_ID');
  if (!id) return null;
  const val = (s) => { const el = document.querySelector(s); return el ? el.value : null; };
  return { postId: Number(id.value) || null, status: val('#original_post_status') || val('#hidden_post_status'), title: val('#title'), contentLength: (val('#content') || '').length };
})()`;

const CLOSE_WELCOME = `(() => {
  try {
    const w = window;
    const prefs = w.wp && w.wp.data && w.wp.data.dispatch('core/preferences');
    if (prefs && prefs.set) { prefs.set('core/edit-post', 'welcomeGuide', false); prefs.set('core/edit-post', 'welcomeGuideTemplate', false); }
  } catch (e) {}
  return true;
})()`;

async function waitForEditor(page: Page, timeoutMs: number): Promise<'GUTENBERG' | 'CLASSIC' | 'UNKNOWN'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const g = (await page.evaluate(GUTENBERG_STATE).catch(() => null)) as { postId: number | null; blockCount: number; ready: boolean } | null;
    if (g && g.postId && g.ready) return 'GUTENBERG';
    const c = await page.evaluate(CLASSIC_STATE).catch(() => null);
    if (c) return 'CLASSIC';
    await page.waitForTimeout(400);
  }
  return 'UNKNOWN';
}

async function readRankMath(page: Page, opts: InspectOptions): Promise<RankMathReading> {
  const script = rankMathReadScript({ score: selectorsFor('rankMathScore', opts.selectorOverrides), recommendations: selectorsFor('rankMathRecommendations', opts.selectorOverrides) });
  const deadline = Date.now() + (opts.rankMathWaitMs ?? 20_000);
  type Raw = Omit<RankMathReading, 'score'> & { storeScore: number | null };
  // Rank Math shows 0 (in its store and its panel) until it has analysed the content: 0 is "not computed yet",
  // never a result. Prefer a positive store value, then a positive panel value.
  const scoreOf = (raw: Raw): { score: number | null; via: string | null; zero: boolean } => {
    const panel = parseRankMathScore(raw.scoreText);
    if (raw.storeScore !== null && raw.storeScore > 0) return { score: raw.storeScore, via: 'store', zero: false };
    if (panel !== null && panel > 0) return { score: panel, via: raw.scoreVia, zero: false };
    return { score: null, via: null, zero: raw.storeScore === 0 || panel === 0 };
  };
  let last: Raw | null = null;
  let lastScore: { score: number | null; via: string | null; zero: boolean } = { score: null, via: null, zero: false };
  let sawPositive = false;
  let sawZero = false;
  let stable = 0;
  let previousScore: number | null = null;
  let openedPanel = false;
  const started = Date.now();
  const openPanel = async () => {
    openedPanel = true;
    const trigger = page.locator(anyOf('rankMathTabTrigger', opts.selectorOverrides)).first();
    if ((await trigger.count().catch(() => 0)) > 0) await trigger.click({ timeout: 3000 }).catch(() => {});
  };
  while (Date.now() < deadline) {
    const raw = (await page.evaluate(script).catch(() => null)) as Raw | null;
    // Nothing from Rank Math on the page after a few seconds: it is not active in this editor.
    if (raw && !raw.present && Date.now() - started > 6000) {
      last = raw;
      break;
    }
    if (raw) {
      last = raw;
      lastScore = scoreOf(raw);
      if (lastScore.zero) sawZero = true;
      const score = lastScore.score;
      if (score !== null) sawPositive = true;
      if (score !== null && score === previousScore) stable++;
      else stable = 0;
      previousScore = score;
      // Rank Math recalculates as the editor settles: require three equal reads.
      if (score !== null && stable >= 2 && (raw.recommendations.length > 0 || openedPanel)) break;
      // Opening the Rank Math panel shows its checks and makes it analyse the content if it has not yet.
      if (!openedPanel && ((score !== null && stable >= 2) || (score === null && Date.now() - started > 3000))) await openPanel();
    }
    await page.waitForTimeout(700);
  }
  const score = lastScore.score !== null && (stable >= 2 || lastScore.via === 'store') ? lastScore.score : null;
  return {
    present: Boolean(last?.present),
    fields: last?.fields ?? { focusKeyword: null, title: null, description: null },
    fieldsVia: last?.fieldsVia ?? null,
    score,
    scoreText: last?.scoreText ?? null,
    scoreVia: score !== null ? lastScore.via : null,
    recommendations: last?.recommendations ?? [],
    zeroOnly: score === null && sawZero && !sawPositive,
  };
}

function isPostSaveResponse(res: Response, postId: number): boolean {
  const req = res.request();
  const method = (req.headers()['x-http-method-override'] ?? req.method()).toUpperCase();
  if (method !== 'POST' && method !== 'PUT') return false;
  let url: URL;
  try {
    url = new URL(res.url());
  } catch {
    return false;
  }
  const route = restRouteOf(url);
  return route !== null && new RegExp(`^/wp/v2/posts/${postId}/?$`).test(route);
}

async function saveInEditor(page: Page, editor: 'GUTENBERG' | 'CLASSIC', postId: number, timeoutMs: number): Promise<EditorInspection['save']> {
  if (editor === 'GUTENBERG') {
    const responsePromise = page.waitForResponse((r) => isPostSaveResponse(r, postId), { timeout: Math.min(timeoutMs, 45_000) }).catch(() => null);
    await page.evaluate(`wp.data.dispatch('core/editor').savePost()`).catch(() => {});
    const res = await responsePromise;
    if (!res) return { attempted: true, ok: false, status: null, detail: 'The editor did not send a save request (nothing to save, or the save button is unavailable).' };
    const json = (await res.json().catch(() => null)) as { status?: string; code?: string; message?: string } | null;
    if (!res.ok()) return { attempted: true, ok: false, status: null, detail: `Editor save answered ${res.status()}${json?.code ? ` (${json.code})` : ''}.` };
    return { attempted: true, ok: json?.status === 'draft' || json?.status === 'pending', status: json?.status ?? null, detail: `Editor save returned status “${json?.status ?? '?'}”.` };
  }
  const button = page.locator('#save-post');
  if ((await button.count()) === 0) return { attempted: false, ok: false, status: null, detail: 'No “Save Draft” button (post is not a draft?).' };
  // WordPress answers a Classic save with a redirect to post.php?post=ID&action=edit&message=N.
  const saved = page.waitForURL((u) => /[?&]message=\d+/.test(u.search) && u.searchParams.get('post') === String(postId), { timeout: Math.min(timeoutMs, 60_000) }).then(
    () => true,
    () => false,
  );
  await button.click({ timeout: 10_000 });
  if (!(await saved)) return { attempted: true, ok: false, status: null, detail: 'WordPress did not confirm the Classic editor save (no redirect).' };
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const state = (await page.evaluate(CLASSIC_STATE).catch(() => null)) as { status: string | null } | null;
  const status = state?.status ?? null;
  return { attempted: true, ok: status === 'draft' || status === 'pending', status, detail: `After saving, WordPress shows status “${status ?? '?'}”.` };
}

export async function inspectInEditor(page: Page, site: SiteRef, postId: number, opts: InspectOptions): Promise<EditorInspection> {
  const editUrl = `${site.adminUrl}post.php?post=${postId}&action=edit`;
  try {
    await boundedGoto(page, editUrl, opts.timeoutMs);
  } catch (error) {
    throw new TransientError(`Could not open the editor for draft #${postId}: ${(error as Error).message.split('\n')[0]}`);
  }
  if (/wp-login\.php/i.test(page.url()) || (await page.locator(anyOf('loginForm', opts.selectorOverrides)).count().catch(() => 0)) > 0) {
    throw new LoginRequiredError('wordpress', `${site.name}: WordPress asks for a login while opening draft #${postId}.`, site.id);
  }
  let overlaysHidden = await dismissOverlays(page, opts.selectorOverrides);
  const editor = await waitForEditor(page, Math.min(opts.timeoutMs, 60_000));
  overlaysHidden += await dismissOverlays(page, opts.selectorOverrides);
  if (!(await isLoggedIn(page, opts.selectorOverrides)) && editor === 'UNKNOWN') {
    throw new LoginRequiredError('wordpress', `${site.name}: not logged in while opening draft #${postId}.`, site.id);
  }
  const result: EditorInspection = {
    editor,
    postId: null,
    status: null,
    title: null,
    blockCount: 0,
    invalidBlocks: [],
    rankMath: null,
    save: { attempted: false, ok: false, status: null, detail: 'Not requested.' },
    overlaysHidden,
    screenshot: null,
  };
  if (editor === 'GUTENBERG') {
    await page.evaluate(CLOSE_WELCOME).catch(() => {});
    for (const sel of selectorsFor('welcomeGuideClose', opts.selectorOverrides)) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) await btn.click({ timeout: 2000 }).catch(() => {});
    }
    // Give the parser a moment to populate blocks for long posts.
    const deadline = Date.now() + 10_000;
    let state = (await page.evaluate(GUTENBERG_STATE)) as { postId: number; status: string; title: string; blockCount: number; invalid: { name: string; index: number }[] };
    while (state.blockCount === 0 && Date.now() < deadline) {
      await page.waitForTimeout(400);
      state = (await page.evaluate(GUTENBERG_STATE)) as typeof state;
    }
    Object.assign(result, { postId: state.postId, status: state.status, title: state.title, blockCount: state.blockCount, invalidBlocks: state.invalid });
  } else if (editor === 'CLASSIC') {
    const state = (await page.evaluate(CLASSIC_STATE)) as { postId: number | null; status: string | null; title: string | null };
    Object.assign(result, { postId: state.postId, status: state.status, title: state.title });
  } else {
    if (opts.screenshots) result.screenshot = await captureScreenshot(page, `${site.slug}-editor-unknown`, opts.taskId);
    return result;
  }
  if (result.postId !== postId) throw new TransientError(`The editor opened post #${result.postId ?? '?'} instead of #${postId}.`);
  if (opts.rankMath) result.rankMath = await readRankMath(page, opts);
  if (opts.save && (result.status === 'draft' || result.status === 'pending')) {
    result.save = await saveInEditor(page, editor, postId, opts.timeoutMs);
    if (editor === 'CLASSIC') {
      const state = (await page.evaluate(CLASSIC_STATE).catch(() => null)) as { status: string | null } | null;
      if (state?.status) result.status = state.status;
    }
  }
  if (opts.screenshots && (result.invalidBlocks.length || (opts.rankMath && result.rankMath?.score === null))) {
    result.screenshot = await captureScreenshot(page, `${site.slug}-editor-check`, opts.taskId);
  }
  return result;
}
