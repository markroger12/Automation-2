import { route } from '@/lib/api';
import { getLedger } from '@/lib/research/service';

export const GET = route({}, async ({ params }) => getLedger(params.taskId));
