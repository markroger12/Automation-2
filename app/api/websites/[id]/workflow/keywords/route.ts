import { z } from 'zod';
import { route } from '@/lib/api';
import { addKeywords } from '@/lib/workflow/service';

/** Append keywords to the workflow queue (duplicates left out unless kept explicitly). */
export const POST = route({ body: z.record(z.string(), z.unknown()) }, async ({ params, body }) => addKeywords(params.id, body));
