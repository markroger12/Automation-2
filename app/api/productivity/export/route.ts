import { route } from '@/lib/api';
import { productivityCsv } from '@/lib/analytics/productivity';

/** CSV of verified drafts (with WordPress proof) or stage timings. */
export const GET = route({}, async ({ searchParams }) => {
  const view = searchParams.get('view') === 'stages' ? 'stages' : 'verified';
  const csv = await productivityCsv(view);
  return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="productivity-${view}.csv"`, 'Cache-Control': 'no-store' } });
});
