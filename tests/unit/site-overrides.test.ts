import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { defaultSettings, effectiveTaskConfig, siteOverridesSchema, taskOptionsSchema } from '@/lib/settings-schema';

/** Regression: site overrides used to be saved/parsed with every default filled in, hiding global settings. */
describe('website setting overrides', () => {
  it('an unset site value stays unset, so the global setting applies; a set value wins', () => {
    expect(siteOverridesSchema.parse({})).toEqual({ content: {}, seo: {}, workflow: {} });
    const global = defaultSettings();
    global.content.maxArticleWordCount = 1700;
    global.content.humanizerEnabled = false;
    global.seo.rankMathMode = 'off';
    const inherit = effectiveTaskConfig(global, siteOverridesSchema.parse({}), taskOptionsSchema.parse({}));
    expect(inherit).toMatchObject({ maxWords: 1700, humanizerEnabled: false, rankMathMode: 'off' });
    const site = effectiveTaskConfig(global, siteOverridesSchema.parse({ content: { maxArticleWordCount: 900 }, seo: { rankMathMode: 'required' } }), taskOptionsSchema.parse({}));
    expect(site).toMatchObject({ maxWords: 900, humanizerEnabled: false, rankMathMode: 'required' });
    expect(() => siteOverridesSchema.parse({ content: { faqCount: 99 } })).toThrow();
  });
});

describe('unpin migration', () => {
  let client: PrismaClient;
  const pinned = () => {
    const d = defaultSettings();
    return {
      content: { maxArticleWordCount: d.content.maxArticleWordCount, faqCount: d.content.faqCount, quickBioRows: d.content.quickBioRows, tigramWordRange: d.content.tigramWordRange, humanizerEnabled: d.content.humanizerEnabled },
      seo: { reviewThreshold: d.seo.reviewThreshold, rankMathTargetScore: d.seo.rankMathTargetScore, rankMathMode: d.seo.rankMathMode, externalLinks: d.seo.externalLinks, maxExternalLinks: d.seo.maxExternalLinks, internalLinks: d.seo.internalLinks, articleImages: d.seo.articleImages, imagesRequired: d.seo.imagesRequired, imageOutputSize: d.seo.imageOutputSize },
      workflow: { manualTitleApproval: d.workflow.manualTitleApproval, manualArticleApproval: d.workflow.manualArticleApproval, autoSendToWordPress: d.workflow.autoSendToWordPress, createMissingCategory: d.workflow.createMissingCategory },
    };
  };
  const site = (slug: string, overrides: unknown) => client.website.create({ data: { name: slug, slug, publicUrl: `https://${slug}.example`, adminUrl: `https://${slug}.example/wp-admin/`, language: 'en', targetCountry: 'United States', timezone: 'UTC', settingsOverrides: JSON.stringify(overrides) } });

  beforeAll(async () => {
    ({ client } = await setupTestDb());
  });

  it('clears only groups that hold exactly the shipped defaults, keeps owner values, writes a backup, runs once', async () => {
    const a = await site('pinned', pinned());
    const ownerSet = pinned();
    ownerSet.content.faqCount = 9;
    const b = await site('owner', ownerSet);
    const c = await site('empty', { content: {}, seo: { rankMathMode: 'off' }, workflow: {} });
    const { seedAll } = await import('@/lib/seed');
    const report = (await seedAll(client)).join('\n');
    expect(report).toMatch(/unpin-default-site-overrides: applied ✓/);
    const read = async (id: string) => JSON.parse((await client.website.findUniqueOrThrow({ where: { id } })).settingsOverrides);
    expect(await read(a.id)).toEqual({ content: {}, seo: {}, workflow: {} });
    const bAfter = await read(b.id);
    expect(bAfter.content.faqCount).toBe(9); // the owner's group is kept as it was
    expect(bAfter.content.maxArticleWordCount).toBe(1300);
    expect(bAfter.seo).toEqual({}); // its untouched default groups are cleared
    expect(await read(c.id)).toEqual({ content: {}, seo: { rankMathMode: 'off' }, workflow: {} });
    const record = JSON.parse((await client.dataMigration.findUniqueOrThrow({ where: { id: '2026-10-14-unpin-default-site-overrides' } })).details);
    expect(record).toMatchObject({ sitesUnpinned: 2, groupsCleared: 5, groupsWithOwnerValuesKept: 2 });
    const backup = JSON.parse(fs.readFileSync(path.join(process.env.BAS_DATA_DIR!, 'backups', 'migrations', record.backupFile), 'utf8'));
    expect(backup.sites.map((s: { id: string }) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect((await seedAll(client)).join('\n')).toMatch(/unpin-default-site-overrides: already applied ✓/);
  });
});
