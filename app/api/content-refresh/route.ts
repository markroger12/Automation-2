import { route } from '@/lib/api';
import { listRefreshCandidates } from '@/lib/refresh/service';

const STATUSES = ['OPEN', 'REVISION', 'APPLIED', 'DISMISSED', 'RESOLVED'];

export const GET = route({}, async ({ searchParams }) => {
  const status = searchParams.get('status');
  return { candidates: await listRefreshCandidates({ websiteId: searchParams.get('websiteId'), status: status && STATUSES.includes(status) ? status : null }) };
});
