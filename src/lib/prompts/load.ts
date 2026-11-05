import type { Website } from '@prisma/client';
import { db } from '../db';
import { parseJson } from '../json';
import { FatalError } from '../pipeline-errors';
import { findPromptDefault, type PromptVariableDoc } from '@/modules/prompt-defaults';
import { customWriter } from '../writers/catalog';

export interface LoadedPrompt {
  moduleKey: string;
  stageKey: string;
  content: string;
  version: string;
  variables: PromptVariableDoc[];
  kind: 'text' | 'image' | 'vision';
  customized: boolean;
}

/** Owner's prompt: per-site override → saved template → shipped default. */
export async function loadPromptTemplate(moduleKey: string, stageKey: string, website?: Pick<Website, 'id' | 'promptOverrides'> | null): Promise<LoadedPrompt> {
  const def = findPromptDefault(moduleKey, stageKey);
  const row = await db.promptTemplate.findUnique({ where: { moduleKey_stageKey: { moduleKey, stageKey } } });
  const variables = row ? parseJson<PromptVariableDoc[]>(row.variables, def?.variables ?? []) : (def?.variables ?? []);
  const kind = def?.kind ?? 'text';
  const overrides = website ? parseJson<Record<string, string>>(website.promptOverrides, {}) : {};
  const override = overrides[`${moduleKey}:${stageKey}`];
  if (override && override.trim()) return { moduleKey, stageKey, content: override, version: `site-override:${website!.id}`, variables, kind, customized: true };
  if (row) return { moduleKey, stageKey, content: row.content, version: `v${row.version}`, variables, kind, customized: row.customized };
  if (def) return { moduleKey, stageKey, content: def.content, version: `default-v${def.version}`, variables, kind, customized: false };
  throw new FatalError(`No prompt template exists for ${moduleKey}/${stageKey}.`, moduleKey.startsWith('custom-') ? 'Write the prompt on the writer’s page (Writers), then Retry.' : 'Restore it in Prompt Manager, then Retry.');
}

/**
 * Celebrity 2 uses the Celebrity writer's prompts it has none of its own for (owner: the title step as it is, and the
 * app's own image prompts).
 */
const BORROWS: Record<string, string> = { 'celebrity2-writer': 'celebrity-writer' };

/** Which module owns a prompt stage key (module-specific first, then the module it borrows from, then shared). */
export function promptModuleFor(moduleKey: string, stageKey: string): string {
  // The owner's writers: their own article prompt (and title prompt, when they have one); the rest is borrowed —
  // the photo prompts from Celebrity (person writers) or Tigram (general writers), the category prompt from Tigram.
  const custom = customWriter(moduleKey);
  if (custom) {
    if (stageKey === 'ARTICLE' || (stageKey === 'TITLES' && custom.config.titles === 'own')) return moduleKey;
    for (const lender of [stageKey === 'TITLES' || custom.base === 'person' ? 'celebrity-writer' : 'tigram-writer', 'tigram-writer', 'celebrity-writer', 'shared']) {
      if (findPromptDefault(lender, stageKey)) return lender;
    }
    return moduleKey;
  }
  if (findPromptDefault(moduleKey, stageKey)) return moduleKey;
  const lender = BORROWS[moduleKey];
  if (lender && findPromptDefault(lender, stageKey)) return lender;
  if (findPromptDefault('shared', stageKey)) return 'shared';
  return moduleKey;
}
