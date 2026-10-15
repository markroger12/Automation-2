import { db } from '@/lib/db';
import { audit } from '@/lib/audit';
import { log } from '@/lib/log';
import { getSettings } from '@/lib/settings';
import { LoginRequiredError } from '@/lib/pipeline-errors';
import { sanitizeArticleHtml } from '@/lib/html/sanitize';
import { refreshArticleHtml, refreshHash } from '@/lib/refresh/service';
import { withSiteContext, withWordPressSlot } from './browser';
import { WpClient, type WpPost } from './client';
import { contentHash, editorContent, sameArticle, type EditorKind } from './drafts';
import { siteRef } from './session';

/**
 * Writes an APPROVED ContentRevision to the SAME WordPress post (control
 * queue job `wp.refresh-apply`). Only the content field is sent: status,
 * date, slug and therefore the URL stay as they are, and the read-back
 * confirms it. Edits made in WordPress since the app's last save are never
 * overwritten (CONFLICT). Live posts need the site's live-update switch
 * (checked again here). The local article changes only after WordPress
 * confirmed the update; a retry after a crash finds the content already
 * there and just records it.
 */

const LIVE = ['publish', 'future', 'private'];

type Outcome =
  | { kind: 'gone' }
  | { kind: 'blocked'; status: string }
  | { kind: 'conflict'; remote: string; post: WpPost }
  | { kind: 'applied'; post: WpPost; before: Pick<WpPost, 'status' | 'date_gmt' | 'slug' | 'link'>; already: boolean };

function editorOf(site: { editorType: string; detectedEditor: string | null }): EditorKind {
  if (site.editorType === 'CLASSIC' || site.editorType === 'GUTENBERG') return site.editorType;
  return site.detectedEditor === 'CLASSIC' ? 'CLASSIC' : 'GUTENBERG';
}

export async function applyContentRevision(revisionId: string): Promise<Record<string, unknown>> {
  const r = await db.contentRevision.findUnique({ where: { id: revisionId } });
  if (!r) return { skipped: 'revision not found' };
  if (r.status === 'APPLIED') return { skipped: 'already applied' };
  if (r.status !== 'APPROVED' && r.status !== 'APPLYING') return { skipped: `revision is ${r.status.toLowerCase()}` };
  const task = await db.articleTask.findUniqueOrThrow({ where: { id: r.taskId } });
  const site = await db.website.findUniqueOrThrow({ where: { id: r.websiteId } });
  const finish = async (status: string, result: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    await db.contentRevision.update({ where: { id: r.id }, data: { status, result: JSON.stringify(result), ...extra } });
    return { status, ...result };
  };
  if (!task.wpPostId) return finish('FAILED', { error: 'The article has no WordPress post.' });
  // Applied for the first time? The app's own text must still be the one the revision was made from.
  if (r.status === 'APPROVED' && refreshHash(refreshArticleHtml(task)) !== r.baseHash) {
    return finish('CONFLICT', { error: 'The article was edited in the app after this revision was approved. Propose a new revision from the current text.' });
  }
  const profile = site.wordpressProfileId ? await db.browserProfile.findUnique({ where: { id: site.wordpressProfileId } }) : null;
  if (!profile || profile.sessionState === 'LOGIN_REQUIRED') {
    await db.contentRevision.update({ where: { id: r.id }, data: { result: JSON.stringify({ waiting: 'Log in to WordPress (website page → Log in); the update runs again after that.' }) } });
    throw new LoginRequiredError('wordpress', `${site.name}: not logged in to WordPress.`, site.id);
  }
  await db.contentRevision.update({ where: { id: r.id }, data: { status: 'APPLYING' } });
  const editor = editorOf(site);
  const sent = editorContent(r.proposedHtml, editor);
  const base = editorContent(r.baseHtml, editor);
  const postId = task.wpPostId;
  const settings = await getSettings();
  let outcome: Outcome;
  try {
    outcome = await withWordPressSlot(settings.workflow.wordpressConcurrency, () =>
    withSiteContext(siteRef(site), { headed: settings.browser.mode === 'headed', purpose: `refresh post #${postId}` }, async (context): Promise<Outcome> => {
      const client = await WpClient.connect(context, siteRef(site), { taskId: task.id });
      const post = await client.getPost(postId);
      if (!post || post.status === 'trash') return { kind: 'gone' };
      const remote = post.content.raw ?? '';
      const before = { status: post.status, date_gmt: post.date_gmt, slug: post.slug, link: post.link };
      if (sameArticle(sent, remote)) return { kind: 'applied', post, before, already: true };
      // Manual WordPress edits since the app's last save are never overwritten.
      if (!sameArticle(base, remote) && (!task.wpContentHash || contentHash(remote) !== task.wpContentHash)) return { kind: 'conflict', remote, post };
      if (LIVE.includes(post.status)) {
        const fresh = await db.website.findUniqueOrThrow({ where: { id: site.id }, select: { allowLiveUpdates: true } });
        if (!fresh.allowLiveUpdates) return { kind: 'blocked', status: post.status };
      } else if (post.status !== 'draft') return { kind: 'blocked', status: post.status };
      await client.updatePost(postId, { content: sent });
      const after = await client.getPost(postId);
      if (!after) return { kind: 'gone' };
      return { kind: 'applied', post: after, before, already: false };
    }),
    );
  } catch (error) {
    // Not applied (or not provably): back to approved with the reason; the job retries, and the owner can try again or reject.
    const message = (error as Error).message;
    await db.contentRevision.update({ where: { id: r.id }, data: { status: 'APPROVED', result: JSON.stringify(error instanceof LoginRequiredError ? { waiting: `Log in to WordPress (website page → Log in): ${message}` } : { error: `The update did not run: ${message}`, failedAt: new Date().toISOString() }) } });
    throw error;
  }

  if (outcome.kind === 'gone') return finish('FAILED', { error: `WordPress post #${postId} no longer exists (or is in the trash).` });
  if (outcome.kind === 'blocked') {
    return finish('BLOCKED', { error: LIVE.includes(outcome.status) ? `Post #${postId} is live (“${outcome.status}”) and this site does not allow updates to live posts.` : `Post #${postId} is “${outcome.status}”; only drafts (or live posts with permission) are updated.` });
  }
  if (outcome.kind === 'conflict') {
    await log({ level: 'warn', category: 'refresh', taskId: task.id, message: `Refresh of post #${postId} stopped: the post was edited in WordPress after the app saved it.` });
    return finish('CONFLICT', { error: 'The post was edited in WordPress after the app saved it. Nothing was changed. Use “Start from the WordPress version” to refresh the edited text instead.', modifiedGmt: outcome.post.modified_gmt }, { remoteSnapshot: outcome.remote.slice(0, 400_000) });
  }
  const after = outcome.post;
  const unchanged = after.status === outcome.before.status && after.date_gmt === outcome.before.date_gmt && after.slug === outcome.before.slug;
  const verified = sameArticle(sent, after.content.raw ?? '');
  if (!unchanged) {
    await db.recoveryIncident.upsert({
      where: { dedupeKey: `refresh-state:${r.id}` },
      update: {},
      create: { kind: 'STALLED', severity: 'critical', taskId: task.id, description: `After the content refresh, post #${postId} changed state (${outcome.before.status} → ${after.status}, ${outcome.before.date_gmt} → ${after.date_gmt}). Check it in WordPress.`, evidence: JSON.stringify({ before: outcome.before, after: { status: after.status, date_gmt: after.date_gmt, slug: after.slug } }), dedupeKey: `refresh-state:${r.id}` },
    });
  }
  const asm = await db.articleStage.findUnique({ where: { taskId_key: { taskId: task.id, key: 'ASSEMBLY' } } });
  await db.$transaction([
    ...(asm ? [db.articleStageRevision.create({ data: { stageId: asm.id, taskId: task.id, key: 'REFRESH', reason: `content refresh ${r.id} applied to post #${postId}`, outputHtml: refreshArticleHtml(task) } })] : []),
    db.articleTask.update({ where: { id: task.id }, data: { editedHtml: sanitizeArticleHtml(r.proposedHtml), editedAt: new Date(), wpContentHash: contentHash(after.content.raw ?? sent), wpModifiedGmt: after.modified_gmt, version: { increment: 1 } } }),
    db.contentRevision.update({ where: { id: r.id }, data: { status: 'APPLIED', appliedAt: new Date(), result: JSON.stringify({ verified, stateUnchanged: unchanged, before: outcome.before, after: { status: after.status, date_gmt: after.date_gmt, slug: after.slug, link: after.link }, foundAlreadyApplied: outcome.already }) } }),
    ...(r.candidateId ? [db.refreshCandidate.update({ where: { id: r.candidateId }, data: { status: 'APPLIED' } })] : []),
  ]);
  await audit('refresh.apply', 'ContentRevision', r.id, { wpPostId: postId, status: after.status, verified, stateUnchanged: unchanged, kind: r.kind });
  return { status: 'APPLIED', verified, stateUnchanged: unchanged, postStatus: after.status };
}

/**
 * After a CONFLICT: the owner chooses to continue from the text that is in
 * WordPress now. It becomes the article's text in the app (the previous app
 * text stays in the history) and a new proposal starts from it.
 */
export async function adoptWordPressVersion(revisionId: string) {
  const r = await db.contentRevision.findUnique({ where: { id: revisionId } });
  if (!r || r.status !== 'CONFLICT' || !r.remoteSnapshot) return null;
  const task = await db.articleTask.findUniqueOrThrow({ where: { id: r.taskId } });
  const html = sanitizeArticleHtml(r.remoteSnapshot.replace(/<!--[\s\S]*?-->/g, ''));
  const asm = await db.articleStage.findUnique({ where: { taskId_key: { taskId: task.id, key: 'ASSEMBLY' } } });
  await db.$transaction([
    ...(asm ? [db.articleStageRevision.create({ data: { stageId: asm.id, taskId: task.id, key: 'EDITOR', reason: `app text before adopting the WordPress version (refresh ${r.id})`, outputHtml: refreshArticleHtml(task) } })] : []),
    db.articleTask.update({ where: { id: task.id }, data: { editedHtml: html, editedAt: new Date(), wpContentHash: contentHash(r.remoteSnapshot), version: { increment: 1 } } }),
    db.contentRevision.update({ where: { id: r.id }, data: { status: 'REJECTED', note: 'Replaced: continued from the WordPress version.' } }),
  ]);
  await audit('refresh.adopt-wordpress', 'ArticleTask', task.id, { revisionId: r.id });
  return { taskId: task.id, candidateId: r.candidateId };
}
