import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { load } from 'cheerio';
import { setupTestDb } from '../helpers/test-db';
import { makeDriver } from '../helpers/drive';
import { cannedAnswer } from '../helpers/fake-answers';

/**
 * Owner request (2026-11-05): “jab chaon module add krlon” — build a writer in the app (Writers → New writer) instead
 * of asking for code: start from a writer, the owner's own prompt, its rules, a test with a real ChatGPT answer, then
 * Active — and it is offered everywhere a writer is chosen and runs like the built-in writers.
 */
const ANSWER = fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'chatgpt', 'celebrity2-andrea-soros.md'), 'utf8');
const TITLE = "Who is Andrea Soros? All about George Soros' daughter";

// The article's source links are checked as for any article; no real network in unit tests.
vi.mock('@/lib/links/net', async (orig) => {
  const real = await orig<typeof import('@/lib/links/net')>();
  return {
    ...real,
    safeFetch: async (url: string) => ({ url, finalUrl: url, status: 200, contentType: 'text/html; charset=utf-8', body: '<html><head><title>Andrea Soros Colombel — record</title></head><body><h1>Andrea Soros Colombel</h1><p>Andrea Soros Colombel, philanthropist.</p></body></html>', buffer: Buffer.alloc(0), redirects: [] }),
  };
});

let client: PrismaClient;
let site: string;
let store: typeof import('@/lib/writers/store');

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  store = await import('@/lib/writers/store');
  const { registerBuiltInPipelines } = await import('@/worker/pipelines');
  registerBuiltInPipelines();
  const websites = await import('@/lib/websites');
  site = (await websites.createWebsite({ name: 'Writer Lab', publicUrl: 'https://lab.example', language: 'en', targetCountry: 'United States', timezone: 'America/New_York' })).id;
  await client.category.createMany({
    data: [
      { websiteId: site, externalId: 1, name: 'Uncategorized', slug: 'uncategorized' },
      { websiteId: site, externalId: 2, name: 'Celebrity', slug: 'celebrity' },
      { websiteId: site, externalId: 3, name: 'Tech News', slug: 'tech-news' },
    ],
  });
  // Not a real WordPress install: articles run completely and wait at the WordPress draft step.
  await client.browserProfile.updateMany({ data: { sessionState: 'LOGIN_REQUIRED' } });
});

describe('Writers → New writer', () => {
  it('starts from Celebrity 2 as a draft: its prompt and rules copied, not offered anywhere yet', async () => {
    const w = await store.createCustomWriter({ name: 'Celebrity Family', startFrom: 'celebrity2-writer' });
    expect(w).toMatchObject({ key: 'custom-celebrity-family', name: 'Celebrity Family', shortName: 'Celebrity Family', base: 'person', status: 'DRAFT', startedFrom: 'celebrity2-writer' });
    expect(w.config.rules).toMatchObject({ faqCount: 5, exactFaqs: true, table: 'required', tableHeading: 'Family Profile', wordMin: 1300, wordMax: 1600 });
    expect(w.config.category.mode).toBe('celebrity');
    const detail = await store.getCustomWriter(w.key);
    const { CELEBRITY2_ARTICLE_PROMPT } = await import('@/modules/celebrity2-writer/prompt');
    expect(detail.prompts.ARTICLE).toBe(CELEBRITY2_ARTICLE_PROMPT);
    expect(detail.promptVersions.ARTICLE).toBe(1);
    // A draft: no article can be started with it, and no form offers it.
    const { writerChoices } = await import('@/lib/writers/options');
    expect(writerChoices().map((c) => c.key)).not.toContain(w.key);
    const create = await import('@/lib/tasks/create');
    await expect(create.createArticleTask({ moduleKey: w.key, keyword: 'Andrea Soros', websiteId: site, idempotencyKey: 'cw:draft' }, { source: 'SINGLE' })).rejects.toThrow(/active writers/);
    // Names are unique, and never a built-in writer's name.
    await expect(store.createCustomWriter({ name: 'Celebrity 2' })).rejects.toThrow(/built-in writer/);
    await expect(store.createCustomWriter({ name: 'celebrity family' })).rejects.toThrow(/already exists/);
  });

  it('a prompt with an unknown placeholder is refused; the checklist says what is missing', async () => {
    await expect(store.updateCustomWriter('custom-celebrity-family', { prompts: { ARTICLE: 'Write about {{keyword}} and {{celebrity_age}}.' } })).rejects.toThrow(/\{\{celebrity_age\}\} is not a variable/);
    await expect(store.updateCustomWriter('custom-celebrity-family', { prompts: { ARTICLE: 'Write about {{#if keyword}}{{keyword}}.' } })).rejects.toThrow(/Template/);
    const detail = await store.getCustomWriter('custom-celebrity-family');
    expect(detail.readiness.ok).toBe(true);
    expect(detail.readiness.checks.find((c) => c.id === 'test')).toMatchObject({ passed: false, blocking: false });
    // A fixed category needs its name.
    await expect(store.updateCustomWriter('custom-celebrity-family', { config: { ...detail.writer.config, category: { mode: 'fixed', name: '' } } })).rejects.toThrow(/category name/);
  });

  it('Test with the owner’s real ChatGPT answer: what the article gets, saved as the writer’s last test', async () => {
    const r = await store.testCustomWriter('custom-celebrity-family', { answer: ANSWER, language: 'en', title: TITLE });
    expect(r.parse.problems).toEqual([]);
    expect(r.result).toMatchObject({ ok: true, faqs: 5, tableRows: 14 });
    expect(r.result.words).toBeGreaterThan(1300);
    expect(r.parse.h2.slice(0, 2)).toEqual(['Family Profile', 'Who Is Andrea Soros Colombel?']);
    expect(r.saved).toBe(true);
    const detail = await store.getCustomWriter('custom-celebrity-family');
    expect(detail.readiness.checks.find((c) => c.id === 'test')).toMatchObject({ passed: true });
    // An answer without the table is one that would be asked again.
    const bad = await store.testCustomWriter('custom-celebrity-family', { answer: ANSWER.replace(/\| Attribute[\s\S]*?Open Society Foundations \|\n/, ''), language: 'en' });
    expect(bad.result.ok).toBe(false);
    expect(bad.result.problems).toContain('The Family Profile table is missing.');
  });

  it('Active: offered everywhere a writer is chosen (also by name in imports), and routes keywords with its phrases', async () => {
    const detail = await store.getCustomWriter('custom-celebrity-family');
    await store.updateCustomWriter('custom-celebrity-family', { config: { ...detail.writer.config, routing: { contains: ['family tree'], personKeywords: true } } });
    await store.setWriterStatus('custom-celebrity-family', 'ACTIVE');
    const { writerChoices, personWriterChoices } = await import('@/lib/writers/options');
    expect(writerChoices().map((c) => c.short)).toEqual(['Celebrity', 'Celebrity 2', 'Tigram', 'Celebrity Family']);
    expect(personWriterChoices().map((c) => c.short)).toEqual(['Celebrity', 'Celebrity 2', 'Celebrity Family']);
    const { normalizeWriter, resolveWriter } = await import('@/lib/campaigns/router');
    expect(normalizeWriter('celebrity family')).toBe('custom-celebrity-family');
    expect(resolveWriter({ keyword: 'Soros family tree explained' })).toMatchObject({ writer: 'custom-celebrity-family', source: 'WRITER_RULE' });
    const { moduleToWriterType, writerTypeToModule } = await import('@/lib/domain');
    expect(moduleToWriterType('custom-celebrity-family')).toBe('custom-celebrity-family');
    expect(writerTypeToModule('custom-celebrity-family')).toBe('custom-celebrity-family');
  });

  it('end to end: the app’s title step, then the owner’s prompt as written; the article as Celebrity 2 makes it', async () => {
    const answers = (stageKey: string, prompt: string, language: 'en' | 'de', keyword: string) => {
      if (stageKey === 'TITLES') return `1. ${TITLE}\n2. Andrea Soros: George Soros' Daughter\n\nRecommended Title: ${TITLE}`;
      if (stageKey === 'ARTICLE') return ANSWER;
      return cannedAnswer(stageKey, prompt, language, keyword);
    };
    const { drive } = makeDriver(client, answers);
    const create = await import('@/lib/tasks/create');
    const { task } = await create.createArticleTask({ moduleKey: 'custom-celebrity-family', keyword: 'Andrea Soros', secondaryKeywords: 'andrea soros husband', exampleTitle: TITLE, websiteId: site, idempotencyKey: 'cw:e2e-1' }, { source: 'SINGLE' });
    expect(task.categoryName).toBe('Celebrity');
    const final = await drive(task.id);
    expect(final.status).toBe('LOGIN_REQUIRED');
    const responses = await client.chatGPTResponse.findMany({ where: { taskId: task.id }, orderBy: { createdAt: 'asc' } });
    expect(responses.map((r) => r.stageKey).slice(0, 2)).toEqual(['TITLES', 'ARTICLE']);
    // The owner's prompt as written (no SEO brief), with the approved title and the inputs.
    expect(responses[1].renderedPrompt).toContain(`**Title:** \`${TITLE}\``);
    expect(responses[1].renderedPrompt).toContain('**Secondary Keywords / Related Entities:** `andrea soros husband`');
    expect(responses[1].renderedPrompt).not.toMatch(/SEO brief|Search intent:/i);
    const t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.selectedTitle).toBe(TITLE);
    expect(t.seoTitle).toBe("Andrea Soros: George Soros' Daughter and Her Philanthropy");
    expect(JSON.parse(t.faqs)).toHaveLength(5);
    const $ = load(`<body>${t.assembledHtml}</body>`);
    expect($('table.bas-quick-bio tbody tr').length).toBe(14);
    expect($('table.bas-quick-bio').prev().text()).toBe('Family Profile');
    const h2 = $('h2').toArray().map((e) => $(e).text());
    expect(h2.slice(-2)).toEqual(['Conclusion', 'Frequently Asked Questions']);
    const seo = await client.articleStage.findFirstOrThrow({ where: { taskId: task.id, key: 'SEO_CHECK' } });
    const checks = JSON.parse(seo.outputJson ?? '{}').checks as { id: string; passed: boolean; detail: string }[];
    expect(checks.find((c) => c.id === 'faq-count')).toMatchObject({ passed: true, detail: '5 found' });
    expect(checks.find((c) => c.id === 'quick-bio')).toMatchObject({ passed: true });
  });

  it('a general writer from Tigram with a fixed category and no title step: its title from the answer, no FAQ rule when 0', async () => {
    const w = await store.createCustomWriter({ name: 'Tech Guides', startFrom: 'tigram-writer' });
    expect(w).toMatchObject({ base: 'general', status: 'DRAFT' });
    expect(w.config.titles).toBe('off');
    await store.updateCustomWriter(w.key, { config: { ...w.config, category: { mode: 'fixed', name: 'Tech News', nameDe: '' }, rules: { ...w.config.rules, wordMin: 300, wordMax: 900, faqCount: 7, exactFaqs: false } } });
    await store.setWriterStatus(w.key, 'ACTIVE');
    const { drive } = makeDriver(client, (stageKey, prompt, language, keyword) => cannedAnswer(stageKey === 'ARTICLE' ? 'ARTICLE' : stageKey, prompt, language, keyword));
    const create = await import('@/lib/tasks/create');
    const { task } = await create.createArticleTask({ moduleKey: w.key, keyword: 'Best VPN Apps', websiteId: site, idempotencyKey: 'cw:e2e-2', options: { images: 'off' } }, { source: 'SINGLE' });
    expect(task.categoryName).toBe('Tech News');
    const final = await drive(task.id);
    expect(final.status, final.message ?? '').toBe('LOGIN_REQUIRED');
    const responses = await client.chatGPTResponse.findMany({ where: { taskId: task.id }, orderBy: { createdAt: 'asc' } });
    // No title step and no category prompt: the article is the first prompt.
    expect(responses[0].stageKey).toBe('ARTICLE');
    expect(responses.some((r) => r.stageKey === 'TITLES' || r.stageKey === 'CATEGORY')).toBe(false);
    const t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.selectedTitle).toBe('Best VPN Apps: The Complete Guide');
    const stages = await client.articleStage.findMany({ where: { taskId: task.id } });
    expect(stages.find((s) => s.key === 'TITLES')?.status).toBe('SKIPPED');
    // The images are the general (Tigram) kind and the Tigram designs.
    const { imagesKindFor } = await import('@/lib/writers/rules');
    const { templateSetFor } = await import('@/lib/image-template');
    expect(imagesKindFor(w.key)).toBe('general');
    expect(templateSetFor(w.key)).toBe('tigram');
    // A website without its category: the article does not start, and says which category to create.
    const other = (await (await import('@/lib/websites')).createWebsite({ name: 'No Tech', publicUrl: 'https://notech.example', language: 'en', targetCountry: 'United States', timezone: 'America/New_York' })).id;
    await expect(create.createArticleTask({ moduleKey: w.key, keyword: 'Best VPN Apps 2', websiteId: other, idempotencyKey: 'cw:nocat' }, { source: 'SINGLE' })).rejects.toThrow(/No Tech has no “Tech News” category. The writer “Tech Guides” always puts its articles there/);
  });

  it('archived: no longer offered, its articles still run; it cannot be deleted while articles use it', async () => {
    await store.setWriterStatus('custom-tech-guides', 'ARCHIVED');
    const { writerChoices } = await import('@/lib/writers/options');
    expect(writerChoices().map((c) => c.key)).not.toContain('custom-tech-guides');
    const { isActiveModuleKey, isRunnableModuleKey } = await import('@/lib/domain');
    expect(isActiveModuleKey('custom-tech-guides')).toBe(false);
    expect(isRunnableModuleKey('custom-tech-guides')).toBe(true);
    await expect(store.deleteCustomWriter('custom-tech-guides')).rejects.toThrow(/Archive it instead/);
    // A writer no article used is deleted with its prompts.
    const spare = await store.createCustomWriter({ name: 'Spare Writer', startFrom: 'blank-general' });
    expect(await store.deleteCustomWriter(spare.key)).toEqual({ deleted: true });
    expect(await client.promptTemplate.count({ where: { moduleKey: spare.key } })).toBe(0);
  });

  it('built-in writers keep their rules (Celebrity 2’s table and FAQs, Tigram’s images and designs)', async () => {
    const { categoryRuleFor, imagesKindFor, keepsAnswerOrder, profileTableFor, sendsPromptAsWritten } = await import('@/lib/writers/rules');
    expect(categoryRuleFor('celebrity2-writer')).toEqual({ mode: 'celebrity' });
    expect(categoryRuleFor('tigram-writer')).toEqual({ mode: 'chatgpt' });
    expect(imagesKindFor('tigram-writer')).toBe('general');
    expect(imagesKindFor('celebrity-writer')).toBe('person');
    expect(keepsAnswerOrder('celebrity-writer')).toBe(false);
    expect(profileTableFor('celebrity2-writer', 'de')).toEqual({ required: true, heading: 'Familienprofil' });
    expect(sendsPromptAsWritten('celebrity2-writer')).toBe(true);
    expect(sendsPromptAsWritten('tigram-writer')).toBe(false);
  });
});
