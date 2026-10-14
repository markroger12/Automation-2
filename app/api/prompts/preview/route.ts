import { z } from 'zod';
import { route } from '@/lib/api';
import { previewPrompts } from '@/lib/prompts/preview';

export const POST = route({ body: z.record(z.string(), z.unknown()) }, async ({ body }) => previewPrompts(body));
