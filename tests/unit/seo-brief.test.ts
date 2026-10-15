import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { makeDriver } from '../helpers/drive';
import { briefCoverage, classifyIntent, defaultSeoBrief, seoBriefText } from '@/lib/seo/intent';

/** Upgrade 04: search intent, the editable SEO brief, its use in the writing prompt and the coverage check. */
describe('search intent', () => {
  const celeb = (k: string, secondary: string[] = []) => classifyIntent(k, { moduleKey: 'celebrity-writer', secondary });
  const general = (k: string) => classifyIntent(k, { moduleKey: 'tigram-writer' });

  it('classifies English and German keywords with the reason', () => {
    expect(celeb('Tom Kaulitz Net Worth')).toEqual({ intent: 'NET_WORTH', confidence: 'high', reason: 'the keyword contains money words' });
    expect(celeb('Heidi Klum Vermögen').intent).toBe('NET_WORTH');
    expect(celeb('Heidi Klum Ehemann').intent).toBe('FAMILY_RELATIONSHIP');
    expect(celeb('Tom Kaulitz wife')).toMatchObject({ intent: 'FAMILY_RELATIONSHIP', confidence: 'high' });
    expect(celeb('Tom Kaulitz Heidi Klum')).toEqual({ intent: 'FAMILY_RELATIONSHIP', confidence: 'medium', reason: 'the keyword names two people' });
    expect(celeb('Tom Kaulitz', ['wedding'])).toMatchObject({ intent: 'FAMILY_RELATIONSHIP', confidence: 'medium' });
    expect(celeb('Tom Kaulitz')).toMatchObject({ intent: 'BIOGRAPHY', confidence: 'medium' });
    expect(celeb('Who is Tom Kaulitz').intent).toBe('BIOGRAPHY');
    expect(celeb('Thomas Mann').intent).toBe('BIOGRAPHY'); // a surname, not a husband
    expect(general('iPhone 16 vs Pixel 9').intent).toBe('COMPARISON');
    expect(general('How to install WordPress').intent).toBe('HOW_TO');
    expect(general('WordPress installieren Anleitung').intent).toBe('HOW_TO');
    expect(general('Was ist ein VPN').intent).toBe('EXPLAINER');
    expect(general('Best travel backpacks')).toEqual({ intent: 'EXPLAINER', confidence: 'low', reason: 'no narrower intent words; a general topic' });
  });

  it('builds the brief in the article language, with an honest keyword guideline', () => {
    const de = defaultSeoBrief({ keyword: 'Heidi Klum Vermögen', moduleKey: 'celebrity-writer', language: 'de' });
    expect(de.intent).toBe('NET_WORTH');
    expect(de.sections[0]).toBe('Geschätztes Vermögen und Quellen (als Schätzung gekennzeichnet)');
    expect(de.notes).toMatch(/Schätzung/);
    expect(de.keywordGuideline).toMatch(/nie unnatürlich wiederholen/);
    const en = defaultSeoBrief({ keyword: 'How to install WordPress', moduleKey: 'tigram-writer', language: 'en', densityCeilingPct: 2 });
    expect(en.sections).toContain('Step-by-step instructions (numbered)');
    expect(en.keywordGuideline).toBe('“How to install WordPress” in the title, the intro, one fitting heading and the slug; density is a guideline up to 2 % — never repeat it unnaturally.');
    const text = seoBriefText(en, 'en');
    expect(text.split('\n')[0]).toBe('SEO brief (search intent: How-to):');
    expect(text).toContain('Use only facts from the research');
  });

  it('measures coverage by headings only (informational)', () => {
    const b = defaultSeoBrief({ keyword: 'Tom Kaulitz', moduleKey: 'celebrity-writer', language: 'en' });
    const cov = briefCoverage('<h2>Early Life in Leipzig</h2><p>x</p><h2>Career with Tokio Hotel</h2><h3>Personal life</h3><p>y</p>', b);
    expect(cov.covered).toEqual(['Early life and background', 'Career and breakthrough', 'Personal life']);
    expect(cov.missing).toEqual(['Recent work and public image']);
  });
});

describe('SEO brief in tasks and prompts (database)', () => {
  let client: PrismaClient;
  let briefs: typeof import('@/lib/tasks/seo-brief');
  let create: typeof import('@/lib/tasks/create');
  let siteId: string;
  let catId: string;

  beforeAll(async () => {
    ({ client } = await setupTestDb());
    const { seedAll } = await import('@/lib/seed');
    await seedAll(client);
    const { registerBuiltInPipelines } = await import('@/worker/pipelines');
    registerBuiltInPipelines();
    briefs = await import('@/lib/tasks/seo-brief');
    create = await import('@/lib/tasks/create');
    const websites = await import('@/lib/websites');
    siteId = (await websites.createWebsite({ name: 'Celeb News', publicUrl: 'https://celeb.example', language: 'en', targetCountry: 'United States', timezone: 'UTC' })).id;
    catId = (await client.category.create({ data: { websiteId: siteId, externalId: 7, name: 'Stars' } })).id;
  });

  it('stores the suggested brief at creation; the owner edits (validated, audited) and resets it', async () => {
    const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'Tom Kaulitz Net Worth', websiteId: siteId, categoryId: catId, idempotencyKey: 'brief:networth', options: {} }, { source: 'SINGLE', enqueue: false });
    let s = await briefs.getSeoBrief(task.id);
    expect([s.brief.intent, s.brief.editedByOwner, s.coverage]).toEqual(['NET_WORTH', false, null]);
    await expect(briefs.saveSeoBrief(task.id, { ...s.brief, sections: Array.from({ length: 16 }, (_, i) => `Section ${i}`) })).rejects.toThrow();
    await expect(briefs.saveSeoBrief(task.id, { ...s.brief, intent: 'GOSSIP' })).rejects.toThrow();
    s = await briefs.saveSeoBrief(task.id, { ...s.brief, intent: 'BIOGRAPHY', sections: ['Early life', 'Career', '  '] });
    expect([s.brief.intent, s.brief.sections, s.brief.editedByOwner, s.suggested.intent]).toEqual(['BIOGRAPHY', ['Early life', 'Career'], true, 'NET_WORTH']);
    expect(await client.auditLog.count({ where: { action: 'task.seo-brief', entityId: task.id } })).toBe(1);
    s = await briefs.resetSeoBrief(task.id);
    expect([s.brief.intent, s.brief.editedByOwner]).toEqual(['NET_WORTH', false]);
  });

  it('the writing prompt carries the brief and the SEO report checks its coverage; the setting turns it off', async () => {
    const run = async (keyword: string, key: string) => {
      const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword, secondaryKeywords: 'Tokio Hotel', websiteId: siteId, categoryId: catId, idempotencyKey: key, options: { saveToWordPress: false } }, { source: 'SINGLE' });
      await makeDriver(client).drive(task.id);
      const long = await client.chatGPTResponse.findFirstOrThrow({ where: { taskId: task.id, stageKey: 'LONG_ARTICLE' } });
      const titles = await client.chatGPTResponse.findFirstOrThrow({ where: { taskId: task.id, stageKey: 'TITLES' } });
      return { task, long: long.renderedPrompt, titles: titles.renderedPrompt };
    };
    const on = await run('Tom Kaulitz Heidi Klum', 'brief:prompt-on');
    expect(on.long).toContain('SEO brief (search intent: Family / relationship):');
    expect(on.long).toContain('Sections to cover: How and when they met;');
    expect(on.titles).not.toContain('SEO brief'); // only the writing prompt
    const report = await client.sEOReport.findFirstOrThrow({ where: { taskId: on.task.id, source: 'INTERNAL' }, orderBy: { createdAt: 'desc' } });
    const check = (JSON.parse(report.checks) as { id: string; severity: string; detail: string }[]).find((c) => c.id === 'brief-coverage');
    expect(check).toMatchObject({ severity: 'info', detail: expect.stringMatching(/^\d+\/4 sections covered/) });
    const { updateSettings } = await import('@/lib/settings');
    await updateSettings({ seo: { seoBriefInPrompts: false } });
    const off = await run('Bill Kaulitz Tokio Hotel', 'brief:prompt-off');
    expect(off.long).not.toContain('SEO brief');
    await updateSettings({ seo: { seoBriefInPrompts: true } });
  }, 180_000);
});
