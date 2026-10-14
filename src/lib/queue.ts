import { Prisma, type QueueJob } from '@prisma/client';
import { db, type Tx } from './db';
import type { QueueName } from './domain';

/**
 * Database-backed job queue (no in-memory queue). Claims are atomic
 * compare-and-set updates (`WHERE id = ? AND status = 'WAITING'`), so two
 * claimers can never own the same job. ACTIVE jobs carry a lease and a
 * heartbeat; expired leases are handled by src/worker/recovery.ts according to
 * job type and possible external side effects.
 */

export interface EnqueueInput {
  queue: QueueName;
  kind: string;
  idempotencyKey: string;
  taskId?: string | null;
  relatedId?: string | null;
  websiteId?: string | null;
  payload?: unknown;
  priority?: number;
  runAt?: Date;
  maxAttempts?: number;
}

/** Insert a job unless one with the same idempotency key exists (returns the existing one). */
export async function enqueue(input: EnqueueInput, client: Tx = db): Promise<{ job: QueueJob; created: boolean }> {
  const existing = await client.queueJob.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return { job: existing, created: false };
  try {
    const job = await client.queueJob.create({
      data: {
        queue: input.queue,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        taskId: input.taskId ?? null,
        relatedId: input.relatedId ?? null,
        websiteId: input.websiteId ?? null,
        payload: JSON.stringify(input.payload ?? {}),
        priority: input.priority ?? 0,
        runAt: input.runAt ?? new Date(),
        maxAttempts: input.maxAttempts ?? 3,
      },
    });
    return { job, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const job = await client.queueJob.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
      return { job, created: false };
    }
    throw error;
  }
}

export interface ClaimOptions {
  queue: QueueName;
  owner: string;
  leaseMs: number;
  now?: Date;
  /** Exclude jobs for these websites (per-site concurrency/pauses). */
  excludeWebsiteIds?: string[];
  /** Restrict to these kinds. */
  kinds?: string[];
  /** How many candidates to try before giving up this round. */
  scan?: number;
  /** Optional ordering/selection hook for fair scheduling. */
  choose?: (candidates: QueueJob[]) => QueueJob[];
  /** Extra fields to set on claim (e.g. claimedByTab). */
  extra?: Prisma.QueueJobUpdateManyMutationInput;
}

/** Atomically claim the next runnable job, or null. */
export async function claimNext(options: ClaimOptions, client: Tx = db): Promise<QueueJob | null> {
  const now = options.now ?? new Date();
  let candidates = await client.queueJob.findMany({
    where: {
      queue: options.queue,
      status: 'WAITING',
      runAt: { lte: now },
      ...(options.kinds ? { kind: { in: options.kinds } } : {}),
      ...(options.excludeWebsiteIds?.length ? { OR: [{ websiteId: null }, { websiteId: { notIn: options.excludeWebsiteIds } }] } : {}),
    },
    orderBy: [{ priority: 'desc' }, { runAt: 'asc' }, { createdAt: 'asc' }],
    take: options.scan ?? 25,
  });
  if (options.choose) candidates = options.choose(candidates);
  for (const candidate of candidates) {
    const leaseUntil = new Date(now.getTime() + options.leaseMs);
    const result = await client.queueJob.updateMany({
      where: { id: candidate.id, status: 'WAITING' },
      data: {
        status: 'ACTIVE',
        lockedBy: options.owner,
        leaseUntil,
        heartbeatAt: now,
        attempts: { increment: 1 },
        startedAt: now,
        ...(options.extra ?? {}),
      },
    });
    if (result.count === 1) return client.queueJob.findUniqueOrThrow({ where: { id: candidate.id } });
  }
  return null;
}

/** Extend the lease of a job we own. Returns false if ownership was lost. */
export async function heartbeatJob(id: string, owner: string, leaseMs: number, client: Tx = db): Promise<boolean> {
  const now = new Date();
  const result = await client.queueJob.updateMany({
    where: { id, lockedBy: owner, status: 'ACTIVE' },
    data: { heartbeatAt: now, leaseUntil: new Date(now.getTime() + leaseMs) },
  });
  return result.count === 1;
}

export async function completeJob(id: string, owner: string | null, result: unknown = {}, client: Tx = db): Promise<boolean> {
  const res = await client.queueJob.updateMany({
    where: { id, status: 'ACTIVE', ...(owner ? { lockedBy: owner } : {}) },
    data: { status: 'COMPLETED', result: JSON.stringify(result ?? {}), finishedAt: new Date(), leaseUntil: null, error: null, errorCode: null },
  });
  return res.count === 1;
}

/**
 * Return a job to WAITING. `countAttempt: false` undoes the claim's attempt
 * increment (used when the job only waits for another job, e.g. ChatGPT).
 */
export async function releaseJob(
  id: string,
  owner: string | null,
  options: { runAt: Date; countAttempt?: boolean; error?: string | null; errorCode?: string | null; progress?: string | null },
  client: Tx = db,
): Promise<boolean> {
  const res = await client.queueJob.updateMany({
    where: { id, status: 'ACTIVE', ...(owner ? { lockedBy: owner } : {}) },
    data: {
      status: 'WAITING',
      runAt: options.runAt,
      lockedBy: null,
      leaseUntil: null,
      claimedByTab: null,
      ...(options.countAttempt === false ? { attempts: { decrement: 1 } } : {}),
      ...(options.error !== undefined ? { error: options.error } : {}),
      ...(options.errorCode !== undefined ? { errorCode: options.errorCode } : {}),
      ...(options.progress !== undefined ? { progress: options.progress } : {}),
    },
  });
  return res.count === 1;
}

/** Fail a job; if retryable and attempts remain, reschedule it instead. */
export async function failJob(
  id: string,
  owner: string | null,
  options: { error: string; errorCode?: string; retryable: boolean; retryAt?: Date },
  client: Tx = db,
): Promise<'retry' | 'failed' | 'lost'> {
  const job = await client.queueJob.findUnique({ where: { id } });
  if (!job || job.status !== 'ACTIVE' || (owner && job.lockedBy !== owner)) return 'lost';
  if (options.retryable && job.attempts < job.maxAttempts) {
    await releaseJob(id, owner, { runAt: options.retryAt ?? new Date(), error: options.error, errorCode: options.errorCode ?? 'ERROR' }, client);
    return 'retry';
  }
  await client.queueJob.updateMany({
    where: { id, status: 'ACTIVE' },
    data: { status: 'FAILED', error: options.error, errorCode: options.errorCode ?? 'ERROR', finishedAt: new Date(), leaseUntil: null },
  });
  return 'failed';
}

/** Cancel every WAITING job of a task; ACTIVE ones are told on their next check. */
export async function cancelWaitingJobsForTask(taskId: string, client: Tx = db): Promise<number> {
  const res = await client.queueJob.updateMany({
    where: { taskId, status: 'WAITING' },
    data: { status: 'CANCELLED', finishedAt: new Date(), error: 'Cancelled by the owner', errorCode: 'CANCELLED' },
  });
  return res.count;
}

/** Wake a sleeping article job for this task (e.g. after its ChatGPT answer arrived). */
export async function wakeArticleJob(taskId: string, client: Tx = db): Promise<number> {
  const res = await client.queueJob.updateMany({
    where: { taskId, queue: 'article', status: 'WAITING', runAt: { gt: new Date() } },
    data: { runAt: new Date() },
  });
  return res.count;
}

export function parsePayload<T>(job: Pick<QueueJob, 'payload'>): T {
  try {
    return JSON.parse(job.payload) as T;
  } catch {
    return {} as T;
  }
}
