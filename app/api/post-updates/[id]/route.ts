import { route } from '@/lib/api';
import { getPostUpdate } from '@/lib/posts/service';

export const GET = route({}, async ({ params }) => getPostUpdate(params.id));
