import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';

/** Multi-Website Control Center (upgrade 14): isolation, safe cloning, controls. */
let client: PrismaClient;
let control: typeof import('@/lib/website-control');
const ids: Record<string, string> = {};

beforeAll(async () => {
  ({ client } = await setupTestDb());
  control = await import('@/lib/website-control');
  const websites = await import('@/lib/websites');
  for (const [key, name, lang] of [['en', 'Celeb News', 'en'], ['en2', 'Star Daily', 'en'], ['de', 'Promi Welt', 'de']] as const) {
    ids[key] = (await websites.createWebsite({ name, publicUrl: `https://${key}.example`, language: lang, targetCountry: lang === 'de' ? 'Germany' : 'United States', timezone: lang === 'de' ? 'Europe/Berlin' : 'America/New_York' })).id;
    // The same WordPress category ID on every site (category collision).
    await client.category.create({ data: { websiteId: ids[key], externalId: 7, name: lang === 'de' ? 'Promis' : 'Stars' } });
  }
  const { defaultSiteImageSettings } = await import('@/lib/image-template');
  const design = defaultSiteImageSettings('#e11d48');
  design.featured.layers.push({ id: 'fixed1', name: 'Fixed', type: 'fixed-photo', assetId: 'asset-of-celeb', x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, visible: true, locked: false, radius: 0 });
  await client.website.update({
    where: { id: ids.en },
    data: {
      settingsOverrides: JSON.stringify({ content: { faqCount: 6 }, seo: { rankMathMode: 'off' }, workflow: {} }),
      routingRules: JSON.stringify([{ contains: 'net worth', writer: 'celebrity-writer' }]),
      rankMathTarget: 85,
      internalLinkLine: 'Read more:',
      promptOverrides: JSON.stringify({ 'celebrity-writer:TITLES': 'Custom English title prompt' }),
      imageSettings: JSON.stringify({ ...design, logoAssetId: 'logo-of-celeb' }),
      canPublish: true,
      canPublishAcknowledgedAt: new Date(),
      searchConsoleProperty: 'sc-domain:en.example',
    },
  });
});

describe('Website Control Center', () => {
  it('shows every website with its own settings, health and counts', async () => {
    const grid = await control.websiteGrid();
    expect(grid.map((g) => [g.name, g.language, g.categories, g.canPublish, g.health.overall])).toEqual([
      ['Celeb News', 'en', 1, true, 'UNKNOWN'],
      ['Promi Welt', 'de', 1, false, 'UNKNOWN'],
      ['Star Daily', 'en', 1, false, 'UNKNOWN'],
    ]);
    const en = grid.find((g) => g.id === ids.en)!;
    expect(en).toMatchObject({ internalLinkLine: 'Read more:', promptOverrides: 1, routingRules: 1, rankMath: { mode: 'off', target: 85 }, searchConsoleProperty: 'sc-domain:en.example', imageTemplate: { logo: true } });
  });

  it('a task can only use a category of its own website (same WordPress ID on another site)', async () => {
    const create = await import('@/lib/tasks/create');
    const deCategory = await client.category.findFirstOrThrow({ where: { websiteId: ids.de } });
    await expect(create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'Tom Kaulitz', websiteId: ids.en, categoryId: deCategory.id, idempotencyKey: 'control:collision' }, { source: 'SINGLE' })).rejects.toThrow();
    expect(await client.articleTask.count()).toBe(0);
  });

  it('copies safe settings only: other-language text is skipped, design without the source media, never permissions or identity', async () => {
    const res = await control.cloneSettings({ sourceId: ids.en, targetIds: [ids.de, ids.en2], fields: ['settingsOverrides', 'routingRules', 'rankMathTarget', 'imageSettings', 'internalLinkLine', 'promptOverrides'] });
    const de = res.results.find((r) => r.websiteId === ids.de)!;
    expect(de.copied).toEqual(['settingsOverrides', 'routingRules', 'rankMathTarget', 'imageSettings']);
    expect(de.skipped.map((s) => [s.field, s.reason])).toEqual([
      ['internalLinkLine', 'Promi Welt writes in German, Celeb News in English'],
      ['promptOverrides', 'Promi Welt writes in German, Celeb News in English'],
    ]);
    const en2 = res.results.find((r) => r.websiteId === ids.en2)!;
    expect(en2.skipped).toEqual([]);
    const [deSite, en2Site] = await Promise.all([client.website.findUniqueOrThrow({ where: { id: ids.de } }), client.website.findUniqueOrThrow({ where: { id: ids.en2 } })]);
    expect(JSON.parse(deSite.settingsOverrides)).toMatchObject({ content: { faqCount: 6 }, seo: { rankMathMode: 'off' } });
    expect(deSite.rankMathTarget).toBe(85);
    expect(deSite.internalLinkLine).not.toBe('Read more:');
    expect(deSite.promptOverrides).toBe('{}');
    expect(en2Site.internalLinkLine).toBe('Read more:');
    const img = JSON.parse(deSite.imageSettings);
    expect(img.logoAssetId).toBeNull();
    expect(img.featured.layers.some((l: { type: string }) => l.type === 'fixed-photo')).toBe(false);
    expect(img.featured.accent).toBe('#e11d48');
    // Identity, credentials and permissions never move.
    for (const s of [deSite, en2Site]) {
      expect([s.canPublish, s.searchConsoleProperty, s.publicUrl.includes('en.example') && s.id !== ids.en]).toEqual([false, null, false]);
      expect(s.wordpressProfileId).not.toBe((await client.website.findUniqueOrThrow({ where: { id: ids.en } })).wordpressProfileId);
    }
    expect(await client.auditLog.count({ where: { action: 'website.clone-settings' } })).toBe(1);
    await expect(control.cloneSettings({ sourceId: ids.en, targetIds: [ids.en], fields: ['rankMathTarget'] })).rejects.toThrow(/own target/);
    await expect(control.cloneSettings({ sourceId: ids.en, targetIds: [ids.de], fields: ['canPublish'] })).rejects.toThrow();
  });

  it('pause, priority and quota are validated and audited; one bulk session check per site at a time', async () => {
    await expect(control.updateSiteControls(ids.de, { priority: 11 })).rejects.toThrow();
    expect(await control.updateSiteControls(ids.de, { paused: true, priority: 3, queueQuota: 2 })).toEqual({ paused: true, priority: 3, queueQuota: 2 });
    expect(await client.auditLog.count({ where: { action: 'website.controls', entityId: ids.de } })).toBe(1);
    expect(await control.bulkHealthCheck()).toEqual({ queued: 3, sites: 3 });
    expect(await control.bulkHealthCheck()).toEqual({ queued: 0, sites: 3 });
    const jobs = await client.queueJob.findMany({ where: { kind: 'wp.test' } });
    expect(new Set(jobs.map((j) => j.websiteId))).toEqual(new Set(Object.values(ids)));
  });
});
