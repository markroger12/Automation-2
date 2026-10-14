import { route } from '@/lib/api';
import { resumeCampaign } from '@/lib/campaigns/service';

export const POST = route({}, async ({ params }) => resumeCampaign(params.id));
