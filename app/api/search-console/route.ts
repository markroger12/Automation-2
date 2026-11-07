import { route } from '@/lib/api';
import { readKey } from '@/lib/gsc/client';
import { accessibleProperties, resolveWebsiteProperty } from '@/lib/gsc/property';

/**
 * Search Console connection: the service account (never its key) and, with ?test=1, the properties it can see. With
 * &websiteId=…, the website's property is detected from that list (a URL-prefix property when no domain property is
 * shared) and saved, so the page shows the one in use.
 */
export const GET = route({}, async ({ searchParams }) => {
  const key = readKey();
  if (!key) return { connected: false as const };
  const base = { connected: true as const, email: key.client_email, project: key.project_id ?? null };
  if (searchParams.get('test') !== '1') return base;
  const websiteId = searchParams.get('websiteId');
  if (websiteId) {
    const r = await resolveWebsiteProperty(websiteId, { fresh: true });
    return { ...base, properties: r.accessible ?? [], property: r.property, detectedFrom: r.detectedFrom ?? null };
  }
  return { ...base, properties: (await accessibleProperties(true)) ?? [] };
});
