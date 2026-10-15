import { route } from '@/lib/api';
import { bulkHealthCheck } from '@/lib/website-control';

/** Queue a session test for every active website (the worker runs them; nothing is typed). */
export const POST = route({}, async () => bulkHealthCheck());
