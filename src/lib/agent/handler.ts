import type { QueueJob } from '@prisma/client';
import { z } from 'zod';
import { db } from '../db';
import { log, errorMessage } from '../log';
import { getSettings, getValue } from '../settings';
import { isLoopbackHost } from '../security';
import { parsePayload } from '../queue';
import { allowedSlots, inBackoff, recordRateLimit } from '../chatgpt/rate';
import { claimChatGPTJob, completeChatGPTJob, failChatGPTJob, reportChatGPTProgress, type ChatGPTJobPayload, type ChatGPTJobProgress } from '../chatgpt/jobs';
import { resumeLoginPausedTasks } from '../tasks/lifecycle';
import { openIncident } from '../recovery';
import { verifyConnectionKey } from './keys';
import { agentRequestSchema, type AgentRequest } from './schemas';
import { AGENT_PROTOCOL_VERSION, EXPECTED_EXTENSION_VERSION } from './version';

/**
 * Framework-agnostic handler for POST /api/extension/agent (Web Request →
 * Response), shared by the Next.js route and the integration-test server.
 *
 * Security: loopback Host only; Origin must be a chrome-extension:// origin
 * (or absent); bearer connection key verified against the stored hash;
 * strict payload size; Zod validation; per-install rate limit.
 */

const MAX_BODY = 4_000_000;
const RATE_LIMIT = { windowMs: 60_000, max: 600 };
const buckets = new Map<string, { start: number; count: number }>();

export const CLAIMS_PAUSED_KEY = 'extension.claimsPaused';

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !origin.startsWith('chrome-extension://')) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

export function agentJson(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) } });
}

/** Shared checks for every extension endpoint. Returns an error Response or null. */
export async function checkAgentRequest(req: Request, maxBody = MAX_BODY): Promise<Response | null> {
  const origin = req.headers.get('origin');
  if (!isLoopbackHost(req.headers.get('host'))) return agentJson({ error: 'Only localhost is accepted.' }, 403, origin);
  if (origin && !origin.startsWith('chrome-extension://')) return agentJson({ error: 'Origin not allowed.' }, 403, origin);
  const length = Number(req.headers.get('content-length') ?? '0');
  if (length > maxBody) return agentJson({ error: 'Payload too large.' }, 413, origin);
  const auth = req.headers.get('authorization') ?? '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!(await verifyConnectionKey(key))) {
    return agentJson({ error: 'Invalid or missing connection key. Create a key in Settings → ChatGPT extension and paste it into the extension popup.', code: 'UNAUTHORIZED' }, 401, origin);
  }
  return null;
}

function rateLimited(key: string, now = Date.now()): boolean {
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.start > RATE_LIMIT.windowMs) {
    buckets.set(key, { start: now, count: 1 });
    return false;
  }
  bucket.count++;
  return bucket.count > RATE_LIMIT.max;
}

export async function handleAgentRequest(req: Request): Promise<Response> {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== 'POST') return agentJson({ error: 'Method not allowed' }, 405, origin);
  const denied = await checkAgentRequest(req);
  if (denied) return denied;
  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return agentJson({ error: 'Payload too large.' }, 413, origin);
    raw = JSON.parse(text);
  } catch {
    return agentJson({ error: 'Body must be JSON.' }, 400, origin);
  }
  const parsed = agentRequestSchema.safeParse(raw);
  if (!parsed.success) return agentJson({ error: 'Invalid request', issues: z.treeifyError(parsed.error) }, 400, origin);
  const body = parsed.data;
  if (rateLimited(`install:${body.installId}`)) return agentJson({ error: 'Rate limited — slow down.', retryAfterSec: 30 }, 429, origin);
  try {
    return agentJson(await dispatch(body), 200, origin);
  } catch (error) {
    await log({ level: 'error', category: 'extension', message: `Agent ${body.action} failed: ${errorMessage(error)}` });
    return agentJson({ error: errorMessage(error) }, 500, origin);
  }
}

async function versionMismatch(installId: string): Promise<string | null> {
  const row = await db.workerStatus.findUnique({ where: { id: `extension:${installId}` }, select: { version: true } });
  if (row?.version && row.version !== EXPECTED_EXTENSION_VERSION) {
    return `Extension version ${row.version} does not match the app (${EXPECTED_EXTENSION_VERSION}). Reload the unpacked extension from the project's extension folder once (chrome://extensions → reload).`;
  }
  return null;
}

async function dispatch(body: AgentRequest): Promise<unknown> {
  switch (body.action) {
    case 'hello':
      return hello(body);
    case 'claim': {
      const mismatch = await versionMismatch(body.installId);
      if (mismatch) return { job: null, reason: 'version-mismatch', message: mismatch };
      if (await getValue<boolean>(CLAIMS_PAUSED_KEY, false)) return { job: null, reason: 'paused', message: 'New claims are paused from the dashboard.' };
      const result = await claimChatGPTJob({ installId: body.installId, tabId: body.tabId, openConversationUrls: body.openConversationUrls });
      if (!('job' in result)) {
        return { job: null, reason: result.reason, ...(result.reason === 'backoff' ? { retryAfterSec: Math.max(1, Math.round((result.until.getTime() - Date.now()) / 1000)) } : {}) };
      }
      return { job: await describeJob(result.job, result.payload, result.reconcile, result.leaseUntil) };
    }
    case 'progress':
      return reportChatGPTProgress({
        jobId: body.jobId,
        tabId: body.tabId,
        progress: { step: body.step, sent: body.sent, sentAt: body.sentAt, conversationUrl: body.conversationUrl ?? undefined, diagnostics: body.diagnostics },
      });
    case 'complete':
      return completeChatGPTJob({
        jobId: body.jobId,
        tabId: body.tabId,
        text: body.text,
        html: body.html ?? null,
        conversationUrl: body.conversationUrl ?? null,
        recovered: body.recovered,
        reused: body.reused,
        elapsedMs: body.elapsedMs,
        images: body.images,
        imageLinks: body.imageLinks,
      });
    case 'fail':
      return failChatGPTJob({ jobId: body.jobId, tabId: body.tabId, code: body.code, message: body.message, retryAfterSec: body.retryAfterSec ?? null, uncertain: body.uncertain, diagnostics: body.diagnostics });
    case 'release':
      return releaseByTab(body.jobId, body.tabId, body.reason);
    case 'report429': {
      const until = await recordRateLimit({ retryAfterMs: body.retryAfterSec ? body.retryAfterSec * 1000 : null, reason: body.reason });
      await log({ level: 'warn', category: 'extension', message: `Extension reported rate limiting: ${body.reason}. Backing off until ${until.toISOString()}.` });
      return { ok: true, backoffUntil: until.toISOString() };
    }
  }
}

async function hello(body: Extract<AgentRequest, { action: 'hello' }>) {
  const settings = await getSettings();
  const now = new Date();
  const previous = await db.workerStatus.findUnique({ where: { id: `extension:${body.installId}` } });
  const prevDiag = previous ? (JSON.parse(previous.diagnostics) as Record<string, unknown>) : {};
  await db.workerStatus.upsert({
    where: { id: `extension:${body.installId}` },
    create: {
      id: `extension:${body.installId}`,
      kind: 'EXTENSION',
      version: body.version,
      status: body.claimsPaused ? 'PAUSED' : 'CONNECTED',
      capabilities: JSON.stringify(body.capabilities),
      diagnostics: JSON.stringify({ tabs: body.tabs.length, tabList: body.tabs, loggedIn: body.loggedIn ?? null, humanCheck: body.humanCheck ?? null, backoff: body.backoffUntil ?? null, lastError: body.lastError ?? null, ...(body.diagnostics ?? {}) }),
      startedAt: now,
      lastSeenAt: now,
    },
    update: {
      version: body.version,
      status: body.claimsPaused ? 'PAUSED' : 'CONNECTED',
      capabilities: JSON.stringify(body.capabilities),
      diagnostics: JSON.stringify({ tabs: body.tabs.length, tabList: body.tabs, loggedIn: body.loggedIn ?? null, humanCheck: body.humanCheck ?? null, backoff: body.backoffUntil ?? null, lastError: body.lastError ?? null, ...(body.diagnostics ?? {}) }),
      lastSeenAt: now,
    },
  });
  if (!previous) await log({ category: 'extension', message: `Extension ${body.installId.slice(0, 8)} v${body.version} connected.` });
  if (body.loggedIn === true && prevDiag.loggedIn !== true) {
    const resumed = await resumeLoginPausedTasks({ chatgpt: true });
    if (resumed) await log({ category: 'extension', message: `ChatGPT signed in; resumed ${resumed} paused task(s).` });
  }
  const versionOk = body.version === EXPECTED_EXTENSION_VERSION;
  const [waiting, active, slots, backoffUntil, paused] = await Promise.all([
    db.queueJob.count({ where: { queue: 'chatgpt', status: 'WAITING', runAt: { lte: now } } }),
    db.queueJob.count({ where: { queue: 'chatgpt', status: 'ACTIVE' } }),
    allowedSlots(),
    inBackoff(),
    getValue<boolean>(CLAIMS_PAUSED_KEY, false),
  ]);
  return {
    ok: true,
    versionOk,
    expectedVersion: EXPECTED_EXTENSION_VERSION,
    protocol: AGENT_PROTOCOL_VERSION,
    message: versionOk ? null : `Version mismatch: extension ${body.version}, app expects ${EXPECTED_EXTENSION_VERSION}. Reload the unpacked extension once; it will not reload itself.`,
    serverTime: now.toISOString(),
    config: {
      chatgptUrl: settings.browser.chatgptUrl,
      maxTabs: Math.min(slots, settings.browser.chatgptTabs),
      wantedTabs: Math.min(settings.browser.chatgptTabs, slots, Math.max(1, waiting + active)),
      pollIdleSec: settings.advanced.extensionIdlePollSec,
      pollBusySec: settings.advanced.extensionBusyPollSec,
      generationTimeoutSec: settings.browser.generationTimeoutSec,
      humanCheckPauseMinutes: settings.advanced.humanCheckPauseMinutes,
      composerReadyTimeoutSec: settings.advanced.composerReadyTimeoutSec,
      backoffUntil: backoffUntil?.toISOString() ?? null,
      claimsPaused: paused,
      waitingJobs: waiting,
      warning: settings.browser.chatgptTabs > 3 ? 'More than 3 ChatGPT tabs can trigger account-wide rate limiting.' : null,
    },
  };
}

async function describeJob(job: QueueJob, payload: ChatGPTJobPayload, reconcile: { conversationUrl: string | null; sentAt: string | null } | null, leaseUntil: Date) {
  return {
    id: job.id,
    kind: job.kind,
    operationId: payload.operationId,
    stageKey: payload.stageKey,
    prompt: payload.prompt,
    promptHash: payload.promptHash,
    conversationUrl: payload.conversationUrl,
    newChat: payload.newChat,
    expectImages: payload.expectImages,
    expectGallery: Boolean(payload.expectGallery),
    fresh: Boolean(payload.fresh),
    timeoutSec: payload.timeoutSec,
    language: payload.language,
    attachments: payload.attachments.map((a) => ({ ...a, url: `/api/extension/media/${a.mediaAssetId}?jobId=${job.id}` })),
    reconcile,
    leaseUntil: leaseUntil.toISOString(),
  };
}

/** A tab closed or navigated away while owning a job: requeue safely. */
async function releaseByTab(jobId: string, tabId: string, reason: string) {
  const job = await db.queueJob.findUnique({ where: { id: jobId } });
  if (!job || job.status !== 'ACTIVE' || job.claimedByTab !== tabId) return { ok: false, reason: 'not-owner' };
  const progress = job.progress ? (JSON.parse(job.progress) as ChatGPTJobProgress) : {};
  await db.queueJob.update({
    where: { id: job.id },
    data: { status: 'WAITING', runAt: new Date(), lockedBy: null, claimedByTab: null, leaseUntil: null, attempts: { decrement: 1 }, error: `Released by tab: ${reason}` },
  });
  if (progress.sent) {
    await openIncident({
      kind: 'UNCERTAIN_PROMPT',
      severity: 'warning',
      jobId: job.id,
      taskId: job.taskId,
      description: `Tab released a job after its prompt was sent (${reason}). The next claim reconciles the conversation before any resend.`,
      evidence: { conversationUrl: progress.conversationUrl ?? null, sentAt: progress.sentAt ?? null },
      dedupeKey: `release:${job.id}:${progress.sentAt ?? ''}`,
    });
  }
  await log({ level: 'warn', category: 'extension', taskId: job.taskId, message: `ChatGPT job released by tab ${tabId}: ${reason}${progress.sent ? ' (prompt was sent; will reconcile)' : ''}` });
  return { ok: true, requeued: true, reconcile: Boolean(progress.sent) };
}

export function payloadOf(job: QueueJob): ChatGPTJobPayload {
  return parsePayload<ChatGPTJobPayload>(job);
}
