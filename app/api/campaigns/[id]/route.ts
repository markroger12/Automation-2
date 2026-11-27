import { route } from '@/lib/api';
import { z } from 'zod';
import { deleteCampaign, getCampaign } from '@/lib/campaigns/service';

export const GET = route({}, async ({ params }) => {
  const { inputText, ...campaign } = await getCampaign(params.id);
  return { campaign: { ...campaign, inputLength: inputText.length } };
});

/** Deletes the campaign; `articles: true` deletes its articles from the app as well (WordPress is not changed). */
export const DELETE = route({ body: z.object({ articles: z.boolean().default(false) }) }, async ({ params, body }) => deleteCampaign(params.id, body.articles));
