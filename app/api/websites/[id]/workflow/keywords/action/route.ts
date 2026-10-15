import { z } from 'zod';
import { route } from '@/lib/api';
import { keywordAction } from '@/lib/workflow/service';

export const POST = route({ body: z.record(z.string(), z.unknown()) }, async ({ params, body }) => keywordAction(params.id, body));
