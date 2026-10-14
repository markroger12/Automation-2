import { z } from 'zod';
import { route } from '@/lib/api';
import { restorePrompt } from '@/lib/prompts/manage';

export const POST = route({ body: z.object({ version: z.number().int().min(1).optional() }) }, async ({ params, body }) => restorePrompt(params.id, body));
