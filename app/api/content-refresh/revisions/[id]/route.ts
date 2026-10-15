import { z } from 'zod';
import { route } from '@/lib/api';
import { updateRevision } from '@/lib/refresh/service';

/** Save the owner's edits to a proposed revision (sanitized; only while proposed). */
export const PUT = route({ body: z.object({ html: z.string().max(400_000), note: z.string().max(500).optional() }) }, async ({ params, body }) => updateRevision(params.id, body.html, body.note));
