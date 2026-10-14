import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { createWebsite } from '@/lib/websites';
import { audit } from '@/lib/audit';
import { z } from 'zod';

export const GET = route({}, async () => {
  const sites = await db.website.findMany({
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    include: { wordpressProfile: { select: { sessionState: true, lastCheckedAt: true } }, categories: { select: { id: true, name: true, externalId: true }, orderBy: { name: 'asc' } } },
  });
  return { websites: sites };
});

export const POST = route({ body: z.record(z.string(), z.unknown()) }, async ({ body }) => {
  const site = await createWebsite(body);
  await audit('website.create', 'Website', site.id, { name: site.name, publicUrl: site.publicUrl });
  return { website: site };
});
