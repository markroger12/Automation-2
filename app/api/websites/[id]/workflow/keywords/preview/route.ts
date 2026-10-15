import { z } from 'zod';
import { route } from '@/lib/api';
import { previewKeywords } from '@/lib/workflow/service';

export const POST = route({ body: z.object({ text: z.string().max(2_000_000) }) }, async ({ params, body }) => previewKeywords(params.id, body.text));
