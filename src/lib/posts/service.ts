import { db } from '@/lib/db';
import { AppError, badRequest, notFound } from '@/lib/errors';
import { audit } from '@/lib/audit';
import { enqueue } from '@/lib/queue';
import { parseJson } from '@/lib/json';
import { getSettings } from '@/lib/settings';
import { LIVE_ACK_PHRASE } from '@/lib/refresh/service';
import { compareVersions } from '@/wordpress/compare';
import { sameArticle } from '@/wordpress/drafts';
import { failUpdate, LIVE_STATUSES, type ImportFilter } from '@/wordpress/post-updates';
import { parseUpdateAnswer } from './answer';
import { blockingFailures, checkUpdate, type UpdateCheck } from './checks';
import { editablePost, markUse, rebuildPost } from './editable';

/**
 * “Update to latest” (owner request 2026-11-27: “old articles ko latest per update … jin articles ka data tool per
 * nahi ha vo bhi update kre data collect krke website sa”): the website's posts read into the app, each updated by
 * ChatGPT on request, checked, compared, and written to the same WordPress post only after the owner approves it.
 */

const ACTIVE = ['QUEUED', 'WRITING', 'READY', 'APPROVED', 'APPLYING'];

export async function requestImport(websiteId: string, filter: ImportFilter) {
  const site = await db.website.findUnique({ where: { id: websiteId }, select: { id: true, name: true } });
  if (!site) throw notFound('Website');
  const running = await db.queueJob.findFirst({ where: { kind: 'wp.import-posts', websiteId, status: { in: ['WAITING', 'ACTIVE'] } } });
  if (running) return { jobId: running.id, queued: false };
  const { job } = await enqueue({ queue: 'control', kind: 'wp.import-posts', idempotencyKey: `wp-import-posts:${websiteId}:${Date.now()}`, websiteId, relatedId: websiteId, payload: { websiteId, filter } });
  await audit('posts.import-request', 'Website', websiteId, { filter });
  return { jobId: job.id, queued: true };
}

export interface PostListFilter {
  websiteId: string;
  q?: string | null;
  /** Only posts not changed for this many months. */
  olderThanMonths?: number | null;
  page?: number;
  pageSize?: number;
}

export async function listSitePosts(f: PostListFilter) {
  const pageSize = Math.min(100, Math.max(10, f.pageSize ?? 25));
  const page = Math.max(1, f.page ?? 1);
  const where = {
    websiteId: f.websiteId,
    ...(f.q?.trim() ? { title: { contains: f.q.trim() } } : {}),
    ...(f.olderThanMonths ? { modifiedAt: { lt: new Date(Date.now() - f.olderThanMonths * 30.44 * 86_400_000) } } : {}),
  };
  const [total, rows, importJob] = await Promise.all([
    db.sitePost.count({ where }),
    db.sitePost.findMany({
      where,
      orderBy: [{ modifiedAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, wpPostId: true, taskId: true, title: true, url: true, status: true, words: true, publishedAt: true, modifiedAt: true, importedAt: true, updates: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, createdAt: true, appliedAt: true } } },
    }),
    db.queueJob.findFirst({ where: { kind: 'wp.import-posts', websiteId: f.websiteId }, orderBy: { createdAt: 'desc' }, select: { status: true, error: true, result: true, finishedAt: true, createdAt: true } }),
  ]);
  return {
    total,
    page,
    pageSize,
    posts: rows.map(({ updates, ...r }) => ({ ...r, lastUpdate: updates[0] ?? null })),
    lastImport: importJob ? { status: importJob.status, error: importJob.error, result: parseJson<Record<string, unknown>>(importJob.result, {}), at: (importJob.finishedAt ?? importJob.createdAt).toISOString() } : null,
  };
}

/** “Update to latest” for posts (each its own update; one at a time per post). */
export async function startUpdates(sitePostIds: string[]) {
  const ids = [...new Set(sitePostIds)].slice(0, 50);
  if (!ids.length) throw badRequest('Choose at least one post.');
  const started: string[] = [];
  const already: string[] = [];
  for (const id of ids) {
    const sp = await db.sitePost.findUnique({ where: { id }, select: { id: true, websiteId: true, wpPostId: true } });
    if (!sp) continue;
    const open = await db.postUpdate.findFirst({ where: { sitePostId: id, status: { in: ACTIVE } }, select: { id: true } });
    if (open) {
      already.push(open.id);
      continue;
    }
    const u = await db.postUpdate.create({ data: { sitePostId: id, websiteId: sp.websiteId, wpPostId: sp.wpPostId, status: 'QUEUED', message: 'Waiting to read the post from WordPress.' } });
    await enqueue({ queue: 'control', kind: 'wp.post-update-start', idempotencyKey: `wp-post-update-start:${u.id}`, websiteId: sp.websiteId, relatedId: u.id, payload: { updateId: u.id } });
    await audit('posts.update-start', 'PostUpdate', u.id, { sitePostId: id, wpPostId: sp.wpPostId });
    started.push(u.id);
  }
  return { started, already };
}

/**
 * ChatGPT's answer (post-update queue): parsed, rebuilt as post content with every kept part back, checked. Ready
 * for the owner, nothing to change, or stopped by a check (shown with the reason).
 */
export async function processPostUpdate(id: string): Promise<{ state: 'waiting' | 'done'; message: string }> {
  const u = await db.postUpdate.findUnique({ where: { id } });
  if (!u || u.status !== 'WRITING' || !u.baseRaw) return { state: 'done', message: `update is ${u?.status ?? 'gone'}` };
  const res = await db.chatGPTResponse.findFirst({ where: { postUpdateId: id }, orderBy: { createdAt: 'desc' } });
  if (!res) {
    await failUpdate(id, 'The ChatGPT request for this update is missing. Try again.');
    return { state: 'done', message: 'no request' };
  }
  if (res.status === 'FAILED') {
    await failUpdate(id, `ChatGPT did not answer: ${res.error ?? 'unknown reason'}. Try again.`);
    return { state: 'done', message: 'ChatGPT failed' };
  }
  if (res.status !== 'COMPLETED' || !res.resultText) return { state: 'waiting', message: 'Waiting for ChatGPT' };
  const answer = parseUpdateAnswer(res.resultText);
  if ('error' in answer) {
    await db.postUpdate.update({ where: { id }, data: { conversationUrl: res.conversationUrl } });
    await failUpdate(id, `${answer.error} Try again.`);
    return { state: 'done', message: answer.error };
  }
  const settings = await getSettings();
  const site = await db.website.findUniqueOrThrow({ where: { id: u.websiteId }, select: { language: true } });
  const base = editablePost(u.baseRaw);
  const marks = markUse(answer.article, base.keeps);
  const rebuilt = rebuildPost(answer.article, base);
  const title = answer.title?.trim() || u.baseTitle || '';
  const result = parseJson<{ keyword?: string }>(u.result, {});
  const checks: UpdateCheck[] = checkUpdate({
    beforeHtml: u.baseHtml ?? base.html,
    afterHtml: rebuilt.html,
    marks,
    keyword: result.keyword ?? u.baseTitle ?? '',
    language: site.language,
    densityCeilingPct: settings.content.keywordDensityCeilingPct,
    titleBefore: u.baseTitle ?? '',
    titleAfter: title,
    metaDescription: answer.metaDescription,
    changes: answer.noChanges ? [] : answer.changes,
    sources: answer.sources,
  });
  const comparison = compareVersions(rebuilt.html, u.baseHtml ?? base.html);
  const unchanged = (sameArticle(rebuilt.raw, u.baseRaw) || (!comparison.onlyInApp.length && !comparison.onlyInWordPress.length)) && title === (u.baseTitle ?? '');
  const blocking = blockingFailures(checks);
  const status = unchanged ? 'NO_CHANGE' : blocking.length ? 'FAILED' : 'READY';
  const message =
    status === 'NO_CHANGE'
      ? 'ChatGPT found nothing outdated: the post stays as it is.'
      : status === 'FAILED'
        ? `Stopped by the app's checks: ${blocking.map((c) => `${c.label} (${c.detail})`).join(' · ')}. Nothing was changed; try again.`
        : 'Ready: compare the versions and approve, or reject.';
  await db.postUpdate.update({
    where: { id },
    data: {
      status,
      message,
      proposedRaw: rebuilt.raw,
      proposedHtml: rebuilt.html,
      proposedTitle: title,
      proposedMeta: answer.metaDescription,
      changes: JSON.stringify(answer.changes.map((text) => ({ text }))),
      sources: JSON.stringify(answer.sources),
      checks: JSON.stringify(checks),
      conversationUrl: res.conversationUrl,
    },
  });
  return { state: 'done', message };
}

export async function getPostUpdate(id: string) {
  const u = await db.postUpdate.findUnique({ where: { id }, include: { sitePost: { select: { id: true, title: true, url: true, status: true, wpPostId: true, taskId: true, publishedAt: true, modifiedAt: true } } } });
  if (!u) throw notFound('Post update');
  const site = await db.website.findUniqueOrThrow({ where: { id: u.websiteId }, select: { id: true, name: true, adminUrl: true, allowLiveUpdates: true } });
  const history = await db.postUpdate.findMany({ where: { sitePostId: u.sitePostId }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, status: true, createdAt: true, appliedAt: true } });
  return {
    id: u.id,
    status: u.status,
    message: u.message,
    wpPostId: u.wpPostId,
    post: { ...u.sitePost, live: LIVE_STATUSES.includes(u.sitePost.status), editUrl: `${site.adminUrl.replace(/\/?$/, '/')}post.php?post=${u.wpPostId}&action=edit` },
    website: site,
    baseTitle: u.baseTitle,
    proposedTitle: u.proposedTitle,
    baseMeta: u.baseMeta,
    proposedMeta: u.proposedMeta,
    baseHtml: u.baseHtml,
    proposedHtml: u.proposedHtml,
    comparison: u.baseHtml && u.proposedHtml ? compareVersions(u.proposedHtml, u.baseHtml, 200) : null,
    changes: parseJson<{ text: string }[]>(u.changes, []),
    sources: parseJson<{ url: string; note: string }[]>(u.sources, []),
    checks: parseJson<UpdateCheck[]>(u.checks, []),
    result: parseJson<Record<string, unknown>>(u.result, {}),
    conversationUrl: u.conversationUrl,
    createdAt: u.createdAt.toISOString(),
    approvedAt: u.approvedAt?.toISOString() ?? null,
    appliedAt: u.appliedAt?.toISOString() ?? null,
    undoneAt: u.undoneAt?.toISOString() ?? null,
    history: history.map((h) => ({ ...h, createdAt: h.createdAt.toISOString(), appliedAt: h.appliedAt?.toISOString() ?? null })),
    liveAckPhrase: LIVE_ACK_PHRASE,
  };
}

/** The owner approves: the worker writes it to the same post. A live post needs the website's switch and the typed words. */
export async function approvePostUpdate(id: string, acknowledgement?: string | null) {
  const u = await db.postUpdate.findUnique({ where: { id }, include: { sitePost: { select: { status: true } } } });
  if (!u) throw notFound('Post update');
  // An approved update whose write did not go through (a sign-in, a network error) can be sent again.
  const again = u.status === 'APPROVED' && !(await db.queueJob.count({ where: { kind: 'wp.post-update-apply', relatedId: id, status: { in: ['WAITING', 'ACTIVE'] } } }));
  if (u.status !== 'READY' && !again) throw new AppError(409, 'CONFLICT', `Only a ready update can be approved (this one is ${u.status.toLowerCase().replace('_', ' ')}).`);
  if (blockingFailures(parseJson<UpdateCheck[]>(u.checks, [])).length) throw new AppError(409, 'CONFLICT', 'This update did not pass the app’s checks.');
  if (LIVE_STATUSES.includes(u.sitePost.status)) {
    const site = await db.website.findUniqueOrThrow({ where: { id: u.websiteId }, select: { allowLiveUpdates: true, name: true } });
    if (!site.allowLiveUpdates) throw new AppError(409, 'LIVE_UPDATES_OFF', `The post is live, and ${site.name} does not allow updates to live posts. Turn on “Allow approved updates to live posts” on the website's page (Publishing permission) first.`);
    if ((acknowledgement ?? '').trim() !== LIVE_ACK_PHRASE) throw badRequest(`Type ${LIVE_ACK_PHRASE} to update a live post.`);
  }
  await db.postUpdate.update({ where: { id }, data: { status: 'APPROVED', approvedAt: new Date(), message: 'Approved: waiting for the worker to write it to WordPress.' } });
  await enqueue({ queue: 'control', kind: 'wp.post-update-apply', idempotencyKey: `wp-post-update-apply:${id}:${Date.now()}`, websiteId: u.websiteId, relatedId: id, payload: { updateId: id } });
  await audit('posts.update-approve', 'PostUpdate', id, { wpPostId: u.wpPostId, live: LIVE_STATUSES.includes(u.sitePost.status) });
  return { ok: true };
}

export async function rejectPostUpdate(id: string) {
  const u = await db.postUpdate.findUnique({ where: { id } });
  if (!u) throw notFound('Post update');
  if (!['READY', 'NO_CHANGE', 'FAILED', 'CONFLICT', 'BLOCKED', 'APPROVED'].includes(u.status)) throw new AppError(409, 'CONFLICT', `This update is ${u.status.toLowerCase()}; it cannot be rejected now.`);
  await db.postUpdate.update({ where: { id }, data: { status: 'REJECTED', message: 'Rejected: nothing was changed in WordPress.' } });
  await db.queueJob.updateMany({ where: { kind: 'wp.post-update-apply', relatedId: id, status: 'WAITING' }, data: { status: 'CANCELLED', finishedAt: new Date() } });
  await audit('posts.update-reject', 'PostUpdate', id, {});
  return { ok: true };
}

export async function requestUndo(id: string) {
  const u = await db.postUpdate.findUnique({ where: { id } });
  if (!u) throw notFound('Post update');
  if (u.status !== 'APPLIED') throw new AppError(409, 'CONFLICT', 'Only an applied update can be undone.');
  await enqueue({ queue: 'control', kind: 'wp.post-update-undo', idempotencyKey: `wp-post-update-undo:${id}:${Date.now()}`, websiteId: u.websiteId, relatedId: id, payload: { updateId: id } });
  await db.postUpdate.update({ where: { id }, data: { message: 'Undo requested: the worker restores the post as it was before the update.' } });
  await audit('posts.update-undo-request', 'PostUpdate', id, {});
  return { ok: true };
}
