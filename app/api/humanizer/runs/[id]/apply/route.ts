import { route } from '@/lib/api';
import { applyHumanizerRun } from '@/lib/humanizer/runs';

/** Apply a finished run to its article as an owner edit. Never touches the WordPress draft. */
export const POST = route({}, async ({ params }) => applyHumanizerRun(params.id));
