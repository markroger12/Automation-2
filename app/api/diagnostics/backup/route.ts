import path from 'node:path';
import { z } from 'zod';
import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { createBackup } from '@/lib/backup';
import { audit } from '@/lib/audit';

export const POST = route({ body: z.object({ media: z.boolean().default(false) }) }, async ({ body }) => {
  const dir = await createBackup(db, 'dashboard', { media: body.media });
  await audit('backup.create', 'Backup', path.basename(dir), { media: body.media });
  return { ok: true, name: path.basename(dir) };
});
