import fs from 'node:fs';
import { db } from '../db';
import { fromDataRelative } from '../paths';
import { errorMessage, log } from '../log';
import { storeImage } from '@/images/store';
import { agentJson, checkAgentRequest } from './handler';
import { uploadRequestSchema } from './schemas';

export async function handleUpload(req: Request): Promise<Response> {
  const origin = req.headers.get('origin');
  const denied = await checkAgentRequest(req, 17_500_000);
  if (denied) return denied;
  let raw: unknown;
  try {
    raw = JSON.parse(await req.text());
  } catch {
    return agentJson({ error: 'Body must be JSON.' }, 400, origin);
  }
  const parsed = uploadRequestSchema.safeParse(raw);
  if (!parsed.success) return agentJson({ error: 'Invalid upload request' }, 400, origin);
  const body = parsed.data;
  const job = await db.queueJob.findUnique({ where: { id: body.jobId } });
  if (!job || job.queue !== 'chatgpt' || job.status !== 'ACTIVE' || job.claimedByTab !== body.tabId) {
    return agentJson({ error: 'Upload must belong to a job this tab currently owns.' }, 403, origin);
  }
  try {
    const buffer = Buffer.from(body.dataBase64, 'base64');
    const { asset, duplicate } = await storeImage({
      buffer,
      taskId: job.taskId,
      websiteId: job.websiteId,
      role: 'GALLERY',
      origin: 'CHATGPT',
      sourceUrl: body.sourceUrl ?? null,
      responseId: job.relatedId,
      notes: `upload:${body.name.slice(0, 80)}`,
    });
    return agentJson({ ok: true, mediaAssetId: asset.id, duplicate }, 200, origin);
  } catch (error) {
    await log({ level: 'warn', category: 'extension', taskId: job.taskId, message: `Image upload rejected: ${errorMessage(error)}` });
    return agentJson({ error: errorMessage(error) }, 400, origin);
  }
}

export async function handleMediaDownload(req: Request, mediaId: string): Promise<Response> {
  const origin = req.headers.get('origin');
  const denied = await checkAgentRequest(req);
  if (denied) return denied;
  const jobId = new URL(req.url).searchParams.get('jobId');
  const job = jobId ? await db.queueJob.findUnique({ where: { id: jobId } }) : null;
  if (!job || job.status !== 'ACTIVE' || !job.payload.includes(mediaId)) {
    return agentJson({ error: 'Attachment is not part of an active job.' }, 403, origin);
  }
  const asset = await db.mediaAsset.findUnique({ where: { id: mediaId } });
  if (!asset) return agentJson({ error: 'Not found' }, 404, origin);
  let file: string;
  try {
    file = fromDataRelative(asset.filePath);
  } catch {
    return agentJson({ error: 'Invalid path' }, 400, origin);
  }
  if (!fs.existsSync(file)) return agentJson({ error: 'File missing' }, 404, origin);
  const data = new Uint8Array(fs.readFileSync(file));
  return new Response(data, {
    headers: { 'Content-Type': asset.mime ?? 'application/octet-stream', 'Cache-Control': 'no-store', ...(origin?.startsWith('chrome-extension://') ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}) },
  });
}
