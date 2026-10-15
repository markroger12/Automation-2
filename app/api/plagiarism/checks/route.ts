import { route } from '@/lib/api';
import { z } from 'zod';
import { createPlagiarismCheck, listPlagiarismChecks } from '@/lib/plagiarism/service';

export const GET = route({}, async ({ searchParams }) => ({ checks: await listPlagiarismChecks({ taskId: searchParams.get('taskId') ?? undefined }) }));

/** Queue a plagiarism evidence check for a saved article or pasted text. */
export const POST = route({ body: z.record(z.string(), z.unknown()) }, async ({ body }) => {
  const check = await createPlagiarismCheck(body);
  return { check: { id: check.id, status: check.status, message: check.message } };
});
