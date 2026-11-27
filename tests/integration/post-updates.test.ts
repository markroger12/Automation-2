import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient, Website } from '@prisma/client';
import type { BrowserContext } from 'playwright';
import { setupTestDb } from '../helpers/test-db';
import { configureTestBrowser } from '../helpers/browser';
import { startFakeWordPress, type FakeWp } from '../fixtures/fake-wordpress';

/**
 * “Update to latest” (owner request 2026-11-27) against the fake WordPress: the website's posts are read into the
 * app, one is given to ChatGPT (answered here as ChatGPT would), checked, approved and written to the same post; the
 * image, the shortcode and the table's shape come back exactly; an edit made in WordPress meanwhile is never
 * overwritten; an applied update can be undone.
 */
let client: PrismaClient;
let wp: FakeWp;
let site: Website;
let browser: typeof import('@/wordpress/browser');
let posts: typeof import('@/wordpress/post-updates');
let service: typeof import('@/lib/posts/service');
let jobs: typeof import('@/lib/chatgpt/jobs');

const IMAGE = `<!-- wp:image {"id":12,"sizeSlug":"full"} -->
<figure class="wp-block-image size-full"><img src="https://img.example/sarah.jpg" alt="Sarah Jones" class="wp-image-12"/></figure>
<!-- /wp:image -->`;
const GUTENBERG = `<!-- wp:paragraph -->
<p>Sarah Jones is an American actress. She is <strong>34 years old</strong> and lives in <a href="https://www.imdb.com/name/nm1/">Los Angeles</a>. Her career started on stage in New York, and she later moved to television drama, where critics praised her careful work in several long-running series. [ad id="3"]</p>
<!-- /wp:paragraph -->

${IMAGE}

<!-- wp:heading -->
<h2 class="wp-block-heading">Sarah Jones Net Worth in 2024</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Her net worth is reportedly around $2 million in 2024, according to entertainment outlets that follow her contracts and her work in film, television and advertising campaigns over the last ten years.</p>
<!-- /wp:paragraph -->

<!-- wp:table -->
<figure class="wp-block-table"><table><tbody><tr><td>Age</td><td>34</td></tr><tr><td>Born</td><td>1990</td></tr></tbody></table></figure>
<!-- /wp:table -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Personal Life</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>She married the director Mike Ross in 2019 and the couple has one child. They live in California and rarely speak about their family in interviews, preferring to keep their private life out of the press.</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph -->
<p>Outside of acting, she supports two charities for young artists and teaches a short summer workshop on stage acting. Friends describe her as private, curious and very well prepared, and she reads every script several times before she agrees to a role.</p>
<!-- /wp:paragraph -->`;

/** What ChatGPT gets: the article part of the prompt. */
const articleOf = (prompt: string) => prompt.split('The article:\n\n')[1].replace(/\n\n(Write in English|Schreibe vollständig)[\s\S]*$/, '');

/** Answer the waiting ChatGPT prompt (as the extension does), with `make` building the answer from the article. */
async function answer(make: (article: string, prompt: string) => string) {
  const claim = await jobs.claimChatGPTJob({ installId: 'test', tabId: 't1' });
  if (!('job' in claim)) throw new Error('no ChatGPT prompt is waiting');
  expect(claim.payload.postUpdateId).toBeTruthy();
  expect(claim.payload.taskId).toBeNull();
  const done = await jobs.completeChatGPTJob({ jobId: claim.job.id, tabId: 't1', text: make(articleOf(claim.payload.prompt), claim.payload.prompt), images: [], conversationUrl: 'https://chatgpt.com/c/11111111-2222-4333-8444-555555555555' });
  expect(done).toEqual({ ok: true });
  return claim.payload.prompt;
}

const format = (o: { title: string; meta?: string; changes: string[]; sources?: string[]; article: string }) =>
  ['===TITLE===', o.title, '===META_DESCRIPTION===', o.meta ?? '', '===CHANGES===', ...o.changes.map((c) => `- ${c}`), '===SOURCES===', ...(o.sources ?? []).map((s) => `- ${s}`), '===ARTICLE===', o.article, '===END==='].join('\n');

const updated = (article: string) =>
  article
    .replace('34 years old', '36 years old')
    .replace('Net Worth in 2024', 'Net Worth in 2026')
    .replace('around $2 million in 2024', 'around $3 million in 2026')
    .replace('| Age | 34 |', '| Age | 36 |')
    .replace('rarely speak about their family in interviews', 'welcomed a second child in 2025 and still rarely speak about their family in interviews');

/** Start an update and run its first step (the worker's control job). */
async function begin(sitePostId: string) {
  const { started } = await service.startUpdates([sitePostId]);
  expect(started).toHaveLength(1);
  await posts.startPostUpdate(started[0]);
  const u = await client.postUpdate.findUniqueOrThrow({ where: { id: started[0] } });
  expect(u.status, u.message ?? '').toBe('WRITING');
  return started[0];
}

beforeAll(async () => {
  configureTestBrowser();
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  browser = await import('@/wordpress/browser');
  const session = await import('@/wordpress/session');
  posts = await import('@/wordpress/post-updates');
  service = await import('@/lib/posts/service');
  jobs = await import('@/lib/chatgpt/jobs');
  browser.onWordPressContext(async (context: BrowserContext) => {
    setTimeout(async () => {
      const page = context.pages()[0];
      if (!page || !/wp-login\.php/.test(page.url())) return;
      await page.fill('#user_login', 'owner').catch(() => {});
      await page.fill('#user_pass', 'owner-typed-this').catch(() => {});
      await page.click('#wp-submit').catch(() => {});
    }, 1200);
  });
  wp = await startFakeWordPress({ rankMath: true });
  const websites = await import('@/lib/websites');
  const created = await websites.createWebsite({ name: 'Update Site', publicUrl: wp.url, language: 'en', targetCountry: 'United States', timezone: 'UTC' });
  site = await client.website.findUniqueOrThrow({ where: { id: created.id } });
  expect((await session.interactiveLogin(site, async () => true, 60_000)).state).toBe('ACTIVE');
  site = await client.website.findUniqueOrThrow({ where: { id: site.id } });
});

afterAll(async () => {
  await browser.closeAllContexts();
  await wp.close();
});

describe('Update to latest', () => {
  let sarahId = '';
  let sarahPostId = 0;

  it("reads the website's published posts (also the ones the app did not write); drafts and recent posts are left out when asked", async () => {
    const old = '2024-03-01T10:00:00';
    const sarah = wp.addPost({ title: 'Sarah Jones Net Worth 2024', status: 'publish', slug: 'sarah-jones', content: GUTENBERG, categories: [3] });
    sarah.modified_gmt = old;
    sarah.date_gmt = old;
    sarahPostId = sarah.id;
    const classic = wp.addPost({ title: 'Mike Ross Biography', status: 'publish', slug: 'mike-ross', content: 'Mike Ross is an American film director known for quiet family dramas and careful work with young actors. He studied film in Chicago and worked as an assistant editor for several years before directing his first feature.\n\n[gallery ids="1,2"]\n\nHe was born in 1985. His films have been shown at festivals in Toronto, Berlin and Sundance, and critics often praise their restrained style, their long takes and the natural performances of their casts.\n\nHe lives in California with the actress Sarah Jones and their child. Between films he teaches a directing class and writes for a small film magazine about editing and sound.', categories: [3] });
    classic.modified_gmt = old;
    const recent = wp.addPost({ title: 'Fresh News', status: 'publish', slug: 'fresh', content: '<p>New.</p>', categories: [3] });
    recent.modified_gmt = new Date().toISOString().slice(0, 19);
    wp.addPost({ title: 'A Draft', status: 'draft', slug: 'draft', content: '<p>Draft.</p>', categories: [3] });

    expect(await posts.importSitePosts(site.id, { olderThanMonths: 12, categoryIds: [] })).toMatchObject({ read: 2, added: 2 });
    let rows = await client.sitePost.findMany({ where: { websiteId: site.id }, orderBy: { wpPostId: 'asc' } });
    expect(rows.map((r) => r.title)).toEqual(['Sarah Jones Net Worth 2024', 'Mike Ross Biography']);
    expect(rows[0]).toMatchObject({ editor: 'GUTENBERG', status: 'publish', contentRaw: GUTENBERG });
    expect(rows[1].editor).toBe('CLASSIC');
    // All posts: the recent one too; reading again refreshes, never duplicates.
    expect(await posts.importSitePosts(site.id, { olderThanMonths: null, categoryIds: [] })).toMatchObject({ read: 3, added: 1, refreshed: 2 });
    rows = await client.sitePost.findMany({ where: { websiteId: site.id } });
    expect(rows).toHaveLength(3);
    sarahId = rows.find((r) => r.wpPostId === sarah.id)!.id;
    const list = await service.listSitePosts({ websiteId: site.id, olderThanMonths: 12 });
    expect(list.total).toBe(2);
    // Filters and order (owner request: “filters … or sorting”): counts per state, years and named categories.
    const all = await service.listSitePosts({ websiteId: site.id, sort: 'title-asc' });
    expect(all).toMatchObject({ total: 3, all: 3, page: 1 });
    expect(all.posts.map((p) => p.title)).toEqual([...all.posts.map((p) => p.title)].sort((a, b) => a.localeCompare(b)));
    expect(all.facets.states).toMatchObject({ all: 3, none: 3 });
    expect(all.posts.every((p) => Array.isArray(p.categoryIds))).toBe(true);
    expect((await service.listSitePosts({ websiteId: site.id, q: 'MIKE ross' })).posts.map((p) => p.title)).toEqual(['Mike Ross Biography']);
    expect((await service.listSitePosts({ websiteId: site.id, state: 'ready' })).total).toBe(0);
    // A page past the end shows the last page.
    expect((await service.listSitePosts({ websiteId: site.id, page: 9, pageSize: 10 })).page).toBe(1);
  });

  it('updates a post with ChatGPT: the prompt carries the article with marks; the answer is checked and waits for approval', async () => {
    const id = await begin(sarahId);
    expect((await client.postUpdate.findUniqueOrThrow({ where: { id } })).status).toBe('WRITING');
    const prompt = await answer((article) =>
      format({ title: 'Sarah Jones Net Worth 2026', meta: 'Sarah Jones net worth in 2026: her career, earnings, age and family life, updated with the latest verified information from reliable sources.', changes: ['Age 34 → 36 (born 1990)', 'Net worth updated to 2026 estimates', 'Second child (2025)'], sources: ['https://news.example/sarah — net worth 2026'], article: updated(article) }),
    );
    // The image, the ad shortcode and the link travel as marks; today's date and the language are in the prompt.
    expect(prompt).toMatch(/\{K1\}/);
    expect(prompt).toContain('{L1}Los Angeles{/L1}');
    expect(prompt).not.toContain('wp-image-12');
    expect(prompt).toContain('Main keyword (keep it as the page');
    expect(prompt).toMatch(/Write in English for readers in the United States\.$/);
    expect(await service.processPostUpdate(id)).toMatchObject({ state: 'done' });
    const u = await service.getPostUpdate(id);
    expect(u.status, u.message ?? '').toBe('READY');
    expect(u.checks.filter((c) => !c.passed)).toEqual([]);
    expect(u.proposedTitle).toBe('Sarah Jones Net Worth 2026');
    expect(u.comparison!.onlyInApp.join(' ')).toContain('36 years old');
    expect(u.comparison!.onlyInWordPress.join(' ')).toContain('34 years old');
    expect(u.sources).toEqual([{ url: 'https://news.example/sarah', note: 'net worth 2026' }]);
    expect(u.post.live).toBe(true);

    // A live post: the website's switch and the typed words first.
    await expect(service.approvePostUpdate(id, 'UPDATE LIVE POST')).rejects.toMatchObject({ code: 'LIVE_UPDATES_OFF' });
    await client.website.update({ where: { id: site.id }, data: { allowLiveUpdates: true } });
    await expect(service.approvePostUpdate(id, 'yes')).rejects.toThrow(/UPDATE LIVE POST/);
    await service.approvePostUpdate(id, 'UPDATE LIVE POST');
    expect(await posts.applyPostUpdate(id)).toMatchObject({ status: 'APPLIED' });

    const post = wp.posts.get(sarahPostId)!;
    expect(post.title).toBe('Sarah Jones Net Worth 2026');
    expect(post.status).toBe('publish');
    expect(post.content).toContain(IMAGE);
    expect(post.content).toContain('[ad id="3"]');
    expect(post.content).toContain('<a href="https://www.imdb.com/name/nm1/">Los Angeles</a>');
    expect(post.content).toContain('36 years old');
    expect(post.content).toContain('second child in 2025');
    // The table had no header row and still has none.
    expect(post.content).toContain('<tbody><tr><td>Age</td><td>36</td></tr><tr><td>Born</td><td>1990</td></tr></tbody>');
    expect(post.content).not.toContain('<thead>');
    expect(wp.requests.some((r) => r.path.includes('rankmath/v1/updateMeta') && r.body.includes('rank_math_description'))).toBe(true);
    const done = await service.getPostUpdate(id);
    expect(done.status).toBe('APPLIED');
    // Google is asked to crawl the updated post again (the Search Console request, once per update).
    expect(done.result.indexing).toMatch(/Indexing request queued/);
    expect(await client.queueJob.count({ where: { queue: 'gsc', idempotencyKey: `gsc-index:post:${id}` } })).toBe(1);
    expect((await client.sitePost.findUniqueOrThrow({ where: { id: sarahId } })).title).toBe('Sarah Jones Net Worth 2026');

    // Undo: the text and the title from before.
    await service.requestUndo(id);
    expect(await posts.undoPostUpdate(id)).toMatchObject({ status: 'UNDONE' });
    expect(wp.posts.get(sarahPostId)!.content).toBe(GUTENBERG);
    expect(wp.posts.get(sarahPostId)!.title).toBe('Sarah Jones Net Worth 2024');
  });

  it("an answer that drops an image or changes too much is stopped by the app's checks; nothing is written", async () => {
    const id = await begin(sarahId);
    await answer((article) => format({ title: 'Sarah Jones Net Worth 2026', changes: ['Shortened'], article: updated(article).replace('{K2}', '') }));
    await service.processPostUpdate(id);
    const u = await service.getPostUpdate(id);
    expect(u.status).toBe('FAILED');
    expect(u.checks.find((c) => c.id === 'kept-parts')).toMatchObject({ passed: false, blocking: true });
    expect(u.message).toMatch(/core\/image left out/);
    await expect(service.approvePostUpdate(id, 'UPDATE LIVE POST')).rejects.toThrow(/ready/);
    expect(wp.posts.get(sarahPostId)!.content).toBe(GUTENBERG);

    const id2 = await begin(sarahId);
    // Only the first paragraph and the image: most of the article and its headings are gone.
    await answer((article) => format({ title: 'Sarah Jones Net Worth 2026', changes: ['Rewritten'], article: `${article.split('\n\n')[0]}\n\n{K2}` }));
    await service.processPostUpdate(id2);
    const u2 = await service.getPostUpdate(id2);
    expect(u2.status).toBe('FAILED');
    expect(u2.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(expect.arrayContaining(['length', 'headings']));
  });

  it('nothing outdated: the post stays as it is; an answer in another format is reported', async () => {
    const id = await begin(sarahId);
    await answer((article) => format({ title: 'Sarah Jones Net Worth 2024', changes: ['No changes needed'], article }));
    await service.processPostUpdate(id);
    expect((await service.getPostUpdate(id)).status).toBe('NO_CHANGE');

    const id2 = await begin(sarahId);
    // The whole article, but without the answer format.
    await answer((article) => updated(article));
    await service.processPostUpdate(id2);
    const u2 = await service.getPostUpdate(id2);
    expect(u2.status).toBe('FAILED');
    expect(u2.message).toMatch(/===ARTICLE===/);
  });

  it('an edit made in WordPress after the update started is never overwritten', async () => {
    const id = await begin(sarahId);
    await answer((article) => format({ title: 'Sarah Jones Net Worth 2026', changes: ['Age'], sources: ['https://news.example/a — age'], article: updated(article) }));
    await service.processPostUpdate(id);
    expect((await service.getPostUpdate(id)).status).toBe('READY');
    // The owner edits the post in WordPress meanwhile.
    const post = wp.posts.get(sarahPostId)!;
    post.content = `${GUTENBERG}\n\n<!-- wp:paragraph -->\n<p>Edited by the owner.</p>\n<!-- /wp:paragraph -->`;
    await service.approvePostUpdate(id, 'UPDATE LIVE POST');
    expect(await posts.applyPostUpdate(id)).toMatchObject({ status: 'CONFLICT' });
    expect(wp.posts.get(sarahPostId)!.content).toContain('Edited by the owner.');
    expect(wp.posts.get(sarahPostId)!.content).not.toContain('36 years old');
    post.content = GUTENBERG;
  });

  it('a classic-editor post: the gallery shortcode stays, the text is updated', async () => {
    const mike = await client.sitePost.findFirstOrThrow({ where: { websiteId: site.id, title: 'Mike Ross Biography' } });
    const raw = wp.posts.get(mike.wpPostId)!.content;
    const id = await begin(mike.id);
    await answer((article) => format({ title: 'Mike Ross Biography', changes: ['Added his 2026 film'], sources: ['https://news.example/mike — film'], article: article.replace('He was born in 1985.', 'He was born in 1985. In 2026 he directed the film Northbound, which premiered in Toronto.') }));
    const out = await service.processPostUpdate(id);
    const u = await service.getPostUpdate(id);
    // Too short to judge the length (under 150 words): the other checks decide.
    expect(u.status, out.message).toBe('READY');
    await service.approvePostUpdate(id, 'UPDATE LIVE POST');
    expect(await posts.applyPostUpdate(id)).toMatchObject({ status: 'APPLIED' });
    const content = wp.posts.get(mike.wpPostId)!.content;
    expect(content).toContain('[gallery ids="1,2"]');
    expect(content).toContain('Northbound');
    expect(content).not.toContain('<!-- wp:');
    expect(raw).not.toContain('Northbound');
  });
});
