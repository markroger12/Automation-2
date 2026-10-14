import { route } from '@/lib/api';
import { pauseCampaign } from '@/lib/campaigns/service';

export const POST = route({}, async ({ params }) => pauseCampaign(params.id));
