import { route } from '@/lib/api';
import { rejectRevision } from '@/lib/refresh/service';

export const POST = route({}, async ({ params }) => rejectRevision(params.id));
