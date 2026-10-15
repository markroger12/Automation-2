import { z } from 'zod';
import { db } from '@/lib/db';
import { AppError, badRequest, notFound } from '@/lib/errors';
import { audit } from '@/lib/audit';
import { enqueue } from '@/lib/queue';
import { parseJson } from '@/lib/json';
import { parseSiteOverrides } from '@/lib/settings';
import { parseSiteImageSettings } from '@/lib/image-template';
import { siteHealth } from '@/lib/site-health';
import { statusGroup, type StatusGroup } from '@/lib/domain';

/**
 * Multi-Website Control Center (upgrade 14): one grid of every website with
 * its isolation-relevant settings and measured health, per-site pause /
 * quota / priority, bulk session checks and cloning of SAFE settings.
 * Never cloned: URLs, the WordPress profile (credentials live there),
 * categories, publishing permission, Search Console property, operational
 * state — and text in another language.
 */

export async function websiteGrid(now = new Date()) {
  const sites = await db.website.findMany({
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    include: { wordpressProfile: { select: { sessionState: true, lastCheckedAt: true } }, _count: { select: { categories: true, linkTargets: true } }, workflows: { select: { active: true, slots: true }, take: 1 } },
  });
  const grouped = await db.articleTask.groupBy({ by: ['websiteId', 'status'], _count: { _all: true } });
  const since = new Date(now.getTime() - 7 * 24 * 3600_000);
  const verified = await db.productionMetric.groupBy({ by: ['websiteId'], where: { kind: 'ARTICLE_VERIFIED', endedAt: { gt: since } }, _count: { _all: true } });
  const categoryNames = new Map((await db.category.findMany({ where: { id: { in: sites.map((s) => s.defaultCategoryId).filter((x): x is string => Boolean(x)) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  return Promise.all(
    sites.map(async (s) => {
      const counts: Record<StatusGroup, number> = { queued: 0, running: 0, review: 0, paused: 0, draft: 0, failed: 0, cancelled: 0 };
      for (const g of grouped.filter((x) => x.websiteId === s.id)) counts[statusGroup(g.status)] += g._count._all;
      const overrides = parseSiteOverrides(s.settingsOverrides);
      const images = parseSiteImageSettings(s.imageSettings);
      const health = await siteHealth(s.id, now);
      const wf = s.workflows[0];
      return {
        id: s.id,
        name: s.name,
        publicUrl: s.publicUrl,
        language: s.language,
        timezone: s.timezone,
        active: s.active,
        paused: s.paused,
        priority: s.priority,
        queueQuota: s.queueQuota,
        canPublish: s.canPublish,
        allowLiveUpdates: s.allowLiveUpdates,
        session: s.wordpressProfile?.sessionState ?? 'NO PROFILE',
        sessionCheckedAt: s.wordpressProfile?.lastCheckedAt?.toISOString() ?? null,
        health: { overall: health.overall, reason: health.reasons[0] ?? null },
        categories: s._count.categories,
        defaultCategory: s.defaultCategoryId ? (categoryNames.get(s.defaultCategoryId) ?? null) : null,
        editor: s.editorType === 'AUTO' ? `auto (${s.detectedEditor?.toLowerCase() ?? 'not detected'})` : s.editorType.toLowerCase(),
        internalLinkLine: s.internalLinkLine,
        linkIndex: s._count.linkTargets,
        imageTemplate: { name: images.featured.name, bodyTemplate: Boolean(images.body), logo: Boolean(images.logoAssetId) },
        promptOverrides: Object.keys(parseJson<Record<string, string>>(s.promptOverrides, {})).length,
        routingRules: parseJson<unknown[]>(s.routingRules, []).length,
        rankMath: { mode: (overrides.seo as { rankMathMode?: string }).rankMathMode ?? 'default', target: s.rankMathTarget },
        searchConsoleProperty: s.searchConsoleProperty,
        workflow: wf ? { active: wf.active, slots: parseJson<string[]>(wf.slots, []).length } : null,
        counts,
        verified7d: verified.find((v) => v.websiteId === s.id)?._count._all ?? 0,
      };
    }),
  );
}

export const controlsSchema = z.object({
  paused: z.boolean().optional(),
  priority: z.number().int().min(-10).max(10).optional(),
  queueQuota: z.number().int().min(0).max(20).optional(),
});

/** Pause/resume, priority and the per-site limit of articles in progress (0 = no limit). Audited. */
export async function updateSiteControls(websiteId: string, raw: unknown) {
  const input = controlsSchema.parse(raw);
  const site = await db.website.findUnique({ where: { id: websiteId } });
  if (!site) throw notFound('Website');
  const updated = await db.website.update({ where: { id: websiteId }, data: input });
  await audit('website.controls', 'Website', websiteId, { from: { paused: site.paused, priority: site.priority, queueQuota: site.queueQuota }, to: input });
  return { paused: updated.paused, priority: updated.priority, queueQuota: updated.queueQuota };
}

/** Queue a session test for every active website with a WordPress profile (one at a time per site; never types credentials). */
export async function bulkHealthCheck() {
  const sites = await db.website.findMany({ where: { active: true, wordpressProfileId: { not: null } }, select: { id: true } });
  let queued = 0;
  for (const s of sites) {
    const live = await db.queueJob.findFirst({ where: { queue: 'control', kind: 'wp.test', websiteId: s.id, status: { in: ['WAITING', 'ACTIVE'] } } });
    if (live) continue;
    const n = await db.queueJob.count({ where: { queue: 'control', kind: 'wp.test', websiteId: s.id } });
    await enqueue({ queue: 'control', kind: 'wp.test', websiteId: s.id, idempotencyKey: `wp.test:${s.id}:${n + 1}`, payload: { websiteId: s.id }, maxAttempts: 1 });
    queued++;
  }
  await audit('website.bulk-health-check', 'Website', 'all', { queued, sites: sites.length });
  return { queued, sites: sites.length };
}

/** Settings that may be copied between websites. */
export const CLONE_FIELDS = {
  settingsOverrides: 'Content, SEO and workflow overrides',
  routingRules: 'Writer rules',
  rankMathTarget: 'Rank Math target',
  imageSettings: 'Image template (design only)',
  internalLinkLine: 'Internal-link line (same language only)',
  promptOverrides: 'Prompt overrides (same language only)',
} as const;
export type CloneField = keyof typeof CLONE_FIELDS;
const LANGUAGE_BOUND: CloneField[] = ['internalLinkLine', 'promptOverrides'];

export const cloneSchema = z.object({
  sourceId: z.string().min(1).max(40),
  targetIds: z.array(z.string().min(1).max(40)).min(1).max(100),
  fields: z.array(z.enum(Object.keys(CLONE_FIELDS) as [CloneField, ...CloneField[]])).min(1),
});

export async function cloneSettings(raw: unknown) {
  const input = cloneSchema.parse(raw);
  const source = await db.website.findUnique({ where: { id: input.sourceId } });
  if (!source) throw notFound('Source website');
  if (input.targetIds.includes(source.id)) throw badRequest('A website cannot be its own target.');
  const targets = await db.website.findMany({ where: { id: { in: input.targetIds } } });
  if (targets.length !== new Set(input.targetIds).size) throw new AppError(404, 'NOT_FOUND', 'A target website no longer exists.');
  // The design is copied; the source's own logo and fixed photos stay with the source (each site has its own media).
  const images = parseSiteImageSettings(source.imageSettings);
  const stripAssets = <T extends { layers: { type: string }[] }>(t: T): T => ({ ...t, layers: t.layers.filter((l) => l.type !== 'fixed-photo') });
  const portableImages = JSON.stringify({ featured: stripAssets(images.featured), body: images.body ? stripAssets(images.body) : null, logoAssetId: null });
  const results: { websiteId: string; name: string; copied: CloneField[]; skipped: { field: CloneField; reason: string }[] }[] = [];
  for (const t of targets) {
    const data: Record<string, unknown> = {};
    const copied: CloneField[] = [];
    const skipped: { field: CloneField; reason: string }[] = [];
    for (const f of input.fields) {
      if (LANGUAGE_BOUND.includes(f) && t.language !== source.language) {
        skipped.push({ field: f, reason: `${t.name} writes in ${t.language === 'de' ? 'German' : 'English'}, ${source.name} in ${source.language === 'de' ? 'German' : 'English'}` });
        continue;
      }
      data[f] = f === 'imageSettings' ? portableImages : source[f];
      copied.push(f);
    }
    if (copied.length) await db.website.update({ where: { id: t.id }, data });
    results.push({ websiteId: t.id, name: t.name, copied, skipped });
  }
  await audit('website.clone-settings', 'Website', source.id, { targets: results.map((r) => ({ id: r.websiteId, copied: r.copied, skipped: r.skipped.map((s) => s.field) })) });
  return { results };
}
