import { route } from '@/lib/api';
import { checkForUpdates } from '@/lib/update/service';

export const dynamic = 'force-dynamic';

/** Ask GitHub (git fetch) whether the branch has a newer version, and what it changes. */
export const POST = route({}, async () => checkForUpdates());
