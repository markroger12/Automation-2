import { z } from 'zod';
import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { AppError, notFound } from '@/lib/errors';
import { updateWebsite } from '@/lib/websites';
import { audit } from '@/lib/audit';

export const GET = route({}, async ({ params }) => {
  const site = await db.website.findUnique({
    where: { id: params.id },
    include: { wordpressProfile: true, categories: { orderBy: { name: 'asc' } } },
  });
  if (!site) throw notFound('Website');
  return { website: site };
});

export const PUT = route({ body: z.record(z.string(), z.unknown()) }, async ({ params, body }) => {
  const site = await updateWebsite(params.id, body);
  await audit('website.update', 'Website', site.id, { fields: Object.keys(body) });
  return { website: site };
});

/**
 * Deleting a website is allowed only when it has no tasks (history is never
 * deleted). Otherwise deactivate it. The browser profile folder is kept; use
 * "Delete profile" separately.
 */
export const DELETE = route({}, async ({ params }) => {
  const site = await db.website.findUnique({ where: { id: params.id }, include: { _count: { select: { tasks: true } } } });
  if (!site) throw notFound('Website');
  if (site._count.tasks > 0) {
    throw new AppError(409, 'HAS_TASKS', `This website has ${site._count.tasks} article(s). Deactivate it instead — article history is never deleted.`);
  }
  await db.website.delete({ where: { id: site.id } });
  if (site.wordpressProfileId) await db.browserProfile.delete({ where: { id: site.wordpressProfileId } }).catch(() => {});
  await audit('website.delete', 'Website', site.id, { name: site.name, profileFolderKept: true });
  return { ok: true };
});
