import { z } from 'zod';
import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { AppError, notFound } from '@/lib/errors';
import { audit } from '@/lib/audit';
import { PUBLISH_ACK_PHRASE } from '@/lib/websites';

const schema = z.object({
  canPublish: z.boolean(),
  allowLiveUpdates: z.boolean().optional(),
  acknowledgement: z.string().max(100).optional(),
});

/**
 * Site-scoped publication permission. Enabling requires typing the
 * acknowledgement phrase; every change is audited. Drafts remain the default.
 */
export const PUT = route({ body: schema }, async ({ params, body }) => {
  const site = await db.website.findUnique({ where: { id: params.id } });
  if (!site) throw notFound('Website');
  const enabling = (body.canPublish && !site.canPublish) || (body.allowLiveUpdates === true && !site.allowLiveUpdates);
  if (enabling && body.acknowledgement !== PUBLISH_ACK_PHRASE) {
    throw new AppError(400, 'ACK_REQUIRED', `Type "${PUBLISH_ACK_PHRASE}" to confirm that scheduled/live publishing may change this website.`);
  }
  const updated = await db.website.update({
    where: { id: site.id },
    data: {
      canPublish: body.canPublish,
      canPublishAcknowledgedAt: body.canPublish ? (site.canPublish ? site.canPublishAcknowledgedAt : new Date()) : null,
      allowLiveUpdates: body.canPublish ? (body.allowLiveUpdates ?? site.allowLiveUpdates) : false,
    },
  });
  await audit('website.publish-permission', 'Website', site.id, {
    from: { canPublish: site.canPublish, allowLiveUpdates: site.allowLiveUpdates },
    to: { canPublish: updated.canPublish, allowLiveUpdates: updated.allowLiveUpdates },
  });
  return { website: updated };
});
