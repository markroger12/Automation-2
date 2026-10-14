import { route } from '@/lib/api';
import { getHumanizerRun } from '@/lib/humanizer/runs';

export const GET = route({}, async ({ params }) => ({ run: await getHumanizerRun(params.id) }));
