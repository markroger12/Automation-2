import { route } from '@/lib/api';
import { badRequest } from '@/lib/errors';
import { listSitePosts } from '@/lib/posts/service';
import { POST_LENGTHS, POST_SORTS, POST_SOURCES, UPDATE_STATES, type PostLength, type PostSort, type PostSource, type UpdateState } from '@/lib/posts/list-view';

/** The website's posts read for “Update to latest”: filtered, sorted, one page (lib/posts/list-view.ts). */
export const GET = route({}, async ({ searchParams }) => {
  const websiteId = searchParams.get('websiteId');
  if (!websiteId) throw badRequest('Choose a website.');
  const num = (k: string) => {
    const v = Number(searchParams.get(k));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
  };
  const one = <T extends string>(k: string, allowed: readonly T[]): T | null => {
    const v = searchParams.get(k);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : null;
  };
  return listSitePosts({
    websiteId,
    q: searchParams.get('q'),
    state: one<UpdateState>('state', UPDATE_STATES),
    olderThanMonths: num('older'),
    categoryId: num('category'),
    year: num('year'),
    length: one<PostLength>('length', POST_LENGTHS),
    source: one<PostSource>('source', POST_SOURCES),
    sort: one<PostSort>('sort', POST_SORTS),
    page: num('page') ?? 1,
    pageSize: num('pageSize') ?? 20,
  });
});
