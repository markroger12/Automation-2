import { route } from '@/lib/api';
import { getCampaign } from '@/lib/campaigns/service';

export const GET = route({}, async ({ params }) => {
  const { inputText, ...campaign } = await getCampaign(params.id);
  return { campaign: { ...campaign, inputLength: inputText.length } };
});
