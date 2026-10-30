import { route } from '@/lib/api';
import { updateInfo } from '@/lib/update/service';

export const dynamic = 'force-dynamic';

/** The running version and the last update's progress (Settings → App updates polls it during an update). */
export const GET = route({}, async () => updateInfo());
