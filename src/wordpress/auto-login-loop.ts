import { db } from '@/lib/db';
import { errorMessage, log } from '@/lib/log';
import { autoLoginIfSaved } from './session';

/**
 * Worker loop (every 5 min): websites whose WordPress session ended and that have a saved sign-in are signed in again
 * by themselves; articles paused for the sign-in then resume (session.ts → recordSession). The same limits as in a
 * job: once per website every 10 minutes, never again after a refused password or a step only the owner can do.
 */
export async function autoLoginTick(): Promise<number> {
  const sites = await db.website.findMany({ where: { active: true, wordpressProfile: { sessionState: 'LOGIN_REQUIRED' } } });
  let signedIn = 0;
  for (const site of sites) {
    try {
      if (await autoLoginIfSaved(site)) signedIn++;
    } catch (error) {
      await log({ level: 'warn', category: 'wordpress', message: `${site.name}: automatic login failed: ${errorMessage(error)}` });
    }
  }
  return signedIn;
}
