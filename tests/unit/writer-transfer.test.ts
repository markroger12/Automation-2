import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import type { ImportPreviewItem, ImportResult, WriterFile } from '@/lib/writers/file-format';

/**
 * Owner request (2026-11-06): “writer import export ka option add kr” — a writer (or all of them) as a file, and the
 * file imported on another PC or as a backup: every writer is shown first, then added as a draft or updates the same
 * writer here; nothing broken or unknown gets in.
 */
let client: PrismaClient;
let store: typeof import('@/lib/writers/store');
let transfer: typeof import('@/lib/writers/transfer');

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  store = await import('@/lib/writers/store');
  transfer = await import('@/lib/writers/transfer');
});

const H = { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: 'bas_csrf=tok12345', 'x-csrf-token': 'tok12345', 'content-type': 'application/json' };
const preview = async (file: unknown) => (await transfer.importWriters({ file, preview: true })) as { preview: ImportPreviewItem[] };
const run = async (body: Record<string, unknown>) => (await transfer.importWriters(body)) as ImportResult;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

describe('Export', () => {
  it('one writer as a file: its settings and current prompts, nothing else; the route downloads it', async () => {
    const w = await store.createCustomWriter({ name: 'Family Stories', startFrom: 'celebrity2-writer', description: 'Families of famous people' });
    await store.updateCustomWriter(w.key, { config: { ...w.config, titles: 'own' }, prompts: { TITLES: 'Give 8 titles for {{keyword}}.\nRecommended Title: …' } });
    await store.testCustomWriter(w.key, { answer: 'SEO Title: x\n\n# x\n\nshort' });
    const { file, filename } = await transfer.exportWriters([w.key]);
    expect(filename).toBe('writer-family-stories.json');
    expect(file).toMatchObject({ format: 'blog-automation-studio/writers', version: 1, writers: [{ key: w.key, name: 'Family Stories', shortName: 'Family Stories', description: 'Families of famous people', base: 'person', status: 'DRAFT' }] });
    expect(file.writers[0].config).toMatchObject({ titles: 'own', rules: { faqCount: 5, tableHeading: 'Family Profile' }, category: { mode: 'celebrity' } });
    const { CELEBRITY2_ARTICLE_PROMPT } = await import('@/modules/celebrity2-writer/prompt');
    expect(file.writers[0].prompts).toEqual({ ARTICLE: CELEBRITY2_ARTICLE_PROMPT, TITLES: 'Give 8 titles for {{keyword}}.\nRecommended Title: …' });
    // No test results, ids, dates of the writer, articles or anything of a website.
    expect(Object.keys(file.writers[0]).sort()).toEqual(['base', 'config', 'description', 'key', 'name', 'prompts', 'shortName', 'status']);
    expect(Object.keys(file).sort()).toEqual(['about', 'exportedAt', 'format', 'version', 'writers']);

    const route = await import('../../app/api/writers/export/route');
    const res = await route.GET(new Request(`http://localhost:3000/api/writers/export?key=${w.key}`, { headers: { host: 'localhost:3000' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="writer-family-stories.json"');
    expect(((await res.json()) as WriterFile).writers[0].name).toBe('Family Stories');
    // Not from another host (the dashboard is local only); built-in or unknown writers are refused.
    expect((await route.GET(new Request(`http://evil.example/api/writers/export?key=${w.key}`, { headers: { host: 'evil.example' } }))).status).toBe(403);
    expect((await route.GET(new Request('http://localhost:3000/api/writers/export?key=celebrity2-writer', { headers: { host: 'localhost:3000' } }))).status).toBe(400);
    expect((await route.GET(new Request('http://localhost:3000/api/writers/export?key=custom-nope', { headers: { host: 'localhost:3000' } }))).status).toBe(404);
  });

  it('all writers in one file', async () => {
    await store.createCustomWriter({ name: 'Tech Guides', startFrom: 'tigram-writer' });
    const { file, filename } = await transfer.exportWriters();
    expect(filename).toMatch(/^writers-\d{4}-\d{2}-\d{2}\.json$/);
    expect(file.writers.map((w) => w.name)).toEqual(['Family Stories', 'Tech Guides']);
    expect(file.writers[1]).toMatchObject({ base: 'general', prompts: { TITLES: null } });
  });
});

describe('Import', () => {
  it('the same file again: “same as your writer”, nothing to import', async () => {
    const { file } = await transfer.exportWriters();
    const { preview: items } = await preview(file);
    expect(items.map((i) => [i.name, i.match?.by, i.match?.promptChanged, i.match?.settingsChanged, i.defaultAction])).toEqual([
      ['Family Stories', 'key', false, false, 'skip'],
      ['Tech Guides', 'key', false, false, 'skip'],
    ]);
    await expect(run({ file })).rejects.toMatchObject({ code: 'NOTHING_TO_IMPORT' });
  });

  it('a backup brings back a changed writer: its prompt as a new version, its settings as in the file; name and status stay', async () => {
    const key = 'custom-family-stories';
    const { file } = await transfer.exportWriters([key]);
    const before = await store.getCustomWriter(key);
    await store.updateCustomWriter(key, { config: { ...before.writer.config, rules: { ...before.writer.config.rules, faqCount: 9 } }, prompts: { ARTICLE: 'Write about {{keyword}} with {{secondary_keywords}}.' } });
    await store.setWriterStatus(key, 'ACTIVE');
    const { preview: items } = await preview(file);
    expect(items[0]).toMatchObject({ match: { key, by: 'key', status: 'ACTIVE', promptChanged: true, settingsChanged: true, updateBlocked: null }, defaultAction: 'update' });
    const res = await run({ file, fileName: 'writer-family-stories.json' });
    expect(res).toEqual({ imported: [{ index: 0, key, name: 'Family Stories', action: 'update', status: 'ACTIVE', note: null }], skipped: 0 });
    const after = await store.getCustomWriter(key);
    expect(after.writer.config.rules.faqCount).toBe(5);
    expect(after.prompts.ARTICLE).toBe(before.prompts.ARTICLE);
    expect(after.promptVersions.ARTICLE).toBe(before.promptVersions.ARTICLE + 2);
    const versions = await client.promptTemplateVersion.findMany({ where: { template: { moduleKey: key, stageKey: 'ARTICLE' } }, orderBy: { version: 'desc' } });
    expect(versions[0].note).toBe('Imported from the file writer-family-stories.json');
    expect(versions[1].content).toBe('Write about {{keyword}} with {{secondary_keywords}}.'); // the replaced prompt stays under Versions
    expect(await client.auditLog.count({ where: { action: 'writer.import', entityId: key } })).toBe(1);
  });

  it('on another PC: added as a new draft (or active when it was active and asked), its prompts version 1', async () => {
    const { file } = await transfer.exportWriters(['custom-family-stories', 'custom-tech-guides']);
    const other = clone(file);
    other.writers[0] = { ...other.writers[0], key: 'custom-celebrity-kids', name: 'Celebrity Kids', shortName: 'Kids' };
    other.writers[1] = { ...other.writers[1], key: 'custom-how-to', name: 'How To', shortName: 'How To' };
    const { preview: items } = await preview(other);
    expect(items.map((i) => [i.name, i.match, i.suggestedName, i.defaultAction, i.wasActive])).toEqual([
      ['Celebrity Kids', null, 'Celebrity Kids', 'new', true],
      ['How To', null, 'How To', 'new', false],
    ]);
    expect(items[0].summary).toEqual(['1300–1600 words', '5 FAQs', '“Family Profile” table', 'its own title prompt', 'category: Celebrity', 'photos']);
    const res = await run({ file: other, fileName: 'writers.json', activate: true });
    expect(res.imported.map((i) => [i.key, i.name, i.action, i.status, i.note])).toEqual([
      ['custom-celebrity-kids', 'Celebrity Kids', 'new', 'ACTIVE', null],
      ['custom-how-to', 'How To', 'new', 'DRAFT', null],
    ]);
    const kids = await store.getCustomWriter('custom-celebrity-kids');
    expect(kids.writer).toMatchObject({ shortName: 'Kids', startedFrom: 'import', base: 'person', config: other.writers[0].config });
    expect(kids.prompts).toEqual(other.writers[0].prompts);
    expect(kids.promptVersions).toEqual({ ARTICLE: 1, TITLES: 1 });
    expect(kids.lastTest).toBeNull();
    // Offered where writers are chosen (active), the draft not.
    const { writerChoices } = await import('@/lib/writers/options');
    const keys = writerChoices().map((c) => c.key);
    expect(keys).toContain('custom-celebrity-kids');
    expect(keys).not.toContain('custom-how-to');
  });

  it('a name already used here by another writer: added as “Name 2” (or the name typed); a typed name that is taken is refused', async () => {
    const { file } = await transfer.exportWriters(['custom-tech-guides']);
    const foreign = clone(file);
    foreign.writers[0].key = 'custom-someone-elses-tech-guides';
    // The same name and the same content: the same writer, nothing to do.
    expect((await preview(foreign)).preview[0]).toMatchObject({ match: { by: 'name', promptChanged: false, settingsChanged: false }, defaultAction: 'skip' });
    foreign.writers[0].prompts.ARTICLE += '\nWrite in a friendly tone.';
    const { preview: items } = await preview(foreign);
    expect(items[0]).toMatchObject({ match: { key: 'custom-tech-guides', by: 'name' }, suggestedName: 'Tech Guides 2', defaultAction: 'new' });
    await expect(run({ file: foreign, choices: [{ index: 0, action: 'new', name: 'Family Stories' }] })).rejects.toMatchObject({ status: 400, fieldErrors: { 'choices.0': ['A writer named “Family Stories” already exists. Choose another name.'] } });
    await expect(run({ file: foreign, choices: [{ index: 0, action: 'new', name: 'Celebrity 2' }] })).rejects.toMatchObject({ fieldErrors: { 'choices.0': ['“Celebrity 2” is the name of a built-in writer. Choose another name.'] } });
    const res = await run({ file: foreign });
    expect(res.imported[0]).toMatchObject({ key: 'custom-tech-guides-2', name: 'Tech Guides 2', status: 'DRAFT' });
    // The file's short name was taken too: the new name is used.
    expect((await store.getCustomWriter('custom-tech-guides-2')).writer.shortName).toBe('Tech Guides 2');
  });

  it('refuses what is not a writer file, a newer one, and broken writers (shown, only “Skip”); nothing is written', async () => {
    await expect(preview({ steps: [] })).rejects.toMatchObject({ code: 'NOT_A_WRITER_FILE' });
    await expect(preview([1, 2])).rejects.toMatchObject({ code: 'NOT_A_WRITER_FILE' });
    const { file } = await transfer.exportWriters(['custom-tech-guides']);
    await expect(preview({ ...file, version: 2 })).rejects.toMatchObject({ code: 'NEWER_WRITER_FILE', message: expect.stringMatching(/newer version of the app/) });
    await expect(preview({ ...file, writers: [] })).rejects.toMatchObject({ code: 'EMPTY_WRITER_FILE' });
    await expect(preview({ ...file, writers: Array.from({ length: 51 }, () => file.writers[0]) })).rejects.toMatchObject({ code: 'BAD_WRITER_FILE' });

    const good = { ...file.writers[0], key: 'custom-fresh', name: 'Fresh Writer', shortName: 'Fresh Writer' };
    const broken = clone({
      ...file,
      writers: [
        good,
        { ...good, key: 'custom-a', name: 'Bad Rules', config: { ...good.config, rules: { ...good.config.rules, wordMin: 2000, wordMax: 1000 } } },
        { ...good, key: 'custom-b', name: 'Bad Prompt', prompts: { ARTICLE: 'Write about {{keyword}} for {{api_key}}.', TITLES: null } },
        { ...good, key: 'custom-c', name: 'Bad Template', prompts: { ARTICLE: 'Write {{#if keyword}} about it', TITLES: null } },
        { name: 'X' },
        'not a writer',
      ],
    });
    const { preview: items } = await preview(broken);
    expect(items.map((i) => [i.name, i.error === null, i.defaultAction])).toEqual([
      ['Fresh Writer', true, 'new'],
      ['Bad Rules', false, 'skip'],
      ['Bad Prompt', false, 'skip'],
      ['Bad Template', false, 'skip'],
      ['X', false, 'skip'],
      ['Unnamed writer', false, 'skip'],
    ]);
    expect(items[1].error).toMatch(/settings are not valid.*highest word count must be above the lowest/);
    expect(items[2].error).toBe('Article prompt: {{api_key}} is not a variable the app fills in (use the buttons above the prompt).');
    expect(items[3].error).toMatch(/^Article prompt: Template:/);
    const count = await client.customWriter.count();
    // Asking to add a broken one: refused, and the good one is not added either.
    await expect(run({ file: broken, choices: [{ index: 0, action: 'new' }, { index: 2, action: 'new' }] })).rejects.toMatchObject({ code: 'VALIDATION', fieldErrors: { 'choices.2': [items[2].error] } });
    expect(await client.customWriter.count()).toBe(count);
    // Update needs a writer here to update.
    await expect(run({ file: broken, choices: [{ index: 0, action: 'update' }] })).rejects.toMatchObject({ fieldErrors: { 'choices.0': ['There is no writer “Fresh Writer” here to update: add it as a new writer.'] } });
    // The default (only the good one) works.
    expect((await run({ file: broken })).imported.map((i) => i.name)).toEqual(['Fresh Writer']);
  });

  it('an update that would change person/general while its articles run is not offered', async () => {
    const key = 'custom-how-to';
    const websites = await import('@/lib/websites');
    const site = await websites.createWebsite({ name: 'Writer Lab', publicUrl: 'https://lab.example', language: 'en', targetCountry: 'United States', timezone: 'UTC' });
    await client.articleTask.create({ data: { moduleKey: key, keyword: 'how to tie a tie', normalizedKeyword: 'how to tie a tie', targetCountry: 'United States', language: 'en', websiteId: site.id, status: 'RUNNING', idempotencyKey: 'transfer-running' } });
    const { file } = await transfer.exportWriters([key]);
    const changed = clone(file);
    changed.writers[0].base = 'person';
    const { preview: items } = await preview(changed);
    expect(items[0].match?.updateBlocked).toMatch(/1 article\(s\) of “How To” are still running/);
    expect(items[0].defaultAction).toBe('new');
    await expect(run({ file: changed, choices: [{ index: 0, action: 'update' }] })).rejects.toMatchObject({ fieldErrors: { 'choices.0': [items[0].match!.updateBlocked] } });
  });

  it('the route: same-origin with the security token only; a body over the limit is refused', async () => {
    const route = await import('../../app/api/writers/import/route');
    const { file } = await transfer.exportWriters(['custom-tech-guides']);
    const ok = await route.POST(new Request('http://localhost:3000/api/writers/import', { method: 'POST', headers: H, body: JSON.stringify({ file, preview: true }) }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { preview: ImportPreviewItem[] }).preview[0].name).toBe('Tech Guides');
    const noToken = await route.POST(new Request('http://localhost:3000/api/writers/import', { method: 'POST', headers: { ...H, 'x-csrf-token': 'wrong' }, body: JSON.stringify({ file, preview: true }) }));
    expect(noToken.status).toBe(403);
    const cross = await route.POST(new Request('http://localhost:3000/api/writers/import', { method: 'POST', headers: { ...H, origin: 'https://evil.example' }, body: JSON.stringify({ file, preview: true }) }));
    expect(cross.status).toBe(403);
    const big = await route.POST(new Request('http://localhost:3000/api/writers/import', { method: 'POST', headers: H, body: JSON.stringify({ file: { ...file, padding: 'x'.repeat(2_100_000) }, preview: true }) }));
    expect(big.status).toBe(413);
  });
});
