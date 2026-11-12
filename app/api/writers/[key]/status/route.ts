import { z } from 'zod';
import { route } from '@/lib/api';
import { setWriterStatus } from '@/lib/writers/store';

/** Active (offered everywhere), Draft (only on its page) or Archived (hidden; its articles still finish). */
export const POST = route({ body: z.object({ status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']) }) }, async ({ params, body }) => setWriterStatus(params.key, body.status));
