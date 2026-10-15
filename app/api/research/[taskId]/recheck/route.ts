import { route } from '@/lib/api';
import { scheduleRecheck } from '@/lib/research/service';

/** Fetch the cited sources again and rebuild the ledger (worker job). */
export const POST = route({}, async ({ params }) => scheduleRecheck(params.taskId));
