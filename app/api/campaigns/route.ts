import { z } from 'zod';
import { route } from '@/lib/api';
import { createCampaign, listCampaigns } from '@/lib/campaigns/service';

export const GET = route({}, async () => ({ campaigns: await listCampaigns() }));

/** Create a campaign from a reviewed import; READY rows are queued by the worker (idempotent per row). */
export const POST = route({ body: z.record(z.string(), z.unknown()) }, async ({ body }) => {
  const { campaign, summary } = await createCampaign(body);
  return { campaign: { id: campaign.id, name: campaign.name }, summary };
});
