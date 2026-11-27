import { route } from '@/lib/api';
import { rejectPostUpdate } from '@/lib/posts/service';

export const POST = route({}, async ({ params }) => rejectPostUpdate(params.id));
