import { route } from '@/lib/api';
import { badRequest } from '@/lib/errors';
import { listSitePosts } from '@/lib/posts/service';

/** The website's posts read for “Update to latest”, oldest change first. */
export const GET = route({}, async ({ searchParams }) => {
  const websiteId = searchParams.get('websiteId');
  if (!websiteId) throw badRequest('Choose a website.');
  const num = (k: string) => {
    const v = Number(searchParams.get(k));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
  };
  return listSitePosts({ websiteId, q: searchParams.get('q'), olderThanMonths: num('older'), page: num('page') ?? 1, pageSize: num('pageSize') ?? 25 });
});
