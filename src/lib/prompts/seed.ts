import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { PROMPT_DEFAULTS, type PromptDefault } from '@/modules/prompt-defaults';

export function promptHash(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export type SeedOutcome = 'created' | 'kept-customized' | 'upgraded' | 'unchanged';

/**
 * Seed rule (never silently overwrite):
 *  - missing template → create from the shipped default
 *  - stored content equals the current default → unchanged
 *  - stored content equals a PREVIOUSLY shipped default (by hash) and the owner
 *    never customized it → upgrade to the new default (old text kept as a version)
 *  - anything else → keep the owner's text untouched
 */
export async function seedPrompt(client: PrismaClient, def: PromptDefault): Promise<SeedOutcome> {
  const hash = promptHash(def.content);
  const existing = await client.promptTemplate.findUnique({ where: { moduleKey_stageKey: { moduleKey: def.moduleKey, stageKey: def.stageKey } } });
  const variables = JSON.stringify(def.variables);
  if (!existing) {
    await client.promptTemplate.create({
      data: {
        moduleKey: def.moduleKey,
        stageKey: def.stageKey,
        name: def.name,
        description: def.description,
        content: def.content,
        defaultHash: hash,
        defaultVersion: def.version,
        variables,
        versions: { create: { version: 1, content: def.content, note: `Shipped default v${def.version}` } },
      },
    });
    return 'created';
  }
  const storedHash = promptHash(existing.content);
  if (storedHash === hash) {
    if (existing.defaultHash !== hash || existing.variables !== variables) {
      await client.promptTemplate.update({ where: { id: existing.id }, data: { defaultHash: hash, defaultVersion: def.version, variables } });
    }
    return 'unchanged';
  }
  const isPreviousDefault = !existing.customized && (def.previousHashes.includes(storedHash) || storedHash === existing.defaultHash);
  if (isPreviousDefault && existing.defaultVersion < def.version) {
    const nextVersion = existing.version + 1;
    await client.promptTemplate.update({
      where: { id: existing.id },
      data: {
        content: def.content,
        defaultHash: hash,
        defaultVersion: def.version,
        version: nextVersion,
        variables,
        description: def.description,
        versions: { create: { version: nextVersion, content: def.content, note: `Upgraded to shipped default v${def.version}` } },
      },
    });
    return 'upgraded';
  }
  // Owner-customized (or unknown) content: keep it. Only refresh variable docs.
  if (existing.variables !== variables) {
    await client.promptTemplate.update({ where: { id: existing.id }, data: { variables } });
  }
  return 'kept-customized';
}

export async function seedPrompts(client: PrismaClient): Promise<string[]> {
  const counts: Record<SeedOutcome, number> = { created: 0, 'kept-customized': 0, upgraded: 0, unchanged: 0 };
  for (const def of PROMPT_DEFAULTS) counts[await seedPrompt(client, def)]++;
  return [
    `Prompts: ${counts.created} created, ${counts.unchanged} unchanged, ${counts.upgraded} upgraded from old defaults, ${counts['kept-customized']} owner-customized kept ✓`,
  ];
}
