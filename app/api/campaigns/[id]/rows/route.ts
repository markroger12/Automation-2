import { z } from 'zod';
import { route } from '@/lib/api';
import { campaignRowAction } from '@/lib/campaigns/service';

/** Bulk row actions: retry, reprioritize, or correct rows that are not queued yet. */
export const POST = route({ body: z.record(z.string(), z.unknown()) }, async ({ params, body }) => campaignRowAction(params.id, body));
