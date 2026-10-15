import { route } from '@/lib/api';
import { badRequest } from '@/lib/errors';
import { searchPerformance } from '@/lib/search-performance/service';

/** Imported Search Console data of one website (NOT_CONNECTED / NO_DATA / DATA). */
export const GET = route({}, async ({ searchParams }) => {
  const websiteId = searchParams.get('websiteId');
  if (!websiteId) throw badRequest('websiteId is required.');
  return searchPerformance(websiteId);
});
