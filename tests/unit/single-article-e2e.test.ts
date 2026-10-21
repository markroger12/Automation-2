import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { allowFixtureDuplicates } from '../helpers/drive';
import { cannedAnswer } from '../helpers/fake-answers';

/**
 * Spec 1S.3 regression proof with the REAL engine, queue, prompt rendering,
 * parsers, assembly, SEO checks and quality gate. ChatGPT is replaced by a
 * scripted responder that claims and completes jobs through the same bridge
 * the extension uses (no live ChatGPT here).
 */
let client: PrismaClient;
let create: typeof import('@/lib/tasks/create');
let queue: typeof import('@/lib/queue');
let engine: typeof import('@/worker/pipeline/engine');
let jobs: typeof import('@/lib/chatgpt/jobs');
let recovery: typeof import('@/worker/recovery');
let query: typeof import('@/lib/tasks/query');
let detail: typeof import('@/lib/tasks/detail');
let actions: typeof import('@/lib/tasks/actions');
let siteEn: string;
let siteDe: string;
let catEn: string;
let catDe: string;

const KEYWORD = 'Tom Kaulitz Heidi Klum';
const SECONDARY = 'Tokio Hotel\nGermany’s Next Topmodel, wedding\nTokio Hotel';
const EXAMPLE = 'Tom & Heidi: A Very Distinct Example Title 2026';

async function respond(language: 'en' | 'de') {
  let answered = 0;
  for (;;) {
    const claim = await jobs.claimChatGPTJob({ installId: 'test', tabId: `t${answered}` });
    if (!('job' in claim)) break;
    const p = claim.payload;
    const task = await client.articleTask.findUniqueOrThrow({ where: { id: p.taskId! } });
    await jobs.completeChatGPTJob({ jobId: claim.job.id, tabId: `t${answered}`, text: cannedAnswer(p.stageKey, p.prompt, language, task.keyword), conversationUrl: 'https://chatgpt.com/c/11111111-2222-4333-8444-555555555555' });
    answered++;
  }
  return answered;
}

async function drive(taskId: string, language: 'en' | 'de', stopWhen?: (status: string, stage: string | null) => boolean) {
  await allowFixtureDuplicates(client, taskId);
  for (let i = 0; i < 80; i++) {
    const t = await client.articleTask.findUniqueOrThrow({ where: { id: taskId } });
    if (stopWhen?.(t.status, t.stage)) return t;
    if (['COMPLETED', 'NEEDS_REVIEW', 'FAILED', 'CANCELLED', 'AWAITING_TITLE_APPROVAL', 'AWAITING_ARTICLE_APPROVAL', 'LOGIN_REQUIRED'].includes(t.status) && !(await client.queueJob.count({ where: { taskId, status: { in: ['WAITING', 'ACTIVE'] } } }))) return t;
    await client.queueJob.updateMany({ where: { taskId, queue: 'article', status: 'WAITING' }, data: { runAt: new Date(0) } });
    const job = await queue.claimNext({ queue: 'article', owner: 'test-worker', leaseMs: 60_000 });
    if (job) await engine.runArticleJob(job, { workerId: 'test-worker', leaseMs: 60_000, random: () => 0.5 });
    await respond(language);
  }
  throw new Error('pipeline did not settle');
}

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  create = await import('@/lib/tasks/create');
  queue = await import('@/lib/queue');
  engine = await import('@/worker/pipeline/engine');
  jobs = await import('@/lib/chatgpt/jobs');
  recovery = await import('@/worker/recovery');
  query = await import('@/lib/tasks/query');
  detail = await import('@/lib/tasks/detail');
  actions = await import('@/lib/tasks/actions');
  const { registerBuiltInPipelines } = await import('@/worker/pipelines');
  registerBuiltInPipelines();
  const websites = await import('@/lib/websites');
  const en = await websites.createWebsite({ name: 'Celeb News', publicUrl: 'https://celeb.example', language: 'en', targetCountry: 'United States', timezone: 'America/New_York' });
  const de = await websites.createWebsite({ name: 'Promi Welt', publicUrl: 'https://promi.example', language: 'de', targetCountry: 'Germany', timezone: 'Europe/Berlin' });
  siteEn = en.id;
  siteDe = de.id;
  catEn = (await client.category.create({ data: { websiteId: siteEn, externalId: 7, name: 'Celebrities' } })).id;
  catDe = (await client.category.create({ data: { websiteId: siteDe, externalId: 3, name: 'Promis' } })).id;
  // These sites are not real WordPress installs: their profiles are logged out, so the
  // content pipeline runs completely and the task pauses at the WordPress draft step.
  // (Draft creation itself is covered by the WordPress integration/e2e tests.)
  await client.browserProfile.updateMany({ data: { sessionState: 'LOGIN_REQUIRED' } });
});

describe('Single Article end-to-end (scripted ChatGPT)', () => {
  it('keeps the exact inputs through the task, prompts, queue and detail, and assembles a complete celebrity article', async () => {
    const { task, created } = await create.createArticleTask(
      { moduleKey: 'celebrity-writer', keyword: `  ${KEYWORD}  `, secondaryKeywords: SECONDARY, exampleTitle: EXAMPLE, websiteId: siteEn, categoryId: catEn, idempotencyKey: 'single:e2e-en-1' },
      { source: 'SINGLE' },
    );
    expect(created).toBe(true);
    expect(task.keyword).toBe(KEYWORD);
    expect(JSON.parse(task.secondaryKeywords)).toEqual(['Tokio Hotel', 'Germany’s Next Topmodel', 'wedding']);
    expect(task.exampleTitle).toBe(EXAMPLE);
    expect(task.categoryName).toBe('Celebrities');
    expect(task.language).toBe('en');
    expect(task.targetCountry).toBe('United States');
    // Double submit returns the same task and does not create a second job.
    const again = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: KEYWORD, websiteId: siteEn, categoryId: catEn, idempotencyKey: 'single:e2e-en-1' }, { source: 'SINGLE' });
    expect(again.created).toBe(false);
    expect(await client.queueJob.count({ where: { taskId: task.id, queue: 'article' } })).toBe(1);

    const final = await drive(task.id, 'en');
    const responses = await client.chatGPTResponse.findMany({ where: { taskId: task.id }, orderBy: { createdAt: 'asc' } });
    // The humanizer sends the body in two ~1,200-word batches.
    // IMAGES: the celebrity photo search (ChatGPT image-search gallery, the default photo source).
    expect(responses.map((r) => r.stageKey)).toEqual(['TITLES', 'RESEARCH', 'LONG_ARTICLE', 'FINAL_ARTICLE', 'FAQS', 'QUICK_BIO', 'EXTERNAL_LINKS', 'IMAGES', 'IMAGES', 'HUMANIZE', 'HUMANIZE']); // a text-only photo search is asked once more in a new chat
    const titles = responses[0].renderedPrompt;
    expect(titles).toContain(`Primary keyword: "${KEYWORD}"`);
    expect(titles).toContain(`Reference title for direction only: "${EXAMPLE}"`);
    expect(titles.endsWith('Write in English for readers in the United States.')).toBe(true);
    const long = responses[2].renderedPrompt;
    expect(long).toContain('Secondary terms to use only where natural: Tokio Hotel, Germany’s Next Topmodel, wedding');
    expect(long).toContain(`Title: "${KEYWORD}: Inside Their Relationship"`);
    expect(responses[4].renderedPrompt).toContain('write exactly 5 realistic');
    expect(responses[5].renderedPrompt).toContain('approximately 11–13 useful rows');

    // Logged-out site: the finished article waits at the WordPress step — never "completed".
    expect(final.status).toBe('LOGIN_REQUIRED');
    expect(final.pausedFor).toBe('wordpress-login');
    expect(final.stage).toBe('WORDPRESS_DRAFT');
    expect(final.verifiedCompleteAt).toBeNull();
    expect(final.wpPostId).toBeNull();
    const html = final.assembledHtml!;
    expect(html).toContain('<h2>Quick Bio of Tom Kaulitz</h2>');
    expect(html).toContain('<h2>Frequently Asked Questions</h2>');
    expect((html.match(/<h3>/g) ?? []).length).toBe(5);
    expect(html.indexOf('Frequently Asked Questions')).toBeLessThan(html.indexOf('<h2>Conclusion</h2>'));
    expect(html.indexOf('Quick Bio of')).toBeLessThan(html.indexOf('<h2>How It All Began</h2>'));
    expect(html).not.toContain('Research notes');
    expect(final.seoTitle).toBe(`${KEYWORD}: Inside Their Relationship`);
    expect(final.slug).toBe('tom-kaulitz-heidi-klum');
    expect(final.metaDescription!.length).toBeGreaterThan(50);
    expect(final.seoScore).toBeGreaterThan(0);
    const reports = await client.sEOReport.count({ where: { taskId: task.id, source: 'INTERNAL' } });
    expect(reports).toBe(1);

    // Queue row and detail show the same exact values.
    const list = await query.listTasks(query.taskListQuerySchema.parse({ q: 'Kaulitz' }));
    const row = list.rows.find((r) => r.id === task.id)!;
    expect(row.keyword).toBe(KEYWORD);
    expect(row.secondaryKeywords).toEqual(['Tokio Hotel', 'Germany’s Next Topmodel', 'wedding']);
    expect(row.exampleTitle).toBe(EXAMPLE);
    const d = (await detail.getTaskDetail(task.id))!;
    expect(d.secondaryKeywordList).toEqual(['Tokio Hotel', 'Germany’s Next Topmodel', 'wedding']);
    expect(d.faqList).toHaveLength(5);
    expect(d.quickBioRows).toHaveLength(12);
  });

  it('German website: German prompts, headings and slug; survives a worker crash midway without duplicate prompts', async () => {
    const { task } = await create.createArticleTask(
      { moduleKey: 'celebrity-writer', keyword: KEYWORD, secondaryKeywords: ['Tokio Hotel'], exampleTitle: 'Ein deutlich anderer Beispieltitel', websiteId: siteDe, categoryId: catDe, idempotencyKey: 'single:e2e-de-1' },
      { source: 'SINGLE' },
    );
    expect(task.language).toBe('de');
    expect(task.targetCountry).toBe('Germany');
    // Run until LONG_ARTICLE is being written, then "crash" the worker.
    await drive(task.id, 'de', (_status, stage) => stage === 'LONG_ARTICLE');
    const art = await client.queueJob.findFirstOrThrow({ where: { taskId: task.id, queue: 'article', status: { in: ['WAITING', 'ACTIVE'] } } });
    await client.queueJob.update({ where: { id: art.id }, data: { status: 'ACTIVE', lockedBy: 'crashed-worker', leaseUntil: new Date(Date.now() - 1000) } });
    const r = await recovery.recoverOnStartup('restarted-worker');
    expect(r.article).toBeGreaterThanOrEqual(1);
    const final = await drive(task.id, 'de');
    const responses = await client.chatGPTResponse.findMany({ where: { taskId: task.id } });
    const perStage = responses.reduce<Record<string, number>>((m, x) => ({ ...m, [x.stageKey]: (m[x.stageKey] ?? 0) + 1 }), {});
    expect(perStage).toEqual({ TITLES: 1, RESEARCH: 1, LONG_ARTICLE: 1, FINAL_ARTICLE: 1, FAQS: 1, QUICK_BIO: 1, EXTERNAL_LINKS: 1, IMAGES: 2, HUMANIZE: 1 }); // the photo search and its second try
    // Text prompts carry the German language line; the photo search (an image prompt, like the earlier tool's) does not.
    expect(responses.filter((x) => x.stageKey !== 'IMAGES').every((x) => x.renderedPrompt.endsWith('Schreibe vollständig auf Deutsch für Leserinnen und Leser in Deutschland.'))).toBe(true);
    expect(responses.find((x) => x.stageKey === 'TITLES')!.renderedPrompt).toContain('Ein deutlich anderer Beispieltitel');
    expect(final.assembledHtml).toContain('<h2>Kurzbiografie von Tom Kaulitz</h2>');
    expect(final.assembledHtml).toContain('<h2>Häufig gestellte Fragen</h2>');
    expect(final.assembledHtml).toContain('<th>Merkmal</th><th>Angaben</th>');
    expect(final.keyword).toBe(KEYWORD);
    expect(JSON.parse(final.secondaryKeywords)).toEqual(['Tokio Hotel']);
  });

  it('manual title approval pauses, approval resumes; regeneration resets only dependents and keeps revisions', async () => {
    const { task } = await create.createArticleTask(
      { moduleKey: 'celebrity-writer', keyword: 'Sydney Sweeney', websiteId: siteEn, categoryId: catEn, options: { manualTitleApproval: true }, idempotencyKey: 'single:e2e-approve' },
      { source: 'SINGLE' },
    );
    let t = await drive(task.id, 'en');
    expect(t.status).toBe('AWAITING_TITLE_APPROVAL');
    expect(t.recommendedTitle).toBe('Sydney Sweeney: Inside Their Relationship');
    await actions.approveTitle(task.id, { title: 'Sydney Sweeney: Career, Roles and Rise' });
    t = await drive(task.id, 'en');
    expect(t.status).toBe('LOGIN_REQUIRED');
    const long = await client.chatGPTResponse.findFirstOrThrow({ where: { taskId: task.id, stageKey: 'LONG_ARTICLE' } });
    expect(long.renderedPrompt).toContain('Title: "Sydney Sweeney: Career, Roles and Rise"');

    const before = await client.chatGPTResponse.count({ where: { taskId: task.id } });
    const res = await actions.regenerateStage(task.id, 'FAQS');
    expect(res.plan).toEqual(['FAQS', 'ASSEMBLY', 'SEO_CHECK', 'QUALITY_GATE', 'ARTICLE_APPROVAL', 'WORDPRESS_DRAFT', 'RANKMATH', 'VERIFIED_COMPLETE']);
    const revisions = await client.articleStageRevision.count({ where: { taskId: task.id, key: 'FAQS' } });
    expect(revisions).toBe(1);
    t = await drive(task.id, 'en');
    const after = await client.chatGPTResponse.findMany({ where: { taskId: task.id } });
    expect(after.length).toBe(before + 1);
    expect(after.filter((r) => r.stageKey === 'RESEARCH')).toHaveLength(1);
    expect(after.filter((r) => r.stageKey === 'FAQS' && r.status === 'SUPERSEDED')).toHaveLength(1);
    expect(t.researchNotes).not.toBeNull();
  });

  it('Tigram: general topic goes through ARTICLE/CATEGORY only — no celebrity prompts or Quick Bio', async () => {
    const tech = await client.category.create({ data: { websiteId: siteEn, externalId: 9, name: 'Tech & Apps' } });
    void tech;
    const { task } = await create.createArticleTask(
      { moduleKey: 'tigram-writer', keyword: 'How to Install WordPress', secondaryKeywords: 'hosting, plugins', exampleTitle: 'Not used by default template', websiteId: siteEn, idempotencyKey: 'single:e2e-tigram' },
      { source: 'SINGLE' },
    );
    expect(task.categoryId).toBeNull();
    const final = await drive(task.id, 'en');
    const responses = await client.chatGPTResponse.findMany({ where: { taskId: task.id }, orderBy: { createdAt: 'asc' } });
    // IMAGES = the image plan prompt, then three images: the scripted answer has no plan lines, so the earlier tool's
    // default descriptions are used (the featured one carries the short title). The scripted answers carry no
    // picture, so each image is asked once more in a new chat.
    expect(responses.map((r) => r.stageKey)).toEqual(['ARTICLE', 'CATEGORY', 'EXTERNAL_LINKS', ...Array(7).fill('IMAGES'), 'HUMANIZE']);
    // The image prompts go out in parallel: the featured one (any position) carries the short title.
    expect(responses.filter((r) => r.stageKey === 'IMAGES' && r.renderedPrompt.startsWith('Create this image now') && r.renderedPrompt.includes('spelled exactly: "How to Install WordPress"')).length).toBeGreaterThan(0);
    expect(responses[0].renderedPrompt).toContain('Secondary keywords (use only where natural): hosting, plugins');
    expect(responses[0].renderedPrompt).not.toContain('Not used by default template');
    expect(responses[1].renderedPrompt).toContain('Tech & Apps');
    expect(final.categoryName).toBe('Tech & Apps');
    expect(final.seoTitle).toBe('How to Install WordPress: The Complete Guide');
    expect(final.slug).toBe('how-to-install-wordpress-guide');
    expect(final.quickBioHtml).toBeNull();
    expect(final.assembledHtml).not.toContain('Quick Bio');
    expect(final.assembledHtml).toContain('<h2>Frequently Asked Questions</h2>');
    expect(final.assembledHtml).toContain('<table>');
    expect(final.status).toBe('LOGIN_REQUIRED');
  });

  it('Tigram: skips the CATEGORY prompt when the owner chose a category', async () => {
    const { task } = await create.createArticleTask({ moduleKey: 'tigram-writer', keyword: 'Best Free VPN Apps', websiteId: siteEn, categoryId: catEn, idempotencyKey: 'single:e2e-tigram-cat' }, { source: 'SINGLE' });
    await drive(task.id, 'en');
    const keys = (await client.chatGPTResponse.findMany({ where: { taskId: task.id } })).map((r) => r.stageKey);
    expect([...keys].sort()).toEqual(['ARTICLE', 'EXTERNAL_LINKS', 'HUMANIZE', ...Array(7).fill('IMAGES')]);
    const stage = await client.articleStage.findFirstOrThrow({ where: { taskId: task.id, key: 'CATEGORY' } });
    expect(stage.status).toBe('SKIPPED');
  });

  it('rejects the retired writer and invalid input at the API boundary', async () => {
    await expect(create.createArticleTask({ moduleKey: 'celebrity-writer-2', keyword: 'X Y', websiteId: siteEn, idempotencyKey: 'single:retired-1' }, { source: 'SINGLE' })).rejects.toThrow(/Celebrity Article Writer or Tigram Article Writer/);
    await expect(create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'a', websiteId: siteEn, categoryId: catEn, idempotencyKey: 'single:short-1' }, { source: 'SINGLE' })).rejects.toThrow(/at least 2/);
    await expect(create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'Valid Keyword', websiteId: siteEn, categoryId: catDe, idempotencyKey: 'single:wrongcat-1' }, { source: 'SINGLE' })).rejects.toThrow(/does not belong/);
  });

  it('pauses a same-site duplicate keyword for review until the owner allows it', async () => {
    const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'tom kaulitz heidi klum', websiteId: siteEn, categoryId: catEn, idempotencyKey: 'single:dup-1' }, { source: 'SINGLE' });
    let t = await drive(task.id, 'en');
    expect(t.status).toBe('NEEDS_REVIEW');
    expect(t.message).toMatch(/already has/);
    expect(await client.chatGPTResponse.count({ where: { taskId: task.id } })).toBe(0);
    await actions.allowDuplicate(task.id);
    t = await drive(task.id, 'en');
    expect(await client.chatGPTResponse.count({ where: { taskId: task.id } })).toBe(11); // includes the IMAGES photo search and its second try
    expect(t.assembledHtml).toContain('Frequently Asked Questions');
  });
});
