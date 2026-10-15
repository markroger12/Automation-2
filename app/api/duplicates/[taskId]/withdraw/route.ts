import { route } from '@/lib/api';
import { withdrawOverride } from '@/lib/duplicates/service';

export const POST = route({}, async ({ params }) => withdrawOverride(params.taskId));
