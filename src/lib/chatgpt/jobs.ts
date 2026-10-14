import type { ArticleTask, QueueJob } from '@prisma/client';
import { db, type Tx } from '../db';
import { claimNext, enqueue, parsePayload, wakeArticleJob } from '../queue';
import { log } from '../log';
import { getSettings } from '../settings';
import { normalizeResponseText, promptFingerprint, responseFingerprint } from './normalize';
import { allowedSlots, inBackoff, recordRateLimit, recordSuccess } from './rate';
import type { ExtensionFailCode } from '../domain';

/**
 * Bridge between pipeline stages (worker) and the ChatGPT extension (agent API).
 * The worker only records requests; the extension claims them, reports
 * progress and completes/fails them. No server-side model calls exist.
 */

export interface ChatGPTJobPayload {
  operationId: string;
  taskId: string;
  stageKey: string;
  prompt: string;
  promptHash: string;
  /** Saved conversation for affinity (null/newChat → open a new chat). */
  conversationUrl: string | null;
  newChat: boolean;
  attachments: { mediaAssetId: string; name: string; mime: string }[];
  expectImages: boolean;
  /** Deliberate re-send of an identical prompt (regeneration): recover only with evidence. */
  fresh?: boolean;
  timeoutSec: number;
  language: string;
}

export interface ChatGPTJobProgress {
  step?: string;
  /** True once the extension clicked Send for this operation. */
  sent?: boolean;
  sentAt?: string;
  conversationUrl?: string | null;
  diagnostics?: Record<string, unknown>;
  updatedAt?: string;
}

export function isRealConversationUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (!/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(u.hostname)) return false;
    // Placeholder IDs such as /c/local-chatgpt:<uuid> are not real conversations.
    return /^\/(?:g\/[^/]+\/)?c\/[0-9a-f-]{20,}$/i.test(u.pathname);
  } catch {
    return false;
  }
}

export async function createChatGPTRequest(
  input: {
    task: Pick<ArticleTask, 'id' | 'websiteId' | 'conversationUrl' | 'priority' | 'language'>;
    stageKey: string;
    attempt: number;
    operationId: string;
    prompt: string;
    newChat: boolean;
    attachments?: ChatGPTJobPayload['attachments'];
    expectImages?: boolean;
    fresh?: boolean;
    timeoutSec: number;
    conversationSwitch?: boolean;
  },
  client: Tx = db,
): Promise<{ responseId: string; jobId: string; created: boolean }> {
  const existing = await client.chatGPTResponse.findUnique({ where: { operationId: input.operationId } });
  const promptHash = promptFingerprint(input.prompt);
  const response =
    existing ??
    (await client.chatGPTResponse.create({
      data: {
        taskId: input.task.id,
        stageKey: input.stageKey,
        attempt: input.attempt,
        operationId: input.operationId,
        promptHash,
        renderedPrompt: input.prompt,
        conversationSwitch: Boolean(input.conversationSwitch),
      },
    }));
  const payload: ChatGPTJobPayload = {
    operationId: input.operationId,
    taskId: input.task.id,
    stageKey: input.stageKey,
    prompt: input.prompt,
    promptHash,
    conversationUrl: input.newChat || !isRealConversationUrl(input.task.conversationUrl) ? null : input.task.conversationUrl,
    newChat: input.newChat || !isRealConversationUrl(input.task.conversationUrl),
    attachments: input.attachments ?? [],
    expectImages: Boolean(input.expectImages),
    fresh: Boolean(input.fresh),
    timeoutSec: input.timeoutSec,
    language: input.task.language,
  };
  const { job, created } = await enqueue(
    {
      queue: 'chatgpt',
      kind: 'chatgpt.prompt',
      idempotencyKey: `chatgpt:${input.operationId}`,
      taskId: input.task.id,
      relatedId: response.id,
      websiteId: input.task.websiteId,
      priority: input.task.priority,
      maxAttempts: 4,
      payload,
    },
    client,
  );
  if (!existing || existing.jobId !== job.id) {
    await client.chatGPTResponse.update({ where: { id: response.id }, data: { jobId: job.id } });
  }
  return { responseId: response.id, jobId: job.id, created };
}

export interface ClaimResult {
  job: QueueJob;
  payload: ChatGPTJobPayload;
  /** The prompt may already have been sent before a crash: reconcile before resending. */
  reconcile: { conversationUrl: string | null; sentAt: string | null } | null;
  leaseUntil: Date;
}

export type ClaimRefusal = { reason: 'backoff'; until: Date } | { reason: 'slots'; active: number; allowed: number } | { reason: 'empty' };

/**
 * Claim one ChatGPT job for a tab. Respects the shared account budget
 * (backoff + adaptive slots), prefers jobs whose conversation the tab already
 * has open, and rotates fairly between websites.
 */
export async function claimChatGPTJob(
  input: { installId: string; tabId: string; openConversationUrls?: string[] },
  client: Tx = db,
  now = new Date(),
): Promise<ClaimResult | ClaimRefusal> {
  const backoffUntil = await inBackoff(client, now);
  if (backoffUntil) return { reason: 'backoff', until: backoffUntil };
  const settings = await getSettings(client);
  const [active, allowed] = await Promise.all([client.queueJob.count({ where: { queue: 'chatgpt', status: 'ACTIVE' } }), allowedSlots(client, now)]);
  if (active >= Math.min(allowed, settings.browser.chatgptTabs)) return { reason: 'slots', active, allowed };
  const open = new Set((input.openConversationUrls ?? []).filter(isRealConversationUrl));
  const activeSites = await client.queueJob.groupBy({ by: ['websiteId'], where: { queue: 'chatgpt', status: 'ACTIVE' }, _count: { _all: true } });
  const siteLoad = new Map(activeSites.map((s) => [s.websiteId, s._count._all]));
  const leaseMs = settings.advanced.chatgptClaimLeaseSeconds * 1000;
  const owner = `ext:${input.installId}:${input.tabId}`;
  const job = await claimNext(
    {
      queue: 'chatgpt',
      owner,
      leaseMs,
      now,
      scan: 50,
      extra: { claimedByTab: input.tabId },
      choose: (candidates) =>
        [...candidates].sort((a, b) => {
          const aff = Number(open.has(parsePayload<ChatGPTJobPayload>(b).conversationUrl ?? '')) - Number(open.has(parsePayload<ChatGPTJobPayload>(a).conversationUrl ?? ''));
          if (aff !== 0) return aff;
          if (b.priority !== a.priority) return b.priority - a.priority;
          const load = (siteLoad.get(a.websiteId) ?? 0) - (siteLoad.get(b.websiteId) ?? 0);
          if (load !== 0) return load;
          return a.runAt.getTime() - b.runAt.getTime();
        }),
    },
    client,
  );
  if (!job) return { reason: 'empty' };
  const payload = parsePayload<ChatGPTJobPayload>(job);
  const progress = job.progress ? (JSON.parse(job.progress) as ChatGPTJobProgress) : null;
  const reconcile = progress?.sent ? { conversationUrl: progress.conversationUrl ?? null, sentAt: progress.sentAt ?? null } : null;
  if (job.taskId) {
    await client.articleTask.updateMany({
      where: { id: job.taskId, status: { in: ['QUEUED', 'LOGIN_REQUIRED', 'PAUSED'] } },
      data: { status: 'OPENING_CHATGPT', pausedFor: null, message: `ChatGPT tab ${input.tabId} is preparing "${payload.stageKey}"` },
    });
  }
  return { job, payload, reconcile, leaseUntil: job.leaseUntil ?? new Date(now.getTime() + leaseMs) };
}

async function ownedJob(jobId: string, tabId: string, client: Tx) {
  const job = await client.queueJob.findUnique({ where: { id: jobId } });
  if (!job || job.queue !== 'chatgpt') return { job: null, error: 'Unknown job' } as const;
  if (job.status !== 'ACTIVE') return { job, error: `Job is ${job.status}` } as const;
  if (job.claimedByTab !== tabId) return { job, error: 'Job is owned by another tab' } as const;
  return { job, error: null } as const;
}

/** Progress heartbeat from the extension. Returns whether the job should be cancelled. */
export async function reportChatGPTProgress(
  input: { jobId: string; tabId: string; progress: ChatGPTJobProgress },
  client: Tx = db,
): Promise<{ ok: boolean; cancel: boolean; leaseUntil: Date | null; error?: string }> {
  // Read-modify-write of the sticky "sent" evidence must be atomic: take the
  // SQLite write lock first so concurrent progress reports cannot lose it.
  if ('$transaction' in client && typeof (client as typeof db).$transaction === 'function') {
    return (client as typeof db).$transaction(
      async (tx) => {
        await tx.$executeRaw`UPDATE "QueueJob" SET "heartbeatAt" = "heartbeatAt" WHERE "id" = ${input.jobId}`;
        return reportChatGPTProgressLocked(input, tx);
      },
      { timeout: 15_000, maxWait: 15_000 },
    );
  }
  return reportChatGPTProgressLocked(input, client);
}

async function reportChatGPTProgressLocked(
  input: { jobId: string; tabId: string; progress: ChatGPTJobProgress },
  client: Tx,
): Promise<{ ok: boolean; cancel: boolean; leaseUntil: Date | null; error?: string }> {
  const { job, error } = await ownedJob(input.jobId, input.tabId, client);
  if (!job || error) return { ok: false, cancel: true, leaseUntil: null, error: error ?? 'Unknown job' };
  const task = job.taskId ? await client.articleTask.findUnique({ where: { id: job.taskId }, select: { cancelRequested: true } }) : null;
  const settings = await getSettings(client);
  const leaseUntil = new Date(Date.now() + settings.advanced.chatgptClaimLeaseSeconds * 1000);
  const previous = job.progress ? (JSON.parse(job.progress) as ChatGPTJobProgress) : {};
  const merged: ChatGPTJobProgress = {
    ...previous,
    ...input.progress,
    // "sent" is sticky: once proven sent, never forget it.
    sent: Boolean(previous.sent || input.progress.sent),
    sentAt: previous.sentAt ?? input.progress.sentAt,
    diagnostics: input.progress.diagnostics ? Object.fromEntries(Object.entries(input.progress.diagnostics).slice(0, 40)) : previous.diagnostics,
    updatedAt: new Date().toISOString(),
  };
  await client.queueJob.update({
    where: { id: job.id },
    data: {
      heartbeatAt: new Date(),
      leaseUntil,
      progress: JSON.stringify(merged).slice(0, 20_000),
      conversationUrl: isRealConversationUrl(merged.conversationUrl) ? merged.conversationUrl : job.conversationUrl,
    },
  });
  if (job.taskId && input.progress.step) {
    await client.articleTask.updateMany({
      where: { id: job.taskId, cancelRequested: false },
      data: { message: `ChatGPT (${parsePayload<ChatGPTJobPayload>(job).stageKey}): ${input.progress.step}`.slice(0, 300) },
    });
  }
  return { ok: true, cancel: Boolean(task?.cancelRequested), leaseUntil };
}

export async function completeChatGPTJob(
  input: { jobId: string; tabId: string; text: string; html?: string | null; conversationUrl?: string | null; recovered?: boolean; reused?: boolean; elapsedMs?: number; images?: { mediaAssetId: string }[] },
  client: Tx = db,
): Promise<{ ok: boolean; error?: string }> {
  const { job, error } = await ownedJob(input.jobId, input.tabId, client);
  if (!job || error) return { ok: false, error: error ?? 'Unknown job' };
  const payload = parsePayload<ChatGPTJobPayload>(job);
  const text = normalizeResponseText(input.text ?? '');
  if (!text && !(input.images && input.images.length)) {
    await failChatGPTJob({ jobId: job.id, tabId: input.tabId, code: 'ERROR', message: 'Empty answer received from ChatGPT' }, client);
    return { ok: false, error: 'Empty answer' };
  }
  const conversationUrl = isRealConversationUrl(input.conversationUrl) ? input.conversationUrl : null;
  await client.queueJob.update({
    where: { id: job.id },
    data: {
      status: 'COMPLETED',
      finishedAt: new Date(),
      leaseUntil: null,
      conversationUrl,
      // Diagnostic jobs (no task) keep their short answer on the job itself.
      result: JSON.stringify({ length: text.length, recovered: Boolean(input.recovered), ...(job.relatedId ? {} : { text: text.slice(0, 4000) }) }),
    },
  });
  if (job.relatedId) {
    await client.chatGPTResponse.update({
      where: { id: job.relatedId },
      data: {
        status: 'COMPLETED',
        resultText: text,
        resultHtml: input.html ? input.html.slice(0, 2_000_000) : null,
        conversationUrl,
        responseFingerprint: responseFingerprint(text),
        recovered: Boolean(input.recovered),
        reused: Boolean(input.reused),
        elapsedMs: input.elapsedMs ?? (job.startedAt ? Date.now() - job.startedAt.getTime() : null),
        completedAt: new Date(),
        error: null,
      },
    });
  }
  if (job.taskId) {
    if (conversationUrl) await client.articleTask.update({ where: { id: job.taskId }, data: { conversationUrl } });
    await wakeArticleJob(job.taskId, client);
    await log({ category: 'chatgpt', taskId: job.taskId, stage: payload.stageKey, message: `ChatGPT answer saved (${text.length} chars${input.recovered ? ', recovered after interruption' : ''}).` }, client);
  }
  const backlog = await client.queueJob.count({ where: { queue: 'chatgpt', status: 'WAITING' } });
  await recordSuccess(client, new Date(), backlog);
  return { ok: true };
}

export async function failChatGPTJob(
  input: { jobId: string; tabId: string; code: ExtensionFailCode; message: string; retryAfterSec?: number | null; uncertain?: boolean; diagnostics?: Record<string, unknown> },
  client: Tx = db,
): Promise<{ ok: boolean; outcome?: string; error?: string }> {
  const { job, error } = await ownedJob(input.jobId, input.tabId, client);
  if (!job || error) return { ok: false, error: error ?? 'Unknown job' };
  const payload = parsePayload<ChatGPTJobPayload>(job);
  const message = input.message.slice(0, 1000);
  if (input.diagnostics) {
    // Keep the page debug snapshot (URL, variant, composer/send/stop state…) for Diagnostics.
    const previous = job.progress ? (JSON.parse(job.progress) as ChatGPTJobProgress) : {};
    await client.queueJob.update({
      where: { id: job.id },
      data: { progress: JSON.stringify({ ...previous, failureSnapshot: Object.fromEntries(Object.entries(input.diagnostics).slice(0, 40)) }).slice(0, 20_000) },
    });
  }
  if (input.uncertain) {
    // The extension cannot prove whether the prompt was sent/answered: never resend blindly.
    await client.queueJob.update({ where: { id: job.id }, data: { status: 'FAILED', finishedAt: new Date(), leaseUntil: null, error: message, errorCode: 'UNCERTAIN' } });
    if (job.relatedId) await client.chatGPTResponse.update({ where: { id: job.relatedId }, data: { status: 'FAILED', error: `UNCERTAIN: ${message}` } });
    if (job.taskId) await wakeArticleJob(job.taskId, client);
    await log({ level: 'warn', category: 'chatgpt', taskId: job.taskId, stage: payload.stageKey, message: `Uncertain prompt state, paused for review: ${message}` }, client);
    return { ok: true, outcome: 'uncertain' };
  }
  const settings = await getSettings(client);
  const release = (runAt: Date, countAttempt: boolean) =>
    client.queueJob.update({
      where: { id: job.id },
      data: {
        status: 'WAITING',
        runAt,
        lockedBy: null,
        claimedByTab: null,
        leaseUntil: null,
        error: message,
        errorCode: input.code,
        ...(countAttempt ? {} : { attempts: { decrement: 1 } }),
      },
    });
  let outcome: string;
  switch (input.code) {
    case 'LOGIN':
    case 'HUMAN_CHECK': {
      await release(new Date(Date.now() + 60_000), false);
      if (job.taskId) {
        await client.articleTask.update({
          where: { id: job.taskId },
          data: {
            status: input.code === 'LOGIN' ? 'LOGIN_REQUIRED' : 'PAUSED',
            pausedFor: input.code === 'LOGIN' ? 'chatgpt-login' : 'chatgpt-human-check',
            message: input.code === 'LOGIN' ? 'ChatGPT asks you to sign in.' : 'ChatGPT shows a human verification check.',
            nextAction:
              input.code === 'LOGIN'
                ? 'Open the Automation Chrome window and sign in to ChatGPT. The task resumes automatically.'
                : 'Complete the verification in the Automation Chrome window yourself. The task resumes automatically.',
          },
        });
      }
      outcome = 'paused';
      break;
    }
    case 'USAGE_LIMIT': {
      const until = await recordRateLimit({ retryAfterMs: input.retryAfterSec ? input.retryAfterSec * 1000 : null, reason: message, usageCap: /limit|cap/i.test(message) }, client);
      await release(until, false);
      if (job.taskId) {
        await client.articleTask.update({
          where: { id: job.taskId },
          data: { status: 'PAUSED', pausedFor: 'usage-limit', message: `ChatGPT usage limit / rate limit — waiting until ${until.toLocaleTimeString()}.`, nextAction: 'No action needed; the task resumes when the limit window passes.' },
        });
      }
      outcome = 'backoff';
      break;
    }
    case 'CANCELLED': {
      await client.queueJob.update({ where: { id: job.id }, data: { status: 'CANCELLED', finishedAt: new Date(), leaseUntil: null, error: message, errorCode: 'CANCELLED' } });
      if (job.relatedId) await client.chatGPTResponse.update({ where: { id: job.relatedId }, data: { status: 'SUPERSEDED', error: message } });
      outcome = 'cancelled';
      break;
    }
    case 'CONVERSATION_LOST': {
      await client.queueJob.update({ where: { id: job.id }, data: { status: 'FAILED', finishedAt: new Date(), leaseUntil: null, error: message, errorCode: input.code } });
      if (job.relatedId) await client.chatGPTResponse.update({ where: { id: job.relatedId }, data: { status: 'FAILED', error: `CONVERSATION_LOST: ${message}` } });
      if (job.taskId) {
        await client.articleTask.update({ where: { id: job.taskId }, data: { conversationUrl: null } });
        await wakeArticleJob(job.taskId, client);
      }
      outcome = 'conversation-lost';
      break;
    }
    default: {
      const progress = job.progress ? (JSON.parse(job.progress) as ChatGPTJobProgress) : {};
      if (job.attempts < job.maxAttempts) {
        const delay = Math.min(settings.workflow.retryMaxDelaySec, settings.workflow.retryBaseDelaySec * 2 ** Math.max(0, job.attempts - 1)) * 1000;
        await release(new Date(Date.now() + delay), true);
        outcome = progress.sent ? 'retry-reconcile' : 'retry';
      } else {
        await client.queueJob.update({ where: { id: job.id }, data: { status: 'FAILED', finishedAt: new Date(), leaseUntil: null, error: message, errorCode: 'ERROR' } });
        if (job.relatedId) await client.chatGPTResponse.update({ where: { id: job.relatedId }, data: { status: 'FAILED', error: message } });
        if (job.taskId) await wakeArticleJob(job.taskId, client);
        outcome = 'failed';
      }
    }
  }
  await log({ level: input.code === 'ERROR' ? 'warn' : 'info', category: 'chatgpt', taskId: job.taskId, stage: payload.stageKey, message: `ChatGPT job ${input.code}: ${message} → ${outcome}` }, client);
  return { ok: true, outcome };
}
