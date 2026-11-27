import { z } from 'zod';
import { route } from '@/lib/api';
import { approvePostUpdate } from '@/lib/posts/service';

/** Approve: the worker writes it to the same post (a live post needs the website's switch and the typed words). */
export const POST = route({ body: z.object({ acknowledgement: z.string().max(100).optional() }) }, async ({ params, body }) => approvePostUpdate(params.id, body.acknowledgement));
