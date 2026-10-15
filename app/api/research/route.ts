import { route } from '@/lib/api';
import { listLedgers } from '@/lib/research/service';

/** Articles with an evidence ledger, newest research first. */
export const GET = route({}, async () => ({ ledgers: await listLedgers() }));
