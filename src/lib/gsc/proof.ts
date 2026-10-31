import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { db } from '../db';
import { dataPaths } from '../paths';
import { enqueue } from '../queue';
import { errorMessage, log } from '../log';
import { agentJson, checkAgentRequest } from '../agent/handler';
import { GSC_QUEUE, type IndexingJobPayload } from './request-indexing';

/**
 * Proof of a “Request indexing” (owner request: “show a screenshot like Search Console's ‘Indexing requested’ so I
 * know”). Automation Chrome saves the Search Console page as it stands after the click (pageCapture: an MHTML copy of
 * the page, which works in a background tab and a minimized window, unlike a screen capture). The worker opens that
 * copy offline (no scripts, no network) and stores a PNG of it with the article. The copy itself is deleted after.
 */

export const PROOF_ROLE = 'INDEXING_PROOF';
const MAX_MHTML_BYTES = 15 * 1024 * 1024;
const proofSchema = z.object({ installId: z.string().min(8).max(100), jobId: z.string().min(1).max(40), mhtmlBase64: z.string().min(16) });
const proofFile = (jobId: string) => path.join(dataPaths.uploads(), 'gsc-proof', `${jobId.replace(/[^\w-]/g, '')}.mhtml`);
export const proofNote = (keywordId: string) => `gsc-proof:${keywordId}`;

/** POST /api/extension/gsc-proof: the page copy for a request this extension is making right now. */
export async function handleGscProof(req: Request): Promise<Response> {
  const origin = req.headers.get('origin');
  const denied = await checkAgentRequest(req, Math.ceil(MAX_MHTML_BYTES * 1.4) + 4096);
  if (denied) return denied;
  let raw: unknown;
  try {
    raw = JSON.parse(await req.text());
  } catch {
    return agentJson({ error: 'Body must be JSON.' }, 400, origin);
  }
  const parsed = proofSchema.safeParse(raw);
  if (!parsed.success) return agentJson({ error: 'Invalid proof upload' }, 400, origin);
  const { installId, jobId, mhtmlBase64 } = parsed.data;
  const job = await db.queueJob.findUnique({ where: { id: jobId } });
  if (!job || job.queue !== GSC_QUEUE || job.status !== 'ACTIVE' || job.lockedBy !== `extension:${installId}`) {
    return agentJson({ error: 'The proof must belong to a request this extension is making now.' }, 403, origin);
  }
  const buffer = Buffer.from(mhtmlBase64, 'base64');
  // An MHTML file starts with its MIME headers (Chrome writes “From: <Saved by Blink>”).
  if (buffer.length > MAX_MHTML_BYTES || !/^(From:|MIME-Version:|Content-Type: multipart\/related)/i.test(buffer.subarray(0, 200).toString('latin1').trimStart())) {
    return agentJson({ error: 'Not a page copy (MHTML) of an acceptable size.' }, 400, origin);
  }
  const file = proofFile(jobId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer, { mode: 0o600 });
  const p = JSON.parse(job.payload) as IndexingJobPayload;
  // One screenshot per run of the request (a request asked again from the keyword queue runs again).
  await enqueue({ queue: 'control', kind: 'gsc.proof', idempotencyKey: `gsc-proof:${jobId}:${job.startedAt?.getTime() ?? 0}`, websiteId: p.websiteId, relatedId: p.keywordId, payload: { jobId, keywordId: p.keywordId, url: p.url }, maxAttempts: 1 });
  return agentJson({ ok: true }, 200, origin);
}

/** Worker: the page copy as a PNG (offline: no scripts, no network), stored with the article; the copy is deleted. */
export async function renderGscProof(payload: { jobId: string; keywordId: string; url: string }): Promise<Record<string, unknown>> {
  const file = proofFile(payload.jobId);
  if (!fs.existsSync(file)) return { skipped: 'page copy missing' };
  const kw = await db.workflowKeyword.findUnique({ where: { id: payload.keywordId }, include: { workflow: { select: { websiteId: true } } } });
  try {
    if (!kw) return { skipped: 'keyword deleted' };
    const { chromium } = await import('playwright');
    const { browserLaunchBase } = await import('../browser-launch');
    const browser = await chromium.launch({ ...browserLaunchBase(), headless: true });
    let png: Buffer;
    let iconsHidden = 0;
    try {
      const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, javaScriptEnabled: false });
      await page.route(/^(https?|wss?):/, (r) => r.abort());
      await page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: 60_000 });
      // Owner report (“keyboard_arrow_down”, “home”, “info” all over the screenshot): Google's icons are a font that
      // is not in the copy, so their names showed as text. They are hidden; the page's own scripts still never run.
      iconsHidden = await page.evaluate(() => {
        let n = 0;
        for (const el of Array.from(document.querySelectorAll('body *'))) {
          if (el.children.length || !/^[a-z][a-z0-9_]{1,40}$/.test((el.textContent ?? '').trim())) continue;
          if (!/material|icons|symbols/i.test(getComputedStyle(el).fontFamily)) continue;
          (el as HTMLElement).style.visibility = 'hidden';
          n++;
        }
        return n;
      });
      png = await page.screenshot({ type: 'png' });
    } finally {
      await browser.close();
    }
    const { storeImage } = await import('@/images/store');
    const { asset } = await storeImage({ buffer: png, taskId: kw.taskId, websiteId: kw.workflow.websiteId, role: PROOF_ROLE, origin: 'RENDERED', sourceUrl: payload.url, notes: proofNote(kw.id) });
    await log({ category: 'search', taskId: kw.taskId, message: `Search Console screenshot saved for ${payload.url} (proof of the indexing request).` });
    return { mediaAssetId: asset.id, iconsHidden };
  } catch (error) {
    await log({ level: 'warn', category: 'search', message: `The Search Console screenshot for ${payload.url} could not be made: ${errorMessage(error)}` });
    throw error;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** The latest proof screenshot of each keyword. */
export async function proofsFor(keywordIds: string[]): Promise<Map<string, string>> {
  if (!keywordIds.length) return new Map();
  const assets = await db.mediaAsset.findMany({ where: { role: PROOF_ROLE, notes: { in: keywordIds.map(proofNote) } }, orderBy: { createdAt: 'asc' }, select: { id: true, notes: true } });
  return new Map(assets.map((a) => [a.notes!.slice('gsc-proof:'.length), a.id]));
}
