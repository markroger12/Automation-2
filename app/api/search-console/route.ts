import { route } from '@/lib/api';
import { listProperties, readKey } from '@/lib/gsc/client';

/** Search Console connection: the service account (never its key) and, with ?test=1, the properties it can see. */
export const GET = route({}, async ({ searchParams }) => {
  const key = readKey();
  if (!key) return { connected: false as const };
  const base = { connected: true as const, email: key.client_email, project: key.project_id ?? null };
  if (searchParams.get('test') !== '1') return base;
  return { ...base, properties: await listProperties() };
});
