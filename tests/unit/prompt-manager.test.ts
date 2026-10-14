import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';

let client: PrismaClient;
let manage: typeof import('@/lib/prompts/manage');
let preview: typeof import('@/lib/prompts/preview');

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  manage = await import('@/lib/prompts/manage');
  preview = await import('@/lib/prompts/preview');
});

describe('Prompt Manager', () => {
  it('rejects broken template syntax and warns about undocumented variables', async () => {
    const t = await client.promptTemplate.findUniqueOrThrow({ where: { moduleKey_stageKey: { moduleKey: 'celebrity-writer', stageKey: 'TITLES' } } });
    await expect(manage.savePrompt(t.id, { content: '{{#if keyword}}unclosed' })).rejects.toThrow(/Unclosed/);
    const res = await manage.savePrompt(t.id, { content: `${t.content}\nExtra: {{mystery}}`, note: 'test' });
    expect(res.version).toBe(2);
    expect(res.warnings.join(' ')).toMatch(/mystery/);
    const saved = await manage.getPrompt(t.id);
    expect(saved.isDefault).toBe(false);
    expect(saved.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it('restores the default or an older version as a NEW version (history kept)', async () => {
    const t = await client.promptTemplate.findUniqueOrThrow({ where: { moduleKey_stageKey: { moduleKey: 'celebrity-writer', stageKey: 'TITLES' } } });
    const r = await manage.restorePrompt(t.id, {});
    expect(r.version).toBe(3);
    const after = await manage.getPrompt(t.id);
    expect(after.isDefault).toBe(true);
    const r2 = await manage.restorePrompt(t.id, { version: 2 });
    expect(r2.version).toBe(4);
    expect((await manage.getPrompt(t.id)).content).toContain('{{mystery}}');
    await manage.restorePrompt(t.id, {});
  });

  it('previews prompts with labelled downstream values and notes unused example titles', async () => {
    const res = await preview.previewPrompts({ moduleKey: 'celebrity-writer', keyword: 'Sydney Sweeney', exampleTitle: 'Her Story', secondaryKeywords: 'Euphoria, The White Lotus' });
    const titles = res.previews.find((p) => p.stageKey === 'TITLES')!;
    expect(titles.text).toContain('Reference title for direction only: "Her Story"');
    const research = res.previews.find((p) => p.stageKey === 'RESEARCH')!;
    expect(research.text).toContain('⟦selected_title: available after TITLES (and title approval)⟧');
    expect(research.unavailable).toContain('selected_title');
    const long = res.previews.find((p) => p.stageKey === 'LONG_ARTICLE')!;
    expect(long.text).toContain('Secondary terms to use only where natural: Euphoria, The White Lotus');
    const tigram = await preview.previewPrompts({ moduleKey: 'tigram-writer', keyword: 'best vpn', exampleTitle: 'Top VPNs' });
    expect(tigram.previews.find((p) => p.stageKey === 'ARTICLE')!.notes.join(' ')).toMatch(/example title is not used/);
  });
});
