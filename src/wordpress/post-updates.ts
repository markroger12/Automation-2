import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import type { PostUpdate, SitePost, Website } from '@prisma/client';
import { db } from '@/lib/db';
import { log } from '@/lib/log';
import { audit } from '@/lib/audit';
import { enqueue } from '@/lib/queue';
import { getSettings } from '@/lib/settings';
import { parseJson } from '@/lib/json';
import { stripTags, wordCount } from '@/lib/content/text';
import { sanitizeArticleHtml } from '@/lib/html/sanitize';
import { safeFetch } from '@/lib/links/net';
import { languageInstruction, languageName } from '@/lib/chatgpt/language';
import { createPostUpdateChatGPTRequest } from '@/lib/chatgpt/jobs';
import { loadPromptTemplate } from '@/lib/prompts/load';
import { renderTemplate } from '@/lib/prompts/template';
import { editablePost } from '@/lib/posts/editable';
import { siteRef, withWordPressSession } from './session';
import { WpClient, type WpPost } from './client';
import { contentHash, sameArticle } from './drafts';

/**
 * “Update to latest”, the WordPress side (owner request 2026-11-27): read the website's posts (also those the app did
 * not write), read one post fresh for an update and send it to ChatGPT, write an approved update to the same post,
 * and undo it. Reading never changes WordPress; writing happens only for an update the owner approved (lib/posts).
 */

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const LIVE_STATUSES = ['publish', 'future', 'private'];
/** At most this many posts per import (a very large site: import by category or age, in parts). */
export const IMPORT_MAX_POSTS = 5000;
/** The article given to ChatGPT in one prompt at most (characters). */
export const MAX_PROMPT_ARTICLE = 60_000;

const decode = (s: string) =>
  stripTags(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .trim();
const gmtDate = (s: string | null | undefined) => (s ? new Date(`${s.replace(/Z$/, '')}Z`) : null);
const editorOf = (raw: string) => (/<!--\s+wp:/.test(raw) ? 'GUTENBERG' : 'CLASSIC');
const wordsOf = (raw: string) => wordCount(stripTags(raw.replace(/<!--[\s\S]*?-->/g, ' ')));

function sitePostData(site: Pick<Website, 'id'>, p: WpPost, taskId: string | null, now: Date) {
  const raw = p.content.raw ?? p.content.rendered ?? '';
  return {
    websiteId: site.id,
    wpPostId: p.id,
    taskId,
    title: decode(p.title.raw ?? p.title.rendered),
    url: p.link,
    slug: p.slug || null,
    status: p.status,
    categoryIds: JSON.stringify(p.categories ?? []),
    contentRaw: raw,
    contentHash: sha(raw),
    editor: editorOf(raw),
    words: wordsOf(raw),
    publishedAt: gmtDate(p.date_gmt),
    modifiedAt: gmtDate(p.modified_gmt),
    importedAt: now,
  };
}

export interface ImportFilter {
  /** Only posts not updated for this many months (null: all). */
  olderThanMonths: number | null;
  /** Only posts in these WordPress categories (empty: all). */
  categoryIds: number[];
}

/** Read the website's published posts into the app (control job wp.import-posts). Nothing changes in WordPress. */
export async function importSitePosts(websiteId: string, filter: ImportFilter, now = new Date()): Promise<{ read: number; added: number; refreshed: number; linked: number; capped: boolean }> {
  const site = await db.website.findUniqueOrThrow({ where: { id: websiteId } });
  const before = filter.olderThanMonths ? new Date(now.getTime() - filter.olderThanMonths * 30.44 * 86_400_000) : null;
  const tasks = await db.articleTask.findMany({ where: { websiteId, wpPostId: { not: null } }, select: { id: true, wpPostId: true }, orderBy: { createdAt: 'asc' } });
  const taskOf = new Map(tasks.map((t) => [t.wpPostId!, t.id]));
  const result = await withWordPressSession(site, 'import posts', async (context) => {
    const client = await WpClient.connect(context, siteRef(site));
    let read = 0;
    let added = 0;
    let refreshed = 0;
    let linked = 0;
    let capped = false;
    for (let page = 1; ; page++) {
      const { posts, totalPages } = await client.listPublishedPosts({ page, perPage: 50, modifiedBefore: before, categories: filter.categoryIds });
      for (const p of posts) {
        // WordPress versions without modified_before: the age is checked here as well.
        const modified = gmtDate(p.modified_gmt);
        if (before && modified && modified > before) continue;
        if (read >= IMPORT_MAX_POSTS) {
          capped = true;
          break;
        }
        read++;
        const taskId = taskOf.get(p.id) ?? null;
        if (taskId) linked++;
        const data = sitePostData(site, p, taskId, now);
        const existing = await db.sitePost.findUnique({ where: { websiteId_wpPostId: { websiteId, wpPostId: p.id } }, select: { id: true } });
        if (existing) {
          await db.sitePost.update({ where: { id: existing.id }, data });
          refreshed++;
        } else {
          await db.sitePost.create({ data });
          added++;
        }
      }
      if (capped || page >= totalPages || !posts.length) break;
    }
    return { read, added, refreshed, linked, capped };
  });
  await log({ category: 'wordpress', message: `${site.name}: ${result.read} post(s) read for updates (${result.added} new, ${result.refreshed} read again, ${result.linked} written by the app)${result.capped ? `; stopped at ${IMPORT_MAX_POSTS}` : ''}.` });
  await audit('posts.import', 'Website', websiteId, { ...result, filter });
  return result;
}

/** The page's meta description and title as visitors see them (Rank Math or the theme writes them into the page). */
async function publicHead(site: Pick<Website, 'publicUrl'>, url: string): Promise<{ metaDescription: string | null }> {
  try {
    const res = await safeFetch(url, { trustedHosts: [new URL(site.publicUrl).hostname], timeoutMs: 20_000, maxBytes: 3_000_000 });
    if (res.status !== 200) return { metaDescription: null };
    const $ = load(res.body);
    const meta = $('meta[name="description"]').attr('content')?.trim() || $('meta[property="og:description"]').attr('content')?.trim() || null;
    return { metaDescription: meta ? decode(meta) : null };
  } catch {
    return { metaDescription: null };
  }
}

/**
 * A post the app did not write has no keyword the app knows (Rank Math's focus keyword is not shown to visitors): the
 * title's topic is used, without its year or a question mark (“Sarah Jones Net Worth 2024: …” → “Sarah Jones Net Worth”).
 */
export function keywordFromTitle(title: string): string {
  const topic = (title.split(/\s[:|–—-]\s|:\s/)[0] ?? title).replace(/\b(19|20)\d{2}\b/g, ' ').replace(/[?!.]+$/, '').replace(/\s+/g, ' ').trim();
  return topic || title;
}

const longDate = (d: Date | null, language: string) => (d ? d.toLocaleDateString(language === 'de' ? 'de-DE' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'unknown');

export async function failUpdate(id: string, message: string) {
  await db.postUpdate.update({ where: { id }, data: { status: 'FAILED', message: message.slice(0, 1000) } });
  await log({ level: 'warn', category: 'wordpress', message: `Post update ${id}: ${message}` });
}

/**
 * Start an update (control job wp.post-update-start): the post read fresh from WordPress, given to ChatGPT with the
 * POST_UPDATE prompt (Prompt Manager), and a wait for the answer (post-update queue).
 */
export async function startPostUpdate(updateId: string, now = new Date()): Promise<Record<string, unknown>> {
  const u = await db.postUpdate.findUnique({ where: { id: updateId }, include: { sitePost: true } });
  if (!u || u.status !== 'QUEUED') return { skipped: `update is ${u?.status ?? 'gone'}` };
  const site = await db.website.findUniqueOrThrow({ where: { id: u.websiteId } });
  const post = await withWordPressSession(site, `read post #${u.wpPostId}`, async (context) => (await WpClient.connect(context, siteRef(site))).getPost(u.wpPostId));
  if (!post || post.status === 'trash') {
    await failUpdate(u.id, `WordPress post #${u.wpPostId} no longer exists (or is in the trash).`);
    return { failed: 'gone' };
  }
  const raw = post.content.raw ?? '';
  const sp = await db.sitePost.update({ where: { id: u.sitePostId }, data: sitePostData(site, post, u.sitePost.taskId, now) });
  const head = post.status === 'publish' ? await publicHead(site, post.link) : { metaDescription: null };
  const editable = editablePost(raw);
  if (editable.editableWords < 80) {
    await failUpdate(u.id, `Almost no text the app can update: ${editable.editableWords} of ${editable.totalWords} words are in paragraphs, headings, lists or tables; the rest is in parts it keeps as they are (${[...new Set(editable.keeps.map((k) => k.what))].slice(0, 5).join(', ')}).`);
    return { failed: 'no text' };
  }
  if (editable.markdown.length > MAX_PROMPT_ARTICLE) {
    await failUpdate(u.id, `The post is too long for one ChatGPT prompt (${editable.markdown.length.toLocaleString('en')} characters; at most ${MAX_PROMPT_ARTICLE.toLocaleString('en')}).`);
    return { failed: 'too long' };
  }
  const task = sp.taskId ? await db.articleTask.findUnique({ where: { id: sp.taskId }, select: { focusKeyword: true, keyword: true } }) : null;
  const keyword = task?.focusKeyword ?? task?.keyword ?? sp.focusKeyword ?? keywordFromTitle(sp.title);
  const template = await loadPromptTemplate('shared', 'POST_UPDATE', site);
  const rendered = renderTemplate(template.content, {
    today: longDate(now, site.language),
    language: languageName(site.language),
    title: sp.title,
    focus_keyword: keyword,
    published_date: longDate(sp.publishedAt, site.language),
    modified_date: longDate(sp.modifiedAt, site.language),
    meta_description: head.metaDescription,
    article: editable.markdown,
  });
  const missing = rendered.missing.filter((name) => template.variables.find((v) => v.name === name)?.required !== false);
  if (missing.length) {
    await failUpdate(u.id, `The Update to latest prompt (Prompt Manager → Shared — Update a post) has unresolved required placeholders: ${missing.join(', ')}. Nothing was sent to ChatGPT.`);
    return { failed: 'prompt' };
  }
  const prompt = template.kind === 'text' ? `${rendered.text}\n\n${languageInstruction(site.language, site.targetCountry)}` : rendered.text;
  const settings = await getSettings();
  await createPostUpdateChatGPTRequest({ postUpdateId: u.id, websiteId: site.id, language: site.language, operationId: `post-update:${u.id}`, prompt, timeoutSec: settings.browser.generationTimeoutSec });
  await db.postUpdate.update({
    where: { id: u.id },
    data: {
      status: 'WRITING',
      message: 'ChatGPT checks the post against current sources and updates it.',
      baseRaw: raw,
      baseHash: sha(raw),
      baseTitle: sp.title,
      baseMeta: head.metaDescription,
      baseHtml: editable.html,
      result: JSON.stringify({ keyword, editor: editable.editor, editableWords: editable.editableWords, totalWords: editable.totalWords, keptParts: editable.keeps.length, postStatus: post.status }),
    },
  });
  await enqueue({ queue: 'post-update', kind: 'post-update.answer', idempotencyKey: `post-update:${u.id}`, websiteId: site.id, relatedId: u.id, payload: { updateId: u.id } });
  return { writing: true };
}

type ApplyOutcome = { kind: 'gone' } | { kind: 'conflict'; remote: string } | { kind: 'blocked'; status: string } | { kind: 'applied'; post: WpPost; already: boolean; metaWritten: boolean };

/** After the content changed: the app's own article for the post gets the new text too (the history keeps the old one). */
async function syncAppArticle(sp: SitePost, after: WpPost, reason: string) {
  if (!sp.taskId) return;
  const task = await db.articleTask.findUnique({ where: { id: sp.taskId } });
  if (!task) return;
  const raw = after.content.raw ?? '';
  const asm = await db.articleStage.findUnique({ where: { taskId_key: { taskId: task.id, key: 'ASSEMBLY' } } });
  await db.$transaction([
    ...(asm ? [db.articleStageRevision.create({ data: { stageId: asm.id, taskId: task.id, key: 'REFRESH', reason, outputHtml: task.editedHtml ?? task.assembledHtml ?? '' } })] : []),
    db.articleTask.update({ where: { id: task.id }, data: { editedHtml: sanitizeArticleHtml(raw.replace(/<!--[\s\S]*?-->/g, '')), editedAt: new Date(), wpContentHash: contentHash(raw), wpModifiedGmt: after.modified_gmt, selectedTitle: decode(after.title.raw ?? after.title.rendered) || task.selectedTitle, version: { increment: 1 } } }),
  ]);
}

/** Write an approved update to the same post (control job wp.post-update-apply): content, title, meta description. */
export async function applyPostUpdate(updateId: string): Promise<Record<string, unknown>> {
  const u = await db.postUpdate.findUnique({ where: { id: updateId }, include: { sitePost: true } });
  if (!u || !['APPROVED', 'APPLYING'].includes(u.status) || !u.proposedRaw || !u.baseRaw) return { skipped: `update is ${u?.status ?? 'gone'}` };
  const site = await db.website.findUniqueOrThrow({ where: { id: u.websiteId } });
  const settings = await getSettings();
  const overrides = parseJson<{ seo?: { rankMathMode?: string } }>(site.settingsOverrides, {});
  const rankMath = (overrides.seo?.rankMathMode ?? settings.seo.rankMathMode) !== 'off';
  await db.postUpdate.update({ where: { id: u.id }, data: { status: 'APPLYING', message: 'Writing the update to WordPress…' } });
  let outcome: ApplyOutcome;
  try {
    outcome = await withWordPressSession(site, `update post #${u.wpPostId}`, async (context): Promise<ApplyOutcome> => {
      const client = await WpClient.connect(context, siteRef(site));
      const post = await client.getPost(u.wpPostId);
      if (!post || post.status === 'trash') return { kind: 'gone' };
      const remote = post.content.raw ?? '';
      // A retry after a crash finds it written already.
      if (sameArticle(u.proposedRaw!, remote)) return { kind: 'applied', post, already: true, metaWritten: false };
      // Never over an edit made in WordPress after the update started.
      if (sha(remote) !== u.baseHash && !sameArticle(u.baseRaw!, remote)) return { kind: 'conflict', remote };
      if (LIVE_STATUSES.includes(post.status)) {
        const fresh = await db.website.findUniqueOrThrow({ where: { id: site.id }, select: { allowLiveUpdates: true } });
        if (!fresh.allowLiveUpdates) return { kind: 'blocked', status: post.status };
      }
      const title = u.proposedTitle && u.proposedTitle !== u.baseTitle ? u.proposedTitle : undefined;
      await client.updatePost(u.wpPostId, { content: u.proposedRaw!, ...(title ? { title } : {}) });
      let metaWritten = false;
      if (u.proposedMeta && u.proposedMeta !== u.baseMeta && rankMath && client.hasRankMath) {
        await client.rankMathUpdateMeta(u.wpPostId, { rank_math_description: u.proposedMeta });
        metaWritten = true;
      }
      const after = await client.getPost(u.wpPostId);
      return after ? { kind: 'applied', post: after, already: false, metaWritten } : { kind: 'gone' };
    });
  } catch (error) {
    const message = (error as Error).message.split('\n')[0];
    // Not written (or not provably): back to approved with the reason; it can be tried again.
    await db.postUpdate.update({ where: { id: u.id }, data: { status: 'APPROVED', message: `Not written yet: ${message}` } });
    throw error;
  }
  if (outcome.kind === 'gone') {
    await failUpdate(u.id, `WordPress post #${u.wpPostId} no longer exists (or is in the trash).`);
    return { status: 'FAILED' };
  }
  if (outcome.kind === 'conflict') {
    await db.postUpdate.update({ where: { id: u.id }, data: { status: 'CONFLICT', message: 'The post was edited in WordPress after this update started. Nothing was changed. Start a new update from the current post.' } });
    return { status: 'CONFLICT' };
  }
  if (outcome.kind === 'blocked') {
    await db.postUpdate.update({ where: { id: u.id }, data: { status: 'BLOCKED', message: `The post is live (“${outcome.status}”) and this website does not allow updates to live posts (website page → Publishing permission → Allow approved updates to live posts). Nothing was changed.` } });
    return { status: 'BLOCKED' };
  }
  const after = outcome.post;
  const raw = after.content.raw ?? '';
  const verified = sameArticle(u.proposedRaw, raw);
  await db.sitePost.update({ where: { id: u.sitePostId }, data: sitePostData(site, after, u.sitePost.taskId, new Date()) });
  await syncAppArticle(u.sitePost, after, `Update to latest ${u.id} applied to post #${u.wpPostId}`);
  const indexing = await requestIndexingAfterUpdate(u, site, after);
  await db.postUpdate.update({
    where: { id: u.id },
    data: {
      status: 'APPLIED',
      appliedAt: new Date(),
      appliedHash: sha(raw),
      message: verified ? 'Written to WordPress and read back.' : 'Written to WordPress; WordPress stores it slightly differently (normal for its own formatting).',
      result: JSON.stringify({ ...parseJson<Record<string, unknown>>(u.result, {}), verified, metaWritten: outcome.metaWritten, foundAlreadyApplied: outcome.already, link: after.link, indexing }),
    },
  });
  await audit('posts.update-apply', 'PostUpdate', u.id, { wpPostId: u.wpPostId, website: site.name, verified });
  await log({ category: 'wordpress', message: `${site.name}: post #${u.wpPostId} “${u.proposedTitle ?? u.baseTitle}” updated to the latest information (approved update ${u.id}).` });
  return { status: 'APPLIED', verified };
}

/** After an update of a published post: ask Google to crawl it again (the Search Console request, as for new posts). */
async function requestIndexingAfterUpdate(u: PostUpdate, site: Website, after: WpPost): Promise<string> {
  if (after.status !== 'publish') return 'Not requested: the post is not published.';
  try {
    const { requestProperty, queuePostIndexingRequest } = await import('@/lib/gsc/request-indexing');
    const property = await requestProperty(site.id).catch(() => '');
    if (!property) return 'Not requested: no Search Console property for this website.';
    await queuePostIndexingRequest({ postUpdateId: u.id, url: after.link, property, websiteId: site.id });
    return 'Indexing request queued for Search Console.';
  } catch (error) {
    return `Not requested: ${(error as Error).message.split('\n')[0]}`;
  }
}

/** Undo an applied update (control job wp.post-update-undo): only while the post is still as the update left it. */
export async function undoPostUpdate(updateId: string): Promise<Record<string, unknown>> {
  const u = await db.postUpdate.findUnique({ where: { id: updateId }, include: { sitePost: true } });
  if (!u || u.status !== 'APPLIED' || !u.baseRaw) return { skipped: `update is ${u?.status ?? 'gone'}` };
  const site = await db.website.findUniqueOrThrow({ where: { id: u.websiteId } });
  const outcome = await withWordPressSession(site, `undo update of post #${u.wpPostId}`, async (context) => {
    const client = await WpClient.connect(context, siteRef(site));
    const post = await client.getPost(u.wpPostId);
    if (!post || post.status === 'trash') return { kind: 'gone' as const };
    const remote = post.content.raw ?? '';
    if (sameArticle(u.baseRaw!, remote)) return { kind: 'undone' as const, post };
    if (u.appliedHash && sha(remote) !== u.appliedHash && !sameArticle(u.proposedRaw ?? '', remote)) return { kind: 'conflict' as const };
    await client.updatePost(u.wpPostId, { content: u.baseRaw!, ...(u.baseTitle && u.baseTitle !== u.proposedTitle ? { title: u.baseTitle } : {}) });
    const result = parseJson<{ metaWritten?: boolean }>(u.result, {});
    if (result.metaWritten && u.baseMeta && client.hasRankMath) await client.rankMathUpdateMeta(u.wpPostId, { rank_math_description: u.baseMeta });
    const after = await client.getPost(u.wpPostId);
    return after ? { kind: 'undone' as const, post: after } : { kind: 'gone' as const };
  });
  if (outcome.kind === 'gone') return { status: 'GONE' };
  if (outcome.kind === 'conflict') {
    await db.postUpdate.update({ where: { id: u.id }, data: { message: 'Not undone: the post was edited in WordPress after the update. Nothing was changed.' } });
    return { status: 'CONFLICT' };
  }
  await db.sitePost.update({ where: { id: u.sitePostId }, data: sitePostData(site, outcome.post, u.sitePost.taskId, new Date()) });
  await syncAppArticle(u.sitePost, outcome.post, `Update to latest ${u.id} undone on post #${u.wpPostId}`);
  await db.postUpdate.update({ where: { id: u.id }, data: { status: 'UNDONE', undoneAt: new Date(), message: 'Undone: the post has its text and title from before the update again.' } });
  await audit('posts.update-undo', 'PostUpdate', u.id, { wpPostId: u.wpPostId, website: site.name });
  return { status: 'UNDONE' };
}
