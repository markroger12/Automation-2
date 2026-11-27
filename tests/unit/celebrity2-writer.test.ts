import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { load } from 'cheerio';
import { setupTestDb } from '../helpers/test-db';
import { makeDriver } from '../helpers/drive';
import { cannedAnswer } from '../helpers/fake-answers';

/**
 * Owner request (2026-11-04): a new writer “Celebrity 2” with the owner's own celebrity prompt (title, primary keyword,
 * secondary keywords → SEO title, meta description, URL slug, H1, introduction, a direct answer without a heading,
 * the Family Profile table, sections with source links, conclusion, five FAQs). The title step stays as in the
 * Celebrity writer, images use the app's own photo prompts, and a celebrity article always goes into the website's
 * “Celebrity” category (German websites: “Prominente”).
 *
 * The answer below is the owner's real ChatGPT answer to that prompt (pasted by the owner, Andrea Soros).
 */
const ANSWER = fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'chatgpt', 'celebrity2-andrea-soros.md'), 'utf8');
const TITLE = "Who is Andrea Soros? All about George Soros' daughter";
const SECONDARY = 'andrea soros colombel,andrea soros net worth,andrea soros children,andrea soros husband,,,,,soros györgy andrea soros,annaliese witschak andrea soros,andrea soros education,george soros andrea soros';

// The article's source links are checked as for any article; no real network in unit tests. One link answers 404.
const fetched: string[] = [];
vi.mock('@/lib/links/net', async (orig) => {
  const real = await orig<typeof import('@/lib/links/net')>();
  return {
    ...real,
    safeFetch: async (url: string) => {
      fetched.push(url);
      const page = (title: string, text: string, status = 200) => ({ url, finalUrl: url, status, contentType: 'text/html; charset=utf-8', body: `<html><head><title>${title}</title></head><body><h1>${title}</h1><p>${text}</p></body></html>`, buffer: Buffer.alloc(0), redirects: [] });
      if (url.includes('propublica')) return page('Not Found', 'Page not found', 404);
      if (url.includes('kq2.com')) return page('George Soros Fast Facts', 'George Soros has three children with Annaliese Witschak: Robert, Andrea and Jonathan Soros.');
      if (url.includes('acumen.org')) return page("Andrea Soros Colombel Returns to Acumen's Board of Directors", 'Acumen welcomes Andrea Soros Colombel back to its board.');
      return page('Andrea Soros Colombel — record', 'Andrea Soros Colombel, philanthropist.');
    },
  };
});

let client: PrismaClient;
let siteEn: string;
let siteDe: string;
let siteBare: string;

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  const { registerBuiltInPipelines } = await import('@/worker/pipelines');
  registerBuiltInPipelines();
  const websites = await import('@/lib/websites');
  siteEn = (await websites.createWebsite({ name: 'Soros Watch', publicUrl: 'https://soros.example', language: 'en', targetCountry: 'United States', timezone: 'America/New_York' })).id;
  siteDe = (await websites.createWebsite({ name: 'Promi Welt Zwei', publicUrl: 'https://promi2.example', language: 'de', targetCountry: 'Germany', timezone: 'Europe/Berlin' })).id;
  siteBare = (await websites.createWebsite({ name: 'No Celebs Here', publicUrl: 'https://bare.example', language: 'en', targetCountry: 'United States', timezone: 'America/New_York' })).id;
  await client.category.createMany({
    data: [
      { websiteId: siteEn, externalId: 1, name: 'Uncategorized', slug: 'uncategorized' },
      { websiteId: siteEn, externalId: 2, name: 'News', slug: 'news' },
      { websiteId: siteEn, externalId: 3, name: 'Celebrity', slug: 'celebrity' },
      { websiteId: siteDe, externalId: 4, name: 'Nachrichten', slug: 'nachrichten' },
      { websiteId: siteDe, externalId: 5, name: 'Prominente', slug: 'prominente' },
      { websiteId: siteBare, externalId: 6, name: 'News', slug: 'news' },
    ],
  });
  // Not real WordPress installs: the article runs completely and waits at the WordPress draft step.
  await client.browserProfile.updateMany({ data: { sessionState: 'LOGIN_REQUIRED' } });
});

describe('Celebrity 2: the owner’s ChatGPT answer is read completely', () => {
  it('SEO title, meta description, slug, the Family Profile table, the sections, the conclusion and the five FAQs', async () => {
    const { parseCelebrity2Article } = await import('@/modules/celebrity2-writer/parsers');
    const p = parseCelebrity2Article(ANSWER, 'en', 'Who Is Andrea Soros? All About George Soros’ Daughter');
    expect(p.problems).toEqual([]);
    expect(p.seoTitle).toBe("Andrea Soros: George Soros' Daughter and Her Philanthropy");
    expect(p.metaDescription).toBe("Meet Andrea Soros, George Soros' daughter, and learn about her education, husband Eric Colombel, family, and philanthropic work.");
    expect(p.slug).toBe('andrea-soros');
    expect(p.h1).toBe("Who Is Andrea Soros? All About George Soros' Daughter");
    const $ = load(`<body>${p.html}</body>`);
    // The H1 is the post's title in WordPress, not a heading in the body.
    expect($('h1').length).toBe(0);
    expect(p.html).not.toContain('SEO Title');
    // A real two-column table (not code), the app's clean table, under the H2 “Family Profile” (owner: an H2, not a bold line).
    expect($('pre, code').length).toBe(0);
    expect($('table.bas-quick-bio').length).toBe(1);
    expect(p.bioRows).toHaveLength(14);
    expect(p.bioRows[0]).toEqual({ attribute: 'Full Name', details: 'Andrea E. Soros Colombel' });
    expect($('table.bas-quick-bio').prev().is('h2')).toBe(true);
    expect($('table.bas-quick-bio').prev().text()).toBe('Family Profile');
    expect($('p').filter((_, e) => $(e).text().trim() === 'Family Profile').length).toBe(0);
    // Introduction and the direct answer (no heading of its own) come before it.
    expect($('body > p').first().text()).toMatch(/^Andrea Soros is an American philanthropist/);
    expect($('table').prevAll('p').length).toBe(2);
    const h2 = $('h2').toArray().map((e) => $(e).text());
    expect(h2.slice(0, 2)).toEqual(['Family Profile', 'Who Is Andrea Soros Colombel?']);
    expect(h2.slice(-2)).toEqual(['Conclusion', 'Frequently Asked Questions']);
    expect(p.faqs).toHaveLength(5);
    expect(p.faqs[0]).toEqual({ question: "Who is Andrea Soros' mother?", answer: 'Her mother is Annaliese Witschak, George Soros\' first wife and the mother of Robert and Jonathan Soros.' });
    // ChatGPT's source links are kept in the article (they are checked by the link stage).
    expect($('a[href^="https://"]').length).toBe(8);
    expect(p.warnings.filter((w) => !/Meta description has/.test(w))).toEqual([]);
    expect(p.words).toBeGreaterThan(1300);
    expect(p.words).toBeLessThan(1700);
  });

  it('owner report: “Family Profile” is an H2 however ChatGPT writes it (bold line, with a colon, H3, German, or left out)', async () => {
    const { parseCelebrity2Article } = await import('@/modules/celebrity2-writer/parsers');
    const headingBeforeTable = (answer: string, language = 'en') => {
      const p = parseCelebrity2Article(answer, language, TITLE);
      expect(p.problems).toEqual([]);
      const $ = load(`<body>${p.html}</body>`);
      const prev = $('table.bas-quick-bio').prev();
      // The direct answer above it stays a paragraph.
      expect(prev.prev().is('p')).toBe(true);
      expect(prev.prev().text()).toMatch(/^Andrea Soros Colombel is the daughter/);
      return `${prev.prop('tagName')} ${prev.text()}`;
    };
    expect(headingBeforeTable(ANSWER)).toBe('H2 Family Profile');
    expect(headingBeforeTable(ANSWER.replace('**Family Profile**', '**Family Profile:**'))).toBe('H2 Family Profile');
    expect(headingBeforeTable(ANSWER.replace('**Family Profile**', '### Family Profile'))).toBe('H2 Family Profile');
    expect(headingBeforeTable(ANSWER.replace('**Family Profile**', '## Family Profile'))).toBe('H2 Family Profile');
    expect(headingBeforeTable(ANSWER.replace('**Family Profile**', '**Familienprofil**'), 'de')).toBe('H2 Familienprofil');
    expect(headingBeforeTable(ANSWER.replace('**Family Profile**\n', ''))).toBe('H2 Family Profile');
    expect(headingBeforeTable(ANSWER.replace('**Family Profile**\n', ''), 'de')).toBe('H2 Familienprofil');
  });

  it('an article saved before (bold “Family Profile” line): Assembly makes it the H2; body image 1 keeps its place', async () => {
    const { parseCelebrity2Article } = await import('@/modules/celebrity2-writer/parsers');
    const { assembleArticle } = await import('@/lib/content/assembly');
    const fresh = parseCelebrity2Article(ANSWER, 'en', TITLE).html;
    const old = fresh.replace('<h2>Family Profile</h2>', '<p><strong>Family Profile</strong></p>');
    expect(old).toContain('<p><strong>Family Profile</strong></p>');
    const img = { slot: 'BODY1', html: '<figure class="bas-body-1"><img src="x.jpg" alt=""></figure>' };
    const a = assembleArticle({ moduleKey: 'celebrity2-writer', language: 'en', title: TITLE, bodyHtml: old, images: [img] } as Parameters<typeof assembleArticle>[0]);
    const $ = load(`<body>${a.html}</body>`);
    expect($('table.bas-quick-bio').prev().is('h2')).toBe(true);
    expect($('table.bas-quick-bio').prev().text()).toBe('Family Profile');
    expect($('p').filter((_, e) => $(e).text().trim() === 'Family Profile').length).toBe(0);
    // The image stays between the article's first and second sections (not right under the table).
    const h2 = $('h2').toArray().map((e) => $(e).text());
    expect(h2.slice(0, 3)).toEqual(['Family Profile', 'Who Is Andrea Soros Colombel?', h2[2]]);
    expect($('figure.bas-body-1').next().is('h2')).toBe(true);
    expect($('figure.bas-body-1').next().text()).toBe(h2[2]);
    // Assembling the new form gives the same article.
    expect(assembleArticle({ moduleKey: 'celebrity2-writer', language: 'en', title: TITLE, bodyHtml: fresh, images: [img] } as Parameters<typeof assembleArticle>[0]).html).toBe(a.html);
  });

  it('a table ChatGPT put into a code block becomes a table; an answer without the table or the FAQs is asked again', async () => {
    const { parseCelebrity2Article } = await import('@/modules/celebrity2-writer/parsers');
    const fenced = ANSWER.replace(/(\| Attribute \| Details \|[\s\S]*?Open Society Foundations \|)/, '```markdown\n$1\n```');
    expect(fenced).toContain('```markdown');
    const f = parseCelebrity2Article(fenced, 'en', TITLE);
    expect(f.problems).toEqual([]);
    expect(f.bioRows).toHaveLength(14);
    expect(load(`<body>${f.html}</body>`)('pre, code').length).toBe(0);
    const noTable = parseCelebrity2Article(ANSWER.replace(/\| Attribute[\s\S]*?Open Society Foundations \|\n/, ''), 'en', TITLE);
    expect(noTable.problems).toContain('The Family Profile table is missing.');
    const noFaq = parseCelebrity2Article(ANSWER.slice(0, ANSWER.indexOf('## Frequently Asked Questions')), 'en', TITLE);
    expect(noFaq.problems).toContain('The “Frequently Asked Questions” section is missing.');
    // No metadata lines: still the article; the app fills them (as for the Celebrity writer).
    const bare = parseCelebrity2Article(ANSWER.slice(ANSWER.indexOf('# Who Is')), 'en', TITLE);
    expect(bare.problems).toEqual([]);
    expect(bare.seoTitle).toBeNull();
    expect(bare.bioRows).toHaveLength(14);
  });
});

describe('Celebrity 2: the owner’s prompt', () => {
  it('is sent as the owner wrote it, with the title, keyword and secondary keywords filled in (German websites: German)', async () => {
    const { CELEBRITY2_ARTICLE_PROMPT } = await import('@/modules/celebrity2-writer/prompt');
    const { renderTemplate } = await import('@/lib/prompts/template');
    const vars = { selected_title: TITLE, keyword: 'Andrea Soros', secondary_keywords: ['andrea soros colombel', 'andrea soros net worth'], language_variant: 'US English' };
    const r = renderTemplate(CELEBRITY2_ARTICLE_PROMPT, vars);
    expect(r.missing).toEqual([]);
    expect(r.text).toMatch(/^## INPUTS\n\n\*\*Title:\*\* `Who is Andrea Soros\? All about George Soros' daughter`\n\n\*\*Primary Keyword:\*\* `Andrea Soros`\n\n\*\*Secondary Keywords \/ Related Entities:\*\* `andrea soros colombel, andrea soros net worth`\n\n\*\*Language:\*\* US English\n/);
    expect(r.text).toContain('- Include `Andrea Soros` naturally.');
    expect(r.text).toContain('Use the secondary keywords from INPUTS selectively.');
    expect(r.text).toContain('# 16. REQUIRED OUTPUT FORMAT');
    expect(r.text).toContain('Never print “Featured Snippet,” “Quick Answer,” or any other heading for the standalone answer paragraph.');
    expect(r.text).toContain('- "Not publicly confirmed."');
    expect(r.text.endsWith('[give bio table in bio table format not in code form] [give the article in canva format]')).toBe(true);
    expect(r.text).not.toMatch(/\{\{|\}\}|""/);
    const de = renderTemplate(CELEBRITY2_ARTICLE_PROMPT, { ...vars, secondary_keywords: [], language_variant: 'German' });
    expect(de.text).toContain('**Language:** German');
    expect(de.text).toContain('Write the article in natural, fluent German.');
    expect(de.text).not.toContain('US English');
    expect(de.text).not.toContain('Secondary Keywords / Related Entities');
  });

  it('Prompt Manager lists the Celebrity 2 article prompt; the Celebrity category prompt (no longer sent) is not listed', async () => {
    // As in an installation from before: the old Celebrity CATEGORY prompt is still stored.
    await client.promptTemplate.create({ data: { moduleKey: 'celebrity-writer', stageKey: 'CATEGORY', name: 'Celebrity — Category', description: 'old', content: 'CATEGORY: …', defaultHash: 'x', defaultVersion: 1 } });
    const { listPrompts } = await import('@/lib/prompts/manage');
    const keys = (await listPrompts()).map((p) => `${p.moduleKey}:${p.stageKey}`);
    expect(keys).toContain('celebrity2-writer:ARTICLE');
    expect(keys).toContain('celebrity-writer:TITLES');
    expect(keys).not.toContain('celebrity-writer:CATEGORY');
    expect(keys).toContain('tigram-writer:CATEGORY');
    expect(await client.promptTemplate.count({ where: { moduleKey: 'celebrity-writer', stageKey: 'CATEGORY' } })).toBe(1);
    // Celebrity 2 borrows the Celebrity writer's title and photo prompts.
    const { promptModuleFor } = await import('@/lib/prompts/load');
    expect(['TITLES', 'IMAGE_SEARCH', 'PHOTO_CHECK', 'ARTICLE', 'HUMANIZE'].map((k) => promptModuleFor('celebrity2-writer', k))).toEqual(['celebrity-writer', 'celebrity-writer', 'celebrity-writer', 'celebrity2-writer', 'shared']);
  });

  it('the length of the owner’s prompt is kept (only the inputs changed)', async () => {
    const { CELEBRITY2_ARTICLE_PROMPT } = await import('@/modules/celebrity2-writer/prompt');
    const sections = CELEBRITY2_ARTICLE_PROMPT.match(/^# \d+\. .+$/gm) ?? [];
    expect(sections).toEqual([
      '# 1. YOUR ROLE',
      '# 2. MANDATORY RESEARCH — BEFORE WRITING',
      '# 3. VERIFY THE SEARCH PREMISE',
      '# 4. SEARCH INTENT ANALYSIS',
      '# 5. ACCURACY, CONFLICTS & UNCERTAINTY',
      '# 6. CELEBRITY FAMILY PRIVACY & ETHICS',
      '# 7. TRUSTED EXTERNAL LINKS — MANDATORY',
      '# 8. SEO METADATA',
      '# 9. MAIN ARTICLE REQUIREMENTS',
      '# 10. NATURAL HUMAN-QUALITY WRITING',
      '# 11. SEARCH ENGINE OPTIMIZATION',
      '# 12. E-E-A-T & PEOPLE-FIRST QUALITY',
      '# 13. FREQUENTLY ASKED QUESTIONS',
      '# 14. CONCLUSION',
      '# 15. FINAL VALIDATION — MANDATORY',
      '# 16. REQUIRED OUTPUT FORMAT',
      '# 17. FINAL OUTPUT INSTRUCTIONS',
    ]);
  });

  it('owner report: asks for “Family Profile” as an H2; a saved prompt still as shipped is upgraded, an edited one is kept', async () => {
    const { CELEBRITY2_ARTICLE_PROMPT } = await import('@/modules/celebrity2-writer/prompt');
    expect(CELEBRITY2_ARTICLE_PROMPT).toContain('\n## Family Profile\n\n[Clean two-column HTML-compatible table');
    expect(CELEBRITY2_ARTICLE_PROMPT).toContain('add the H2 heading `## Family Profile` (an H2 heading, not bold text)');
    expect(CELEBRITY2_ARTICLE_PROMPT).not.toContain('**Family Profile**');
    const { findPromptDefault } = await import('@/modules/prompt-defaults');
    const { promptHash, seedPrompt } = await import('@/lib/prompts/seed');
    const def = findPromptDefault('celebrity2-writer', 'ARTICLE')!;
    // The text shipped before (v1): a bold “Family Profile” line.
    const v1 = CELEBRITY2_ARTICLE_PROMPT.replace('## Family Profile\n\n[Clean', '**Family Profile**\n\n[Clean').replace(
      'add the H2 heading `## Family Profile` (an H2 heading, not bold text), then include one clean, two-column HTML-compatible family profile table directly under it.',
      'include one clean, two-column HTML-compatible family profile table.',
    );
    expect(def.version).toBe(2);
    expect(def.previousHashes).toContain(promptHash(v1));
    const where = { moduleKey_stageKey: { moduleKey: 'celebrity2-writer', stageKey: 'ARTICLE' } };
    await client.promptTemplate.update({ where, data: { content: v1, defaultVersion: 1, customized: false } });
    expect(await seedPrompt(client, def)).toBe('upgraded');
    expect((await client.promptTemplate.findUniqueOrThrow({ where })).content).toBe(CELEBRITY2_ARTICLE_PROMPT);
    // The owner's own edit is never overwritten.
    await client.promptTemplate.update({ where, data: { content: `${v1}\nMy own line.`, defaultVersion: 1, customized: true } });
    expect(await seedPrompt(client, def)).toBe('kept-customized');
    await client.promptTemplate.update({ where, data: { content: CELEBRITY2_ARTICLE_PROMPT, defaultVersion: 2, customized: false } });
  });
});

describe('Celebrity articles always go into the “Celebrity” category (German: “Prominente”)', () => {
  it('finds it by name or slug, in the website’s language first', async () => {
    const { findCelebrityCategory } = await import('@/lib/celebrity-category');
    expect(findCelebrityCategory([{ name: 'News' }, { name: 'Celebrities' }], 'en')?.name).toBe('Celebrities');
    expect(findCelebrityCategory([{ name: 'Stars', slug: 'celebrity' }], 'en')?.name).toBe('Stars');
    expect(findCelebrityCategory([{ name: 'Celebrity' }, { name: 'Prominente' }], 'de')?.name).toBe('Prominente');
    expect(findCelebrityCategory([{ name: 'Promis' }], 'de')?.name).toBe('Promis');
    expect(findCelebrityCategory([{ name: 'Celebrity' }], 'de')?.name).toBe('Celebrity');
    expect(findCelebrityCategory([{ name: 'News' }, { name: 'Celebrity Gossip' }], 'en')).toBeNull();
  });

  it('a chosen category is not used; a website without it gets a clear message', async () => {
    const create = await import('@/lib/tasks/create');
    const news = await client.category.findFirstOrThrow({ where: { websiteId: siteEn, name: 'News' } });
    for (const moduleKey of ['celebrity-writer', 'celebrity2-writer']) {
      const { task } = await create.createArticleTask({ moduleKey, keyword: `Category test ${moduleKey}`, websiteId: siteEn, categoryId: news.id, idempotencyKey: `c2:cat:${moduleKey}` }, { source: 'SINGLE' });
      expect(task.categoryName).toBe('Celebrity');
      const de = await create.createArticleTask({ moduleKey, keyword: `Kategorie ${moduleKey}`, websiteId: siteDe, idempotencyKey: `c2:cat-de:${moduleKey}` }, { source: 'SINGLE' });
      expect(de.task.categoryName).toBe('Prominente');
      await expect(create.createArticleTask({ moduleKey, keyword: `No category ${moduleKey}`, websiteId: siteBare, idempotencyKey: `c2:cat-bare:${moduleKey}` }, { source: 'SINGLE' })).rejects.toThrow('No Celebs Here has no “Celebrity” category. Celebrity articles always go into “Celebrity” (English websites: “Celebrity”, German websites: “Prominente”). Create it in WordPress, then Websites → No Celebs Here → Sync categories.');
    }
    // Tigram keeps the owner's choice.
    const { task } = await create.createArticleTask({ moduleKey: 'tigram-writer', keyword: 'Category test tigram', websiteId: siteEn, categoryId: news.id, idempotencyKey: 'c2:cat:tigram' }, { source: 'SINGLE' });
    expect(task.categoryName).toBe('News');
    await client.articleTask.deleteMany({ where: { idempotencyKey: { startsWith: 'c2:cat' } } });
  });
});

describe('Celebrity 2 end to end (scripted ChatGPT, the owner’s real answer)', () => {
  it('titles, then the owner’s prompt with the approved title; the article keeps ChatGPT’s order and its checked links', async () => {
    const answers = (stageKey: string, prompt: string, language: 'en' | 'de', keyword: string) => {
      if (stageKey === 'TITLES') return `1. ${TITLE}\n2. Andrea Soros: George Soros' Daughter and Philanthropist\n3. Andrea Soros Colombel: Family, Husband and Work\n\nRecommended Title: ${TITLE}`;
      if (stageKey === 'ARTICLE') return ANSWER;
      return cannedAnswer(stageKey, prompt, language, keyword);
    };
    const { drive } = makeDriver(client, answers);
    const create = await import('@/lib/tasks/create');
    const { task } = await create.createArticleTask({ moduleKey: 'celebrity2-writer', keyword: 'Andrea Soros', secondaryKeywords: SECONDARY, exampleTitle: TITLE, websiteId: siteEn, idempotencyKey: 'c2:e2e-1' }, { source: 'SINGLE' });
    expect(task.categoryName).toBe('Celebrity');
    const final = await drive(task.id);
    const responses = await client.chatGPTResponse.findMany({ where: { taskId: task.id }, orderBy: { createdAt: 'asc' } });
    // No category prompt, no link prompt: the title step, the article, then the photo search (the app's own prompts).
    expect(responses.map((r) => r.stageKey).slice(0, 2)).toEqual(['TITLES', 'ARTICLE']);
    expect(new Set(responses.slice(2).map((r) => r.stageKey))).toEqual(new Set(['IMAGES']));
    expect(responses[0].renderedPrompt).toContain(`Reference title for direction only: "${TITLE}"`);
    const prompt = responses[1].renderedPrompt;
    expect(prompt.startsWith(`## INPUTS\n\n**Title:** \`${TITLE}\`\n\n**Primary Keyword:** \`Andrea Soros\`\n\n**Secondary Keywords / Related Entities:** \`andrea soros colombel, andrea soros net worth, andrea soros children, andrea soros husband, soros györgy andrea soros, annaliese witschak andrea soros, andrea soros education, george soros andrea soros\``)).toBe(true);
    // Exactly the owner's prompt with its inputs, then only the app's language line (no SEO brief: the prompt sets
    // its own search intent).
    const { CELEBRITY2_ARTICLE_PROMPT } = await import('@/modules/celebrity2-writer/prompt');
    const { renderTemplate } = await import('@/lib/prompts/template');
    const secondary = SECONDARY.split(',').filter(Boolean);
    const expected = renderTemplate(CELEBRITY2_ARTICLE_PROMPT, { selected_title: TITLE, keyword: 'Andrea Soros', secondary_keywords: secondary, language_variant: 'US English' }).text;
    expect(prompt).toBe(`${expected}\n\nWrite in English for readers in the United States.`);
    expect(prompt).not.toMatch(/SEO brief|Search intent:/i);

    const t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(final.status).toBe('LOGIN_REQUIRED');
    expect(t.selectedTitle).toBe(TITLE);
    expect(t.categoryName).toBe('Celebrity');
    expect(t.seoTitle).toBe("Andrea Soros: George Soros' Daughter and Her Philanthropy");
    expect(t.slug).toBe('andrea-soros');
    expect(JSON.parse(t.faqs)).toHaveLength(5);
    const $ = load(`<body>${t.assembledHtml}</body>`);
    const h2 = $('h2').toArray().map((e) => $(e).text());
    expect(h2.slice(-2)).toEqual(['Conclusion', 'Frequently Asked Questions']);
    expect($('table.bas-quick-bio tbody tr').length).toBe(14);
    // The assembled article keeps “Family Profile” as the H2 right above its table.
    expect($('table.bas-quick-bio').prev().is('h2')).toBe(true);
    expect($('table.bas-quick-bio').prev().text()).toBe('Family Profile');
    expect($('h1').length).toBe(0);
    // Every source link was opened; the one answering 404 became its text.
    expect(new Set(fetched.filter((u) => !u.startsWith('https://soros.example/'))).size).toBe(8);
    const kept = $('a[data-bas-link="ext"]').toArray().map((a) => $(a).attr('href'));
    expect(kept).toHaveLength(7);
    expect(kept.some((h) => h?.includes('propublica'))).toBe(false);
    expect($.text()).toContain('records for Fourdoves Foundation');
    // The checks count its table and its five FAQs.
    const seo = await client.articleStage.findFirstOrThrow({ where: { taskId: task.id, key: 'SEO_CHECK' } });
    const checks = JSON.parse(seo.outputJson ?? '{}').checks as { id: string; passed: boolean; detail: string }[];
    expect(checks.find((c) => c.id === 'faq-count')).toMatchObject({ passed: true, detail: '5 found' });
    expect(checks.find((c) => c.id === 'quick-bio')).toMatchObject({ passed: true });
    expect(checks.find((c) => c.id === 'category')).toMatchObject({ passed: true, detail: 'Celebrity' });
    expect(checks.find((c) => c.id === 'word-count')).toMatchObject({ passed: true });
  });
});

describe('Celebrity 2 in the workflow', () => {
  it('a keyword given Celebrity 2 starts a Celebrity 2 article; a website without the celebrity category says what to do', async () => {
    const wf = await import('@/lib/workflow/service');
    const sched = await import('@/lib/workflow/scheduler');
    const base = { active: true, writerPreference: 'AUTO' as const, slots: ['9:00 AM', '3:00 PM'], weekdays: [], writeAheadHours: 48, maxBacklog: 3, imagesOverride: 'off' as const, requestIndexing: false, maxRetries: 2 };
    await wf.saveWorkflow(siteEn, base);
    await wf.saveWorkflow(siteBare, base);
    await wf.addKeywords(siteEn, { text: 'Andrea Soros Colombel', writers: { '1': 'CELEBRITY2' } });
    await wf.addKeywords(siteBare, { text: 'Alexander Soros', writers: { '1': 'CELEBRITY2' } });
    await sched.schedulerTick(new Date('2026-11-05T02:00:00Z'));
    const started = await client.workflowKeyword.findFirstOrThrow({ where: { keyword: 'Andrea Soros Colombel' } });
    expect(started.status).toBe('WRITING');
    const task = await client.articleTask.findUniqueOrThrow({ where: { id: started.taskId! } });
    expect(task).toMatchObject({ moduleKey: 'celebrity2-writer', categoryName: 'Celebrity', source: 'WORKFLOW' });
    const waiting = await client.workflowKeyword.findFirstOrThrow({ where: { keyword: 'Alexander Soros' } });
    expect(waiting.status).toBe('WAITING');
    expect(waiting.lastError).toBe('No Celebs Here has no “Celebrity” category. Celebrity articles always go into “Celebrity” (English websites: “Celebrity”, German websites: “Prominente”). Create it in WordPress, then Websites → No Celebs Here → Sync categories.');
  });
});

/**
 * Owner report (Celebrity 2, “Ricardo Joel Gomez”): “SEO Title: …”, “Meta Description: …” and “URL Slug: …” stood at the
 * top of the WordPress article. The owner's prompt asks for the label on its own line and the value on the next; the
 * extension turns that line break into a newline (its toMarkdown: <br> → “\n”), and the parser read only a value on
 * the label's own line, so the lines went into the article (and the meta description was taken from them).
 */
const TOP = ANSWER.slice(0, ANSWER.indexOf('# Who Is'));
const REST = ANSWER.slice(ANSWER.indexOf('# Who Is'));
const nextLine = (bold: boolean, nbsp: boolean) => {
  const sp = nbsp ? ' ' : ' ';
  const l = (label: string) => (bold ? `**${label}:**` : `${label}:`);
  return `${l(`SEO${sp}Title`)}\nAndrea Soros: George Soros' Daughter and Her Philanthropy\n${l('Meta Description')}\nMeet Andrea Soros, George Soros' daughter, and learn about her education, husband Eric Colombel, family, and philanthropic work.\n${l('URL Slug')}\nandrea-soros\n\n${REST}`;
};

describe('owner report: the SEO lines were in the article (value on the line after its label)', () => {
  it('reads the value on the next line, bold or plain, with a non-breaking space, after the writing block’s title', async () => {
    expect(TOP).toContain('**SEO Title:** Andrea Soros');
    const { parseCelebrity2Article } = await import('@/modules/celebrity2-writer/parsers');
    for (const text of [nextLine(true, false), nextLine(false, false), nextLine(false, true), `Who Is Andrea Soros? All About George Soros' Daughter\n\n${nextLine(true, true)}`]) {
      const p = parseCelebrity2Article(text, 'en', TITLE);
      expect(p.problems).toEqual([]);
      expect(p).toMatchObject({ seoTitle: "Andrea Soros: George Soros' Daughter and Her Philanthropy", slug: 'andrea-soros' });
      expect(p.metaDescription).toMatch(/^Meet Andrea Soros, George Soros' daughter/);
      expect(p.html).not.toMatch(/SEO\s*Title|Meta Description|URL Slug/);
      expect(load(`<body>${p.html}</body>`)('body > p').first().text()).toMatch(/^Andrea Soros is an American philanthropist/);
    }
    // Tigram reads the same forms.
    const { parseTigramArticle } = await import('@/modules/tigram-writer/parsers');
    expect(parseTigramArticle(nextLine(false, false), 'en')).toMatchObject({ seoTitle: "Andrea Soros: George Soros' Daughter and Her Philanthropy", slug: 'andrea-soros', problems: [] });
  });

  it('an article saved with the lines: Regenerate → Assembly takes them out and uses them as the SEO fields', async () => {
    const answers = (stageKey: string, prompt: string, language: 'en' | 'de', keyword: string) => {
      if (stageKey === 'TITLES') return `1. ${TITLE}\n2. Andrea Soros: George Soros' Daughter and Philanthropist\n\nRecommended Title: ${TITLE}`;
      if (stageKey === 'ARTICLE') return ANSWER;
      return cannedAnswer(stageKey, prompt, language, keyword);
    };
    const { drive } = makeDriver(client, answers);
    const create = await import('@/lib/tasks/create');
    const { task } = await create.createArticleTask({ moduleKey: 'celebrity2-writer', keyword: 'Andrea Soros philanthropy', websiteId: siteEn, idempotencyKey: 'c2:broken-draft' }, { source: 'SINGLE' });
    expect((await drive(task.id)).status).toBe('LOGIN_REQUIRED');
    // As the owner's article was saved: the three lines (one paragraph each, label and value on two lines) on top,
    // and the SEO fields filled in without them.
    const broken = `<p>SEO Title:\nAndrea Soros: George Soros' Daughter and Her Philanthropy</p><p>Meta Description:\nMeet Andrea Soros, George Soros' daughter, and learn about her education, husband Eric Colombel, family, and philanthropic work.</p><p>URL Slug:\nandrea-soros</p>`;
    const links = await client.articleStage.findFirstOrThrow({ where: { taskId: task.id, key: 'EXTERNAL_LINKS' } });
    await client.articleStage.update({ where: { id: links.id }, data: { outputHtml: broken + links.outputHtml } });
    await client.articleTask.update({ where: { id: task.id }, data: { seoTitle: TITLE, metaDescription: "SEO Title: Andrea Soros: George Soros' Daughter and Her Philanthropy Meta Description: Meet Andrea Soros", slug: 'andrea-soros-colombel' } });
    const actions = await import('@/lib/tasks/actions');
    await actions.regenerateStage(task.id, 'ASSEMBLY');
    expect((await drive(task.id)).status).toBe('LOGIN_REQUIRED');
    const t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.assembledHtml).not.toMatch(/SEO Title|Meta Description:|URL Slug/);
    expect(t).toMatchObject({ seoTitle: "Andrea Soros: George Soros' Daughter and Her Philanthropy", slug: 'andrea-soros' });
    expect(t.metaDescription).toMatch(/^Meet Andrea Soros, George Soros' daughter/);
    expect(load(`<body>${t.assembledHtml}</body>`)('body > p').first().text()).toMatch(/^Andrea Soros is an American philanthropist/);
    const asm = await client.articleStage.findFirstOrThrow({ where: { taskId: task.id, key: 'ASSEMBLY' } });
    expect(asm.message).toContain('The SEO title, meta description, URL slug line(s) were taken out of the article text and used as the SEO fields.');
  });

  it('an SEO line left anywhere in a person article stops it before WordPress', async () => {
    const { evaluateQuality } = await import('@/lib/quality/gate');
    const { runSeoChecks } = await import('@/lib/seo/checks');
    const { parseCelebrity2Article } = await import('@/modules/celebrity2-writer/parsers');
    const html = parseCelebrity2Article(ANSWER, 'en', TITLE).html.replace('<h2>Conclusion</h2>', '<p>SEO Title: Andrea Soros Again</p><h2>Conclusion</h2>');
    const input = { html, moduleKey: 'celebrity2-writer', language: 'en', keyword: 'Andrea Soros', title: TITLE, seoTitle: 'x', metaDescription: 'y', slug: 'andrea-soros', categoryName: 'Celebrity', tags: [], expectedFaqCount: 5, quickBioRows: 12, maxWords: 1300, wordRange: null, minKeywordOccurrences: 3, maxKeywordOccurrences: 8, densityCeilingPct: 2.5, externalLinksEnabled: true, internalLinksEnabled: true, imagesExpected: false };
    const seo = runSeoChecks(input);
    const q = evaluateQuality({ html, moduleKey: 'celebrity2-writer', language: 'en', keyword: 'Andrea Soros', seo, reviewThreshold: 0, densityCeilingPct: 2.5, expectedFaqCount: 5, categoryValid: true, assemblyWarnings: [], imagesRequired: false, imagesPresent: 0 });
    expect(q.hardStops.map((h) => h.code)).toContain('SEO_LINES_IN_TEXT');
    // A Tigram article about SEO may quote a meta description in its text.
    const t = evaluateQuality({ html, moduleKey: 'tigram-writer', language: 'en', keyword: 'Andrea Soros', seo, reviewThreshold: 0, densityCeilingPct: 2.5, expectedFaqCount: 5, categoryValid: true, assemblyWarnings: [], imagesRequired: false, imagesPresent: 0 });
    expect(t.hardStops.map((h) => h.code)).not.toContain('SEO_LINES_IN_TEXT');
  });
});
