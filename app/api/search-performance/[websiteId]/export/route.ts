import { route } from '@/lib/api';
import { exportSearchCsv } from '@/lib/search-performance/service';

const VIEWS = ['pages', 'queries', 'declining', 'zero'] as const;

/** CSV export of the imported data (values exactly as imported). */
export const GET = route({}, async ({ params, searchParams }) => {
  const v = searchParams.get('view') ?? 'pages';
  const view = (VIEWS as readonly string[]).includes(v) ? (v as (typeof VIEWS)[number]) : 'pages';
  const csv = await exportSearchCsv(params.websiteId, view);
  return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="search-${view}.csv"`, 'Cache-Control': 'no-store' } });
});
