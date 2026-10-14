import { db, type Tx } from './db';
import { redact, redactString } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogInput {
  level?: LogLevel;
  category: string;
  message: string;
  taskId?: string | null;
  jobId?: string | null;
  stage?: string | null;
  details?: unknown;
  screenshotPath?: string | null;
}

const MAX_DETAILS = 16_000;

/** Persist a log row (secrets redacted). Logging never throws. */
export async function log(input: LogInput, client: Tx = db): Promise<void> {
  const level = input.level ?? 'info';
  const message = redactString(input.message).slice(0, 4000);
  let details: string | null = null;
  if (input.details !== undefined) {
    try {
      details = JSON.stringify(redact(input.details));
      if (details.length > MAX_DETAILS) details = details.slice(0, MAX_DETAILS) + '…';
    } catch {
      details = null;
    }
  }
  if (process.env.BAS_QUIET_LOGS !== '1') {
    const prefix = `[${new Date().toISOString()}] ${level.toUpperCase()} ${input.category}`;
    const line = `${prefix}${input.taskId ? ` task=${input.taskId}` : ''}${input.stage ? ` stage=${input.stage}` : ''}: ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else if (level !== 'debug' || process.env.BAS_DEBUG === '1') console.log(line);
  }
  try {
    await client.log.create({
      data: {
        level,
        category: input.category,
        message,
        taskId: input.taskId ?? null,
        jobId: input.jobId ?? null,
        stage: input.stage ?? null,
        details,
        screenshotPath: input.screenshotPath ?? null,
      },
    });
  } catch (error) {
    if (process.env.BAS_QUIET_LOGS !== '1') console.error('Failed to persist log row:', (error as Error).message);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return redactString(error.message);
  if (typeof error === 'string') return redactString(error);
  try {
    return redactString(JSON.stringify(error));
  } catch {
    return 'Unknown error';
  }
}
