import type { Website } from '@prisma/client';
import { db } from '../db';
import { parseJson } from '../json';
import { FatalError } from '../pipeline-errors';
import { findPromptDefault, type PromptVariableDoc } from '@/modules/prompt-defaults';

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
  throw new FatalError(`No prompt template exists for ${moduleKey}/${stageKey}. Restore it in Prompt Manager.`);
}

/** Which module owns a prompt stage key (module-specific first, then shared). */
export function promptModuleFor(moduleKey: string, stageKey: string): string {
  if (findPromptDefault(moduleKey, stageKey)) return moduleKey;
  if (findPromptDefault('shared', stageKey)) return 'shared';
  return moduleKey;
}
