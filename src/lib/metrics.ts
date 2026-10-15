import { Prisma } from '@prisma/client';
import { db, type Tx } from './db';
import { APP_VERSION } from './version';

export interface MetricInput {
  kind: string;
  taskId?: string | null;
  stageKey?: string | null;
  moduleKey?: string | null;
  websiteId?: string | null;
  attempt?: number;
  outcome: string;
  startedAt: Date;
  endedAt: Date;
  waitMs?: number;
  details?: Record<string, unknown>;
  /** Unique key: the same event is never counted twice (retries, restarts). */
  dedupeKey: string;
}

export async function recordMetric(input: MetricInput, client: Tx = db): Promise<boolean> {
  // Look first so the common duplicate case does not produce Prisma error logs.
  if (await client.productionMetric.findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true } })) return false;
  try {
    await client.productionMetric.create({
      data: {
        kind: input.kind,
        taskId: input.taskId ?? null,
        stageKey: input.stageKey ?? null,
        moduleKey: input.moduleKey ?? null,
        websiteId: input.websiteId ?? null,
        attempt: input.attempt ?? 1,
        outcome: input.outcome,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        durationMs: Math.max(0, input.endedAt.getTime() - input.startedAt.getTime()),
        waitMs: input.waitMs ?? 0,
        // The app version lets stage times be compared per release (regression baselines).
        details: JSON.stringify({ version: APP_VERSION, ...(input.details ?? {}) }),
        dedupeKey: input.dedupeKey,
      },
    });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
    throw error;
  }
}
