import { z } from 'zod';
import { route } from '@/lib/api';
import { resaveFailedWordPressTasks } from '@/lib/wordpress-resave';

const schema = z.object({ taskIds: z.array(z.string().min(1).max(40)).max(200).optional() });

/** Re-save articles that stopped at a WordPress step (retry from that step; audited). */
export const POST = route({ body: schema }, async ({ params, body }) => resaveFailedWordPressTasks(params.id, body.taskIds));
