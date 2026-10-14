import { z } from 'zod';
import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { AppError, notFound } from '@/lib/errors';
import { enqueue } from '@/lib/queue';
import { audit } from '@/lib/audit';

const ACTIONS = ['login', 'test', 'refresh', 'sync-categories', 'detect-editor', 'open-browser', 'reset-session', 'delete-profile'] as const;
const schema = z.object({ action: z.enum(ACTIONS), confirm: z.string().max(100).optional() });

/** Queue a WordPress session action for the worker (only the worker opens browsers). */
export const POST = route({ body: schema }, async ({ params, body }) => {
  const site = await db.website.findUnique({ where: { id: params.id } });
  if (!site) throw notFound('Website');
  if (body.action === 'delete-profile' && body.confirm !== site.slug) {
    throw new AppError(400, 'CONFIRMATION_REQUIRED', `Type the profile name "${site.slug}" to delete the browser profile folder.`);
  }
  if (body.action === 'reset-session' && body.confirm !== 'RESET') {
    throw new AppError(400, 'CONFIRMATION_REQUIRED', 'Confirm the session reset.');
  }
  const kind = `wp.${body.action}`;
  const live = await db.queueJob.findFirst({ where: { queue: 'control', kind, websiteId: site.id, status: { in: ['WAITING', 'ACTIVE'] } } });
  if (live) return { jobId: live.id, existing: true };
  const count = await db.queueJob.count({ where: { queue: 'control', kind, websiteId: site.id } });
  const { job } = await enqueue({ queue: 'control', kind, websiteId: site.id, idempotencyKey: `${kind}:${site.id}:${count + 1}`, payload: { websiteId: site.id }, maxAttempts: 1 });
  if (body.action === 'reset-session' || body.action === 'delete-profile') await audit(`website.${body.action}.requested`, 'Website', site.id, {});
  return { jobId: job.id, existing: false };
});
