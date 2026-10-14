import { route } from '@/lib/api';
import { exportCampaignCsv } from '@/lib/campaigns/service';

/** CSV of rows with draft links and SEO status. */
export const GET = route({}, async ({ params }) =>
  new Response(await exportCampaignCsv(params.id), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="campaign-${params.id}.csv"`, 'Cache-Control': 'no-store' } }),
);
