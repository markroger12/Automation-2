import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { makeDriver } from '../helpers/drive';
import { cannedAnswer } from '../helpers/fake-answers';

/**
 * Owner report: articles the workflow queues never got a category chosen. A workflow keyword has no category of its
 * own, so every article took the website's default, which a category sync sets to “Uncategorized”, and Tigram's
 * CATEGORY stage was skipped because that default looked like the owner's choice. Owner decision: ChatGPT chooses one
 * of the website's synced categories for each such article (Celebrity and Tigram), “Uncategorized” only when there is
 * nothing else, and the website's default when ChatGPT names no existing category.
 */
let client: PrismaClient;
let create: typeof import('@/lib/tasks/create');
let site: string;
let uncategorized: string;
let celebrities: string;

/** What ChatGPT is asked for the category, and what it answers (per keyword). */
const categoryPrompts: string[] = [];
const categoryAnswers = new Map<string, string>();
const answer = (stageKey: string, prompt: string, language: 'en' | 'de', keyword: string) => {
  if (stageKey === 'CATEGORY') {
    categoryPrompts.push(prompt);
    return categoryAnswers.get(keyword) ?? 'CATEGORY: Something That Does Not Exist';
  }
  return cannedAnswer(stageKey, prompt, language, keyword);
};

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  create = await import('@/lib/tasks/create');
  const { registerBuiltInPipelines } = await import('@/worker/pipelines');
  registerBuiltInPipelines();
  const websites = await import('@/lib/websites');
  site = (await websites.createWebsite({ name: 'Celeb News', publicUrl: 'https://celeb.example', language: 'en', targetCountry: 'United States', timezone: 'UTC' })).id;
  uncategorized = (await client.category.create({ data: { websiteId: site, externalId: 1, name: 'Uncategorized', slug: 'uncategorized' } })).id;
  celebrities = (await client.category.create({ data: { websiteId: site, externalId: 7, name: 'Celebrities', slug: 'celebrities' } })).id;
  await client.category.create({ data: { websiteId: site, externalId: 9, name: 'Tech & Apps', slug: 'tech-apps' } });
  // As a category sync leaves it: “Uncategorized” is the website's default.
  await client.website.update({ where: { id: site }, data: { defaultCategoryId: uncategorized } });
  // Not a real WordPress install: the article stops at the WordPress draft step.
  await client.browserProfile.updateMany({ data: { sessionState: 'LOGIN_REQUIRED' } });
});

const stageOf = (taskId: string, key: string) => client.articleStage.findFirstOrThrow({ where: { taskId, key } });

describe('category of articles nobody chose a category for', () => {
  it('workflow Celebrity article: ChatGPT chooses from the synced categories, never offered “Uncategorized”', async () => {
    categoryAnswers.set('Tom Kaulitz Heidi Klum', 'CATEGORY: Celebrities');
    const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'Tom Kaulitz Heidi Klum', websiteId: site, idempotencyKey: 'workflow-kw:cat-celebrity' }, { source: 'WORKFLOW' });
    const before = categoryPrompts.length;
    const final = await makeDriver(client, answer).drive(task.id);
    expect(final.status).toBe('LOGIN_REQUIRED');
    expect(final.stage).toBe('WORDPRESS_DRAFT');
    expect(categoryPrompts.length).toBe(before + 1);
    const prompt = categoryPrompts[before];
    expect(prompt).toContain('Celebrities');
    expect(prompt).toContain('Tech & Apps');
    expect(prompt).not.toContain('Uncategorized');
    expect(final).toMatchObject({ categoryId: celebrities, categoryName: 'Celebrities', categoryExternalId: 7 });
    expect((await stageOf(task.id, 'CATEGORY')).status).toBe('COMPLETED');
  });

  it('workflow Tigram article on a website whose default is “Uncategorized”: the CATEGORY stage runs', async () => {
    categoryAnswers.set('How to Install WordPress', 'CATEGORY: Tech & Apps');
    const { task } = await create.createArticleTask({ moduleKey: 'tigram-writer', keyword: 'How to Install WordPress', websiteId: site, idempotencyKey: 'workflow-kw:cat-tigram' }, { source: 'WORKFLOW' });
    const final = await makeDriver(client, answer).drive(task.id);
    expect(final.categoryName).toBe('Tech & Apps');
    expect((await stageOf(task.id, 'CATEGORY')).status).toBe('COMPLETED');
  });

  it('Single Article, Tigram, category left to the CATEGORY stage: it runs although the website has a default', async () => {
    categoryAnswers.set('Best Free VPN Apps', 'CATEGORY: Tech & Apps');
    const { task } = await create.createArticleTask({ moduleKey: 'tigram-writer', keyword: 'Best Free VPN Apps', websiteId: site, idempotencyKey: 'single:cat-tigram-auto' }, { source: 'SINGLE' });
    expect(task.categoryId).toBeNull();
    const final = await makeDriver(client, answer).drive(task.id);
    expect(final.categoryName).toBe('Tech & Apps');
  });

  it('a category the owner chose is kept: no category prompt', async () => {
    const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'Sydney Sweeney', websiteId: site, categoryId: celebrities, idempotencyKey: 'single:cat-chosen' }, { source: 'SINGLE' });
    const before = categoryPrompts.length;
    const final = await makeDriver(client, answer).drive(task.id);
    expect(categoryPrompts.length).toBe(before);
    expect(final.categoryName).toBe('Celebrities');
    expect((await stageOf(task.id, 'CATEGORY')).status).toBe('SKIPPED');
  });

  it('ChatGPT names no existing category: the website default stays, with a warning', async () => {
    categoryAnswers.set('Heidi Klum Children', 'CATEGORY: Royal Family');
    const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'Heidi Klum Children', websiteId: site, idempotencyKey: 'workflow-kw:cat-nomatch' }, { source: 'WORKFLOW' });
    const final = await makeDriver(client, answer).drive(task.id);
    expect(final.categoryName).toBe('Uncategorized');
    const stage = await stageOf(task.id, 'CATEGORY');
    expect(stage.status).toBe('COMPLETED');
    expect(stage.outputJson).toContain('site default');
  });

  it('never changes the category once the WordPress draft exists', async () => {
    categoryAnswers.set('Kelly Ripa Mark Consuelos', 'CATEGORY: Celebrities');
    const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'Kelly Ripa Mark Consuelos', websiteId: site, idempotencyKey: 'workflow-kw:cat-draft' }, { source: 'WORKFLOW' });
    await client.articleTask.update({ where: { id: task.id }, data: { wpPostId: 4321 } });
    const before = categoryPrompts.length;
    const final = await makeDriver(client, answer).drive(task.id);
    expect(categoryPrompts.length).toBe(before);
    expect(final.categoryName).toBe('Uncategorized');
    expect((await stageOf(task.id, 'CATEGORY')).status).toBe('SKIPPED');
  });

  it('Bulk: a Tigram row without a category is left to the writer; a Celebrity row takes the default', async () => {
    const svc = await import('@/lib/campaigns/service');
    const p = await svc.previewCampaign({ text: 'keyword,kind\nWhat Is a VPN,tigram\nSelena Gomez husband,celebrity', websiteId: site });
    expect(p.rows.find((r) => r.keyword === 'What Is a VPN')).toMatchObject({ status: 'READY', writer: 'tigram-writer', categoryId: null });
    expect(p.rows.find((r) => r.keyword === 'Selena Gomez husband')).toMatchObject({ status: 'READY', writer: 'celebrity-writer', categoryId: uncategorized });
  });
});
