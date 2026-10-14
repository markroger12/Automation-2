import { route } from '@/lib/api';
import { allowDuplicate } from '@/lib/tasks/actions';

export const POST = route({}, async ({ params }) => allowDuplicate(params.id));
