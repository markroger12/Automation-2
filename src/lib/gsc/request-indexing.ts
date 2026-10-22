import { db } from '../db';
import { log } from '../log';
import { enqueue } from '../queue';
import { inspectionUrl } from '../workflow/search-console';

/**
 * “Request indexing” as the owner does it (owner request): open the URL in Search Console's URL Inspection and click
 * REQUEST INDEXING. Google offers no API for this button (the URL Inspection API only reads the status, and the
 * Indexing API is not used), so Automation Chrome does it with the Google account signed in there. A request is never
 * proof of indexing: “Indexed” still comes only from Google's URL Inspection.
 */

export const GSC_QUEUE = 'gsc';
const KIND = 'gsc.request-indexing';
const LEASE_MS = 8 * 60_000;

export interface IndexingJobPayload {
  keywordId: string;
  url: string;
  property: string;
  websiteId: string;
}

export type IndexingOutcome = 'REQUESTED' | 'QUOTA' | 'NOT_SIGNED_IN' | 'NO_ACCESS' | 'HUMAN_CHECK' | 'ERROR';

/** Queue one request for a published keyword (once; a repeat call finds the same job). */
export async function queueIndexingRequest(p: IndexingJobPayload, now = new Date()) {
  const { job, created } = await enqueue({ queue: GSC_QUEUE, kind: KIND, idempotencyKey: `gsc-index:${p.keywordId}`, websiteId: p.websiteId, payload: p, runAt: now, maxAttempts: 4 });
  return { job, created };
}

export async function waitingIndexingRequests(now = new Date()): Promise<number> {
  return db.queueJob.count({ where: { queue: GSC_QUEUE, OR: [{ status: 'WAITING', runAt: { lte: now } }, { status: 'ACTIVE', leaseUntil: { lt: now } }] } });
}

/** The extension takes the next request (an expired one comes back). */
export async function claimIndexingRequest(installId: string, now = new Date()): Promise<{ id: string; url: string; property: string; inspectUrl: string } | null> {
  for (let i = 0; i < 20; i++) {
    const job = await db.queueJob.findFirst({ where: { queue: GSC_QUEUE, OR: [{ status: 'WAITING', runAt: { lte: now } }, { status: 'ACTIVE', leaseUntil: { lt: now } }] }, orderBy: { runAt: 'asc' } });
    if (!job) return null;
    const p = JSON.parse(job.payload) as IndexingJobPayload;
    // Already on Google, or the keyword was deleted: nothing to request.
    const kw = await db.workflowKeyword.findUnique({ where: { id: p.keywordId }, select: { status: true } });
    if (!kw || kw.status === 'INDEXED') {
      await db.queueJob.updateMany({ where: { id: job.id, updatedAt: job.updatedAt }, data: { status: 'CANCELLED', finishedAt: now, leaseUntil: null, error: kw ? 'Google already shows the URL as indexed.' : 'The keyword was deleted.' } });
      continue;
    }
    const taken = await db.queueJob.updateMany({ where: { id: job.id, updatedAt: job.updatedAt }, data: { status: 'ACTIVE', lockedBy: `extension:${installId}`, leaseUntil: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 }, startedAt: now } });
    if (!taken.count) return null;
    await setKeyword(p.keywordId, { indexingStatus: `Automation Chrome is requesting indexing in Search Console (URL Inspection → Request indexing) · ${now.toISOString()}` });
    return { id: job.id, url: p.url, property: p.property, inspectUrl: inspectionUrl(p.property, p.url) };
  }
  return null;
}

const HOUR = 3600_000;

/** What Automation Chrome saw after clicking (or trying to click) REQUEST INDEXING. */
export async function reportIndexingRequest(input: { jobId: string; installId: string; outcome: IndexingOutcome; message?: string | null }, now = new Date()) {
  const job = await db.queueJob.findUnique({ where: { id: input.jobId } });
  if (!job || job.queue !== GSC_QUEUE) return { ok: false, error: 'Unknown job' };
  // A late or repeated report (lease expired, outbox resend) never changes a job this extension no longer holds.
  if (job.status !== 'ACTIVE' || job.lockedBy !== `extension:${input.installId}`) return { ok: false, error: 'Not claimed by this extension' };
  const p = JSON.parse(job.payload) as IndexingJobPayload;
  const said = input.message ? ` Google: “${input.message.slice(0, 200)}”.` : '';
  const retry = async (inMs: number, why: string) => {
    if (job.attempts >= job.maxAttempts && input.outcome === 'ERROR') {
      await db.queueJob.update({ where: { id: job.id }, data: { status: 'FAILED', finishedAt: now, leaseUntil: null, error: why.slice(0, 1000), errorCode: input.outcome } });
      await setKeyword(p.keywordId, { indexingStatus: `Indexing could not be requested after ${job.attempts} tries: ${why} Request it yourself in Search Console (URL Inspection → Request indexing).` });
      return;
    }
    await db.queueJob.update({ where: { id: job.id }, data: { status: 'WAITING', runAt: new Date(now.getTime() + inMs), leaseUntil: null, lockedBy: null, error: why.slice(0, 1000), errorCode: input.outcome } });
    await setKeyword(p.keywordId, { indexingStatus: `${why} Asked again ${new Date(now.getTime() + inMs).toISOString()}.` });
    await log({ level: 'warn', category: 'search', message: `Indexing not requested yet for ${p.url}: ${why}` });
  };
  switch (input.outcome) {
    case 'REQUESTED':
      await db.queueJob.update({ where: { id: job.id }, data: { status: 'COMPLETED', finishedAt: now, leaseUntil: null, error: null, errorCode: null } });
      await setKeyword(p.keywordId, { status: 'INDEXING_REQUESTED', indexingRequestedAt: now, indexingStatus: `Indexing requested in Search Console (URL Inspection → Request indexing) at ${now.toISOString()}.${said} A request is not proof of indexing; Google is asked for the index status next.` }, true);
      await log({ category: 'search', message: `Indexing requested in Search Console for ${p.url}.` });
      break;
    case 'QUOTA':
      // Search Console allows only a few requests a day per property.
      await retry(20 * HOUR, `Search Console's daily limit for indexing requests was reached.${said}`);
      break;
    case 'NOT_SIGNED_IN':
      await retry(HOUR, 'Sign in to Google (Search Console) in Automation Chrome, then the request is made automatically.');
      break;
    case 'HUMAN_CHECK':
      await retry(HOUR, 'Google showed a check in Automation Chrome; complete it there.');
      break;
    case 'NO_ACCESS':
      await db.queueJob.update({ where: { id: job.id }, data: { status: 'FAILED', finishedAt: now, leaseUntil: null, error: `No access to ${p.property}`, errorCode: input.outcome } });
      await setKeyword(p.keywordId, { indexingStatus: `The Google account in Automation Chrome cannot use ${p.property} in Search Console.${said} Sign in with the account that owns the property, then retry the keyword.` });
      break;
    default:
      await retry(HOUR, `Indexing could not be requested (${(input.message ?? 'unknown problem').slice(0, 200)}).`);
  }
  return { ok: true };
}

async function setKeyword(id: string, data: { status?: string; indexingRequestedAt?: Date; indexingStatus: string }, onlyIfPublished = false) {
  // Never step back: a keyword Google already reported as indexed keeps that.
  await db.workflowKeyword.updateMany({ where: { id, status: onlyIfPublished ? { in: ['PUBLISHED', 'INDEXING_REQUESTED'] } : { not: 'INDEXED' } }, data });
}

/** Why a queued request has not been made yet (shown next to Google's index status), or null. */
export async function pendingRequestNote(keywordId: string): Promise<string | null> {
  const job = await db.queueJob.findFirst({ where: { queue: GSC_QUEUE, idempotencyKey: `gsc-index:${keywordId}`, status: 'WAITING', error: { not: null } }, select: { error: true } });
  return job?.error ? `Request indexing: ${job.error}` : null;
}
