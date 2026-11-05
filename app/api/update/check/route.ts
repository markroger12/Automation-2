import { route } from '@/lib/api';
import { checkForUpdates } from '@/lib/update/service';
import { rememberManualCheck } from '@/lib/update/auto-check';

export const dynamic = 'force-dynamic';

/** Ask GitHub (git fetch) whether the branch has a newer version, and what it changes. The bell follows the answer. */
export const POST = route({}, async () => {
  const check = await checkForUpdates();
  await rememberManualCheck(check).catch(() => undefined);
  return check;
});
