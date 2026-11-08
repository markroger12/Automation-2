import { db } from '@/lib/db';
import { audit } from '@/lib/audit';
import { log } from '@/lib/log';
import { getSettings } from '@/lib/settings';
import { LoginRequiredError } from '@/lib/pipeline-errors';
import { MISSED_SCHEDULE_GRACE_MS, moveToNextSlot, SCHEDULE_LEAD_MS } from '@/lib/workflow/scheduler';
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

/**
 * The keyword as WordPress published it. Published at another time than its slot (owner report: the owner published
 * the draft in WordPress the day before its slot): the calendar shows it when it was really published, and its
 * reserved slot is free again for another article.
 */
async function markPublished(kw: { id: string; keyword: string; taskId: string | null; scheduledAt: Date | null }, post: WpPost, fallback: Date) {
  const at = post.date_gmt ? new Date(`${post.date_gmt}Z`) : fallback;
  const offSlot = !kw.scheduledAt || Math.abs(at.getTime() - kw.scheduledAt.getTime()) >= 60_000;
  if (offSlot) await db.slotReservation.deleteMany({ where: { workflowKeywordId: kw.id } });
  await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'PUBLISHED', publishedUrl: post.link, publishedAt: at, lastError: null, ...(offSlot ? { scheduledAt: at } : {}) } });
  if (offSlot && kw.scheduledAt) await log({ category: 'workflow', taskId: kw.taskId, message: `“${kw.keyword}” was published in WordPress at ${at.toISOString()}, not at its slot ${kw.scheduledAt.toISOString()}: the calendar shows the real time and the slot is free again.` });
}

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
    await markPublished(kw, result.post, now);
    return { published: true };
  }
  await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'SCHEDULED', lastError: null } });
  await audit('workflow.scheduled', 'WorkflowKeyword', kw.id, { postId, at: at.toISOString(), website: wf.website.name });
  await log({ category: 'workflow', taskId: kw.taskId, message: `“${kw.keyword}” scheduled for ${at.toISOString()} (post #${postId}, verified in WordPress).` });
  return { scheduled: true, postId, at: at.toISOString() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gmt = (dateGmt: string | null | undefined) => (dateGmt ? Date.parse(`${dateGmt.replace(/Z$/, '')}Z`) : NaN);

/**
 * After the slot: confirm WordPress published the post (status read back). Owner report (morgan carey, 7:00 pm,
 * still “scheduled” at 7:15): WordPress publishes a scheduled post with its own scheduler, WP-Cron, which on many
 * hosts runs late or never (“Missed schedule”). So when the post's own time has passed by MISSED_SCHEDULE_GRACE_MS and
 * it is still “future”: first WP-Cron is started (wp-cron.php, as a visit to the site does) and WordPress publishes
 * it; if it still does not, the app publishes it itself — the approved path (withPublishPermit), its date kept.
 * Nothing is ever published before its time. A check that cannot reach WordPress says why on the keyword.
 */
export async function verifyKeywordPublished(keywordId: string): Promise<Record<string, unknown>> {
  const kw = await db.workflowKeyword.findUnique({ where: { id: keywordId }, include: { workflow: { include: { website: true } } } });
  if (!kw || kw.status !== 'SCHEDULED' || !kw.taskId) return { skipped: 'not scheduled' };
  const task = await db.articleTask.findUniqueOrThrow({ where: { id: kw.taskId } });
  if (!task.wpPostId) return { skipped: 'no post' };
  const postId = task.wpPostId;
  let via: 'wp-cron' | 'app' | null = null;
  let post: WpPost | null;
  try {
    post = await siteClient(kw.workflow.websiteId, `verify post #${postId}`, async (client) => {
      let p = await client.getPost(postId);
      const overdue = (x: WpPost | null) => x?.status === 'future' && Date.now() - gmt(x.date_gmt) >= MISSED_SCHEDULE_GRACE_MS;
      if (!overdue(p)) return p;
      // 1. WordPress's own scheduler (it may answer before it has finished: read back a few times).
      await client.runCron();
      for (let i = 0; i < 3 && p?.status === 'future'; i++) {
        if (i) await sleep(3000);
        p = await client.getPost(postId);
      }
      if (p?.status === 'publish') {
        via = 'wp-cron';
        return p;
      }
      if (!overdue(p) || !kw.workflow.website.canPublish || !kw.workflow.website.canPublishAcknowledgedAt) return p;
      // 2. WP-Cron did not run: published as scheduled, on the approved path, with its scheduled date kept.
      const date = p!.date_gmt!;
      await withPublishPermit(kw.workflow.websiteId, postId, `missed schedule ${date} for “${kw.keyword}”`, () => client.publishMissedSchedule(postId, date));
      p = await client.getPost(postId);
      if (p?.status === 'publish') via = 'app';
      return p;
    });
  } catch (error) {
    const message = (error as Error).message.split('\n')[0].slice(0, 300);
    await db.workflowKeyword.update({ where: { id: kw.id }, data: { lastError: `Could not check WordPress after the slot: ${message} Checked again in a few minutes.` } });
    throw error;
  }
  if (via === 'wp-cron') await log({ category: 'workflow', taskId: kw.taskId, message: `“${kw.keyword}”: WordPress had not published post #${postId} at its time (its scheduler, WP-Cron, had not run). The app started WP-Cron and WordPress published it.` });
  if (via === 'app') {
    await audit('workflow.published-missed-schedule', 'WorkflowKeyword', kw.id, { postId, at: post?.date_gmt, website: kw.workflow.website.name });
    await log({ level: 'warn', category: 'workflow', taskId: kw.taskId, message: `“${kw.keyword}”: WordPress did not publish post #${postId} at its time, and its scheduler (WP-Cron) did not run when started. The app published it as scheduled (date kept). If this happens often, ask the host to run WP-Cron by a real cron job.` });
  }
  if (post?.status === 'publish') {
    await markPublished(kw, post, new Date());
    return { published: true, url: post.link, ...(via ? { via } : {}) };
  }
  if (post?.status === 'future') {
    const when = gmt(post.date_gmt);
    const message =
      when > Date.now()
        ? kw.scheduledAt && sameMinute(post.date_gmt, kw.scheduledAt)
          ? `Scheduled in WordPress for ${post.date_gmt!.replace('T', ' ').slice(0, 16)} UTC; checked after that time.`
          : `WordPress has this post scheduled for ${post.date_gmt!.replace('T', ' ').slice(0, 16)} UTC (changed in WordPress); checked after that time.`
        : !kw.workflow.website.canPublish || !kw.workflow.website.canPublishAcknowledgedAt
          ? 'WordPress did not publish this post at its time, and publishing is now off for this website, so the app does not publish it. Publish it in WordPress, or allow publishing again.'
          : Date.now() - when < MISSED_SCHEDULE_GRACE_MS
            ? 'Its time has just come; WordPress publishes it within moments (checked again in a few minutes).'
            : 'WordPress did not publish this post at its time and refused to publish it now. Publish it yourself in WordPress; it is checked again.';
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
