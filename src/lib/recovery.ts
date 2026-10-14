import { Prisma } from '@prisma/client';
import { db, type Tx } from './db';
import { log } from './log';

export interface IncidentInput {
  kind: string;
  severity?: 'info' | 'warning' | 'critical';
  status?: 'OPEN' | 'AUTO_RESOLVED';
  jobId?: string | null;
  taskId?: string | null;
  stageKey?: string | null;
  description: string;
  evidence?: Record<string, unknown>;
  resolution?: string;
  dedupeKey: string;
}

/** Record a recovery incident once (deduplicated). */
export async function openIncident(input: IncidentInput, client: Tx = db): Promise<void> {
  try {
    await client.recoveryIncident.create({
      data: {
        kind: input.kind,
        severity: input.severity ?? 'warning',
        status: input.status ?? 'OPEN',
        jobId: input.jobId ?? null,
        taskId: input.taskId ?? null,
        stageKey: input.stageKey ?? null,
        description: input.description.slice(0, 2000),
        evidence: JSON.stringify(input.evidence ?? {}),
        resolution: input.resolution ?? null,
        resolvedAt: input.status === 'AUTO_RESOLVED' ? new Date() : null,
        dedupeKey: input.dedupeKey,
      },
    });
    await log({ level: input.severity === 'critical' ? 'error' : 'warn', category: 'recovery', taskId: input.taskId, stage: input.stageKey, message: `${input.kind}: ${input.description}` }, client);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
    throw error;
  }
}
