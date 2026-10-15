import { db } from '@/lib/db';
import { audit } from '@/lib/audit';
import { log } from '@/lib/log';
import { getSettings } from '@/lib/settings';
import { LoginRequiredError } from '@/lib/pipeline-errors';
import { moveToNextSlot, SCHEDULE_LEAD_MS } from '@/lib/workflow/scheduler';
import { withSiteContext, withWordPressSlot } from './browser';
import { WpClient, type WpPost } from './client';
import { withPublishPermit } from './publish-guard';
import { siteRef } from './session';

/**
 * The approved publishing path (spec §14), run by the worker's control queue
 * for READY workflow keywords. It changes ONE thing: the verified draft of
 * the keyword's article becomes a scheduled (“future”) post at its reserved
 * slot — only when the website allows publishing (canPublish + typed
 * acknowledgement), only inside withPublishPermit for that post, and the
 * result is read back and verified. It never publishes immediately.
 */

async function siteClient<T>(websiteId: string, purpose: string, fn: (client: WpClient) => Promise<T>): Promise<T> {
  const site = await db.website.findUniqueOrThrow({ where: { id: websiteId } });
  const profile = site.wordpressProfileId ? await db.browserProfile.findUnique({ where: { id: site.wordpressProfileId } }) : null;
  if (!profile || profile.sessionState === 'LOGIN_REQUIRED') throw new LoginRequiredError('wordpress', `${site.name}: not logged in to WordPress.`, site.id);
  const settings = await getSettings();
  return withWordPressSlot(settings.workflow.wordpressConcurrency, () =>
    withSiteContext(siteRef(site), { headed: settings.browser.mode === 'headed', purpose }, async (context) => fn(await WpClient.connect(context, siteRef(site)))),
  );
}

type Outcome = { kind: 'error'; error: string } | { kind: 'published'; post: WpPost } | { kind: 'scheduled'; post: WpPost };

const sameMinute = (a: string | null | undefined, b: Date) => Boolean(a) && Math.abs(Date.parse(`${a!.replace(/Z$/, '')}Z`) - b.getTime()) < 60_000;

export async function scheduleKeywordPost(keywordId: string): Promise<Record<string, unknown>> {
  const kw = await db.workflowKeyword.findUnique({ where: { id: keywordId }, include: { workflow: { include: { website: true } } } });
  if (!kw) return { skipped: 'keyword not found' };
  if (kw.status !== 'READY' || !kw.scheduledAt || !kw.taskId) return { skipped: `keyword is ${kw.status}` };
  const wf = kw.workflow;
  if (!wf.website.canPublish || !wf.website.canPublishAcknowledgedAt) {
    await db.workflowKeyword.update({ where: { id: kw.id }, data: { lastError: 'Publishing is off for this website, so the draft waits.' } });
    return { skipped: 'publishing not allowed' };
  }
  const now = new Date();
  if (kw.scheduledAt.getTime() - now.getTime() < SCHEDULE_LEAD_MS / 2) {
    await moveToNextSlot(wf, kw, now, 'The slot was too close to schedule safely.');
    return { moved: true };
  }
  const task = await db.articleTask.findUniqueOrThrow({ where: { id: kw.taskId } });
  if (task.status !== 'COMPLETED' || !task.wpPostId) return { skipped: 'article is not a verified draft' };
  const postId = task.wpPostId;
  const at = kw.scheduledAt;
  const result = await siteClient(wf.websiteId, `schedule post #${postId}`, async (client): Promise<Outcome> => {
    const before = await client.getPost(postId);
    if (!before) return { kind: 'error', error: `WordPress post #${postId} no longer exists.` };
    if (before.status === 'publish') return { kind: 'published', post: before };
    if (before.status === 'future' && sameMinute(before.date_gmt, at)) return { kind: 'scheduled', post: before };
    if (before.status !== 'draft' && before.status !== 'future') return { kind: 'error', error: `WordPress post #${postId} is “${before.status}”, not a draft; it was left alone.` };
    await withPublishPermit(wf.websiteId, postId, `workflow slot ${at.toISOString()} for “${kw.keyword}”`, () => client.scheduleFuture(postId, at));
    const after = await client.getPost(postId);
    if (after?.status === 'future' && sameMinute(after.date_gmt, at)) return { kind: 'scheduled', post: after };
    if (after?.status === 'publish') return { kind: 'published', post: after };
    return { kind: 'error', error: `WordPress did not confirm the schedule (status “${after?.status ?? 'missing'}”, date ${after?.date_gmt ?? '—'}).` };
  });
  if (result.kind === 'error') {
    await db.workflowKeyword.update({ where: { id: kw.id }, data: { lastError: result.error } });
    throw new Error(result.error);
  }
  if (result.kind === 'published') {
    await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'PUBLISHED', publishedUrl: result.post.link, publishedAt: result.post.date_gmt ? new Date(`${result.post.date_gmt}Z`) : now, lastError: null } });
    return { published: true };
  }
  await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'SCHEDULED', lastError: null } });
  await audit('workflow.scheduled', 'WorkflowKeyword', kw.id, { postId, at: at.toISOString(), website: wf.website.name });
  await log({ category: 'workflow', taskId: kw.taskId, message: `“${kw.keyword}” scheduled for ${at.toISOString()} (post #${postId}, verified in WordPress).` });
  return { scheduled: true, postId, at: at.toISOString() };
}

/** After the slot: confirm WordPress actually published the post (status read back; nothing is changed). */
export async function verifyKeywordPublished(keywordId: string): Promise<Record<string, unknown>> {
  const kw = await db.workflowKeyword.findUnique({ where: { id: keywordId }, include: { workflow: true } });
  if (!kw || kw.status !== 'SCHEDULED' || !kw.taskId) return { skipped: 'not scheduled' };
  const task = await db.articleTask.findUniqueOrThrow({ where: { id: kw.taskId } });
  if (!task.wpPostId) return { skipped: 'no post' };
  const post = await siteClient(kw.workflow.websiteId, `verify post #${task.wpPostId}`, (client) => client.getPost(task.wpPostId!));
  if (post?.status === 'publish') {
    await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'PUBLISHED', publishedUrl: post.link, publishedAt: post.date_gmt ? new Date(`${post.date_gmt}Z`) : new Date(), lastError: null } });
    return { published: true, url: post.link };
  }
  if (post?.status === 'future') {
    const overdue = kw.scheduledAt && Date.now() - kw.scheduledAt.getTime() > 24 * 3_600_000;
    const message = overdue
      ? 'WordPress has not published this post 24 hours after its slot. WP-Cron may not be running on this website; it is still checked every 30 minutes.'
      : 'WordPress still shows “future” after the slot (WP-Cron may be delayed; it is checked again).';
    await db.workflowKeyword.update({ where: { id: kw.id }, data: { lastError: message } });
    return { published: false, status: post.status };
  }
  if (post?.status === 'draft') {
    // Unscheduled in WordPress: back to READY; the scheduler moves it to the next free slot.
    await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'READY', lastError: 'The post is a draft again in WordPress; it will be scheduled for the next free slot.' } });
    return { published: false, status: 'draft' };
  }
  // Deleted, trashed or set to another status outside the tool: left alone, no more checks.
  const message = post ? `The post was changed to “${post.status}” in WordPress; it was left alone. Restore it as a draft in WordPress and use retry to schedule it again.` : 'The WordPress post no longer exists.';
  await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'FAILED', lastError: message } });
  return { published: false, status: post?.status ?? 'missing' };
}
