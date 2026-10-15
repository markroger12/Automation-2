import { route } from '@/lib/api';
import { listDuplicateReviews } from '@/lib/duplicates/service';

/** Articles whose wording overlaps another saved article (HIGH/MEDIUM), with the evidence. */
export const GET = route({}, async ({ searchParams }) => {
  const s = searchParams.get('status');
  const status = s === 'OVERRIDDEN' || s === 'ALL' ? s : 'OPEN';
  return { reviews: await listDuplicateReviews({ status, websiteId: searchParams.get('websiteId') ?? undefined }) };
});
