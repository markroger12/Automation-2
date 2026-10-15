import { z } from 'zod';
import { route } from '@/lib/api';
import { dismissCandidate } from '@/lib/refresh/service';

export const POST = route({ body: z.object({ note: z.string().max(500) }) }, async ({ params, body }) => dismissCandidate(params.id, body.note));
