import { route } from '@/lib/api';
import { getRefreshCandidate } from '@/lib/refresh/service';

export const GET = route({}, async ({ params }) => getRefreshCandidate(params.id));
