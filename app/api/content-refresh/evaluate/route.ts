import { z } from 'zod';
import { route } from '@/lib/api';
import { requestEvaluation } from '@/lib/refresh/service';

/** Queue a refresh evaluation of one website (read-only; fetches the linked pages). */
export const POST = route({ body: z.object({ websiteId: z.string().min(1).max(40) }) }, async ({ body }) => requestEvaluation(body.websiteId));
