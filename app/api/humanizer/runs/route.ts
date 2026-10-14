import { route } from '@/lib/api';
import { z } from 'zod';
import { createHumanizerRun, listHumanizerRuns } from '@/lib/humanizer/runs';

export const GET = route({}, async ({ searchParams }) => ({ runs: await listHumanizerRuns({ taskId: searchParams.get('taskId') ?? undefined }) }));

/** Queue a Humanizer run for a saved article or pasted text. */
export const POST = route({ body: z.record(z.string(), z.unknown()) }, async ({ body }) => {
  const run = await createHumanizerRun(body);
  return { run: { id: run.id, status: run.status, message: run.message } };
});
