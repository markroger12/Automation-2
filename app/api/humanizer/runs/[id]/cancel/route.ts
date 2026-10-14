import { route } from '@/lib/api';
import { cancelHumanizerRun } from '@/lib/humanizer/runs';

export const POST = route({}, async ({ params }) => cancelHumanizerRun(params.id));
