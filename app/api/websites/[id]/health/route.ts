import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { notFound } from '@/lib/errors';
import { siteHealth } from '@/lib/site-health';
import { failedWordPressTasks } from '@/lib/wordpress-resave';

/** Measured WordPress health of one website plus the articles waiting for a re-save. */
export const GET = route({}, async ({ params }) => {
  if (!(await db.website.findUnique({ where: { id: params.id }, select: { id: true } }))) throw notFound('Website');
  const [health, failed] = await Promise.all([siteHealth(params.id), failedWordPressTasks(params.id)]);
  return { health, failed };
});
