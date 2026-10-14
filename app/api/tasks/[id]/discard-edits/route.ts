import { route } from '@/lib/api';
import { discardEdits } from '@/lib/tasks/actions';

export const POST = route({}, async ({ params }) => discardEdits(params.id));
