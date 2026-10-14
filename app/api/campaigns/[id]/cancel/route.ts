import { route } from '@/lib/api';
import { cancelCampaign } from '@/lib/campaigns/service';

export const POST = route({}, async ({ params }) => cancelCampaign(params.id));
