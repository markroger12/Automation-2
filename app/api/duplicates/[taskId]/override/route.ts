import { z } from 'zod';
import { route } from '@/lib/api';
import { overrideDuplicates } from '@/lib/duplicates/service';

/** Keep the article despite the overlap; the reason is recorded in the audit log. */
export const POST = route({ body: z.record(z.string(), z.unknown()) }, async ({ params, body }) => overrideDuplicates(params.taskId, body));
