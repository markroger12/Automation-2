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
 *
 * Owner decision (2026-11-04): a celebrity article (Celebrity, Celebrity 2) always goes into the website's
 * “Celebrity” category (German websites: “Prominente”) — no choice and no prompt. ChatGPT chooses for Tigram only.
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
  it('workflow Celebrity article: always the website’s celebrity category, without a category prompt', async () => {
    const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'Tom Kaulitz Heidi Klum', websiteId: site, idempotencyKey: 'workflow-kw:cat-celebrity' }, { source: 'WORKFLOW' });
    const before = categoryPrompts.length;
    const final = await makeDriver(client, answer).drive(task.id);
    expect(final.status).toBe('LOGIN_REQUIRED');
    expect(final.stage).toBe('WORDPRESS_DRAFT');
    expect(categoryPrompts.length).toBe(before);
    expect(final).toMatchObject({ categoryId: celebrities, categoryName: 'Celebrities', categoryExternalId: 7 });
    const stage = await stageOf(task.id, 'CATEGORY');
    expect(stage.status).toBe('COMPLETED');
    expect(stage.message).toBe('Category: Celebrities (always for celebrity articles)');
  });

  it('a Celebrity article queued earlier with another category gets the celebrity category before any prompt', async () => {
    const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'Earlier Queued Person', websiteId: site, idempotencyKey: 'workflow-kw:cat-earlier' }, { source: 'WORKFLOW' });
    // As before the owner's decision: the website's default (“Uncategorized”).
    await client.articleTask.update({ where: { id: task.id }, data: { categoryId: uncategorized, categoryName: 'Uncategorized', categoryExternalId: 1 } });
    const final = await makeDriver(client, answer).drive(task.id);
    expect(final).toMatchObject({ categoryId: celebrities, categoryName: 'Celebrities' });
    const titles = await client.chatGPTResponse.findFirstOrThrow({ where: { taskId: task.id, stageKey: 'TITLES' } });
    const precheck = await stageOf(task.id, 'PRECHECK');
    expect(precheck.completedAt!.getTime()).toBeLessThanOrEqual(titles.createdAt.getTime());
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

  it('a category the owner chose for a Tigram article is kept: no category prompt', async () => {
    const tech = (await client.category.findFirstOrThrow({ where: { websiteId: site, name: 'Tech & Apps' } })).id;
    const { task } = await create.createArticleTask({ moduleKey: 'tigram-writer', keyword: 'Best Password Manager', websiteId: site, categoryId: tech, idempotencyKey: 'single:cat-chosen' }, { source: 'SINGLE' });
    const before = categoryPrompts.length;
    const final = await makeDriver(client, answer).drive(task.id);
    expect(categoryPrompts.length).toBe(before);
    expect(final.categoryName).toBe('Tech & Apps');
    expect((await stageOf(task.id, 'CATEGORY')).status).toBe('SKIPPED');
  });

  it('ChatGPT names no existing category: the website default stays, with a warning', async () => {
    categoryAnswers.set('How to Clean a Keyboard', 'CATEGORY: Royal Family');
    const { task } = await create.createArticleTask({ moduleKey: 'tigram-writer', keyword: 'How to Clean a Keyboard', websiteId: site, idempotencyKey: 'workflow-kw:cat-nomatch' }, { source: 'WORKFLOW' });
    const final = await makeDriver(client, answer).drive(task.id);
    expect(final.categoryName).toBe('Uncategorized');
    const stage = await stageOf(task.id, 'CATEGORY');
    expect(stage.status).toBe('COMPLETED');
    expect(stage.outputJson).toContain('site default');
  });

  it('never changes the category once the WordPress draft exists', async () => {
    const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'Kelly Ripa Mark Consuelos', websiteId: site, idempotencyKey: 'workflow-kw:cat-draft' }, { source: 'WORKFLOW' });
    // A draft saved before the owner's decision, with the website's default.
    await client.articleTask.update({ where: { id: task.id }, data: { wpPostId: 4321, categoryId: uncategorized, categoryName: 'Uncategorized', categoryExternalId: 1 } });
    const before = categoryPrompts.length;
    const final = await makeDriver(client, answer).drive(task.id);
    expect(categoryPrompts.length).toBe(before);
    expect(final.categoryName).toBe('Uncategorized');
    expect((await stageOf(task.id, 'CATEGORY')).status).toBe('SKIPPED');
  });

  it('Bulk: a Tigram row without a category is left to the writer; Celebrity and Celebrity 2 rows take the celebrity category', async () => {
    const svc = await import('@/lib/campaigns/service');
    const p = await svc.previewCampaign({ text: 'keyword,kind,category\nWhat Is a VPN,tigram,\nSelena Gomez husband,celebrity,Tech & Apps\nAndrea Soros,celebrity 2,', websiteId: site });
    expect(p.rows.find((r) => r.keyword === 'What Is a VPN')).toMatchObject({ status: 'READY', writer: 'tigram-writer', categoryId: null });
    expect(p.rows.find((r) => r.keyword === 'Selena Gomez husband')).toMatchObject({ status: 'READY', writer: 'celebrity-writer', categoryId: celebrities });
    expect(p.rows.find((r) => r.keyword === 'Andrea Soros')).toMatchObject({ status: 'READY', writer: 'celebrity2-writer', categoryId: celebrities });
  });
});
