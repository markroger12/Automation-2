import { beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb } from '../helpers/test-db';
import type { PrismaClient } from '@prisma/client';

let client: PrismaClient;
let seedPrompt: typeof import('@/lib/prompts/seed').seedPrompt;
let promptHash: typeof import('@/lib/prompts/seed').promptHash;
let seedPrompts: typeof import('@/lib/prompts/seed').seedPrompts;

beforeAll(async () => {
  ({ client } = await setupTestDb());
  ({ seedPrompt, promptHash, seedPrompts } = await import('@/lib/prompts/seed'));
});

describe('prompt seeding never overwrites owner edits', () => {
  it('creates defaults once and is idempotent', async () => {
    const first = await seedPrompts(client);
    expect(first[0]).toMatch(/15 created/);
    const second = await seedPrompts(client);
    expect(second[0]).toMatch(/0 created, 15 unchanged/);
  });

  it('keeps a customized prompt across a shipped upgrade', async () => {
    const t = await client.promptTemplate.findUniqueOrThrow({ where: { moduleKey_stageKey: { moduleKey: 'celebrity-writer', stageKey: 'TITLES' } } });
    await client.promptTemplate.update({ where: { id: t.id }, data: { content: 'MY OWN TITLES PROMPT {{keyword}}', customized: true } });
    const outcome = await seedPrompt(client, {
      moduleKey: 'celebrity-writer',
      stageKey: 'TITLES',
      name: 'x',
      description: 'x',
      version: 2,
      kind: 'text',
      content: 'NEW SHIPPED DEFAULT {{keyword}}',
      variables: [],
      previousHashes: [t.defaultHash],
    });
    expect(outcome).toBe('kept-customized');
    const after = await client.promptTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.content).toBe('MY OWN TITLES PROMPT {{keyword}}');
  });

  it('upgrades an untouched previous default and records a version', async () => {
    const t = await client.promptTemplate.findUniqueOrThrow({ where: { moduleKey_stageKey: { moduleKey: 'celebrity-writer', stageKey: 'FAQS' } } });
    const outcome = await seedPrompt(client, {
      moduleKey: 'celebrity-writer',
      stageKey: 'FAQS',
      name: 'x',
      description: 'x',
      version: 2,
      kind: 'text',
      content: 'FAQ DEFAULT V2 {{keyword}}',
      variables: [],
      previousHashes: [promptHash(t.content)],
    });
    expect(outcome).toBe('upgraded');
    const versions = await client.promptTemplateVersion.findMany({ where: { templateId: t.id }, orderBy: { version: 'asc' } });
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0].content).toBe(t.content);
  });
});
