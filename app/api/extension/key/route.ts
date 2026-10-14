import { route } from '@/lib/api';
import { connectionKeyInfo, createConnectionKey } from '@/lib/agent/keys';

export const GET = route({}, async () => connectionKeyInfo());

/** Create or rotate the connection key. The key is returned ONCE and never stored in clear text. */
export const POST = route({}, async () => {
  const created = await createConnectionKey();
  return { ...created, notice: 'Copy this key now — it will not be shown again. Rotating invalidates previously paired extensions.' };
});
