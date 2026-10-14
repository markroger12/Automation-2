import { db } from './db';
import { statusGroup, type StatusGroup } from './domain';

export type GroupCounts = Record<StatusGroup | 'total', number>;

/** Count tasks per dashboard status group from real rows (legacy rows included). */
export async function taskGroupCounts(where: { websiteId?: string } = {}): Promise<GroupCounts> {
  const rows = await db.articleTask.groupBy({ by: ['status'], _count: { _all: true }, where });
  const counts: GroupCounts = { total: 0, queued: 0, running: 0, review: 0, paused: 0, draft: 0, failed: 0, cancelled: 0 };
  for (const row of rows) {
    counts[statusGroup(row.status)] += row._count._all;
    counts.total += row._count._all;
  }
  return counts;
}

export async function siteSummaries() {
  const sites = await db.website.findMany({
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    include: { wordpressProfile: { select: { sessionState: true, lastCheckedAt: true } }, _count: { select: { categories: true } } },
  });
  const grouped = await db.articleTask.groupBy({ by: ['websiteId', 'status'], _count: { _all: true } });
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const verified24h = await db.articleTask.groupBy({
    by: ['websiteId'],
    _count: { _all: true },
    where: { verifiedCompleteAt: { gte: since } },
  });
  return sites.map((site) => {
    const counts: Record<StatusGroup, number> = { queued: 0, running: 0, review: 0, paused: 0, draft: 0, failed: 0, cancelled: 0 };
    for (const g of grouped.filter((x) => x.websiteId === site.id)) counts[statusGroup(g.status)] += g._count._all;
    return {
      id: site.id,
      name: site.name,
      language: site.language,
      active: site.active,
      paused: site.paused,
      canPublish: site.canPublish,
      sessionState: site.wordpressProfile?.sessionState ?? 'UNKNOWN',
      sessionCheckedAt: site.wordpressProfile?.lastCheckedAt ?? null,
      categories: site._count.categories,
      counts,
      verified24h: verified24h.find((v) => v.websiteId === site.id)?._count._all ?? 0,
    };
  });
}
