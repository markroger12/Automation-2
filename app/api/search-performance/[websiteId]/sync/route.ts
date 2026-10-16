import { route } from '@/lib/api';
import { syncWebsite } from '@/lib/gsc/sync';

/** “Sync now”: fetch the live Search Console data of this website. */
export const POST = route({}, async ({ params }) => {
  const r = await syncWebsite(params.websiteId);
  return { ok: true, at: r.at, days: r.days, pages: r.pages, queries: r.queries, hours: r.hours };
});
