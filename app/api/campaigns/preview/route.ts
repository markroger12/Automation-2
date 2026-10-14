import { z } from 'zod';
import { route } from '@/lib/api';
import { previewCampaign } from '@/lib/campaigns/service';

/** Parse, validate, route and de-duplicate an import without writing anything. */
export const POST = route({ body: z.record(z.string(), z.unknown()) }, async ({ body }) => previewCampaign(body));
