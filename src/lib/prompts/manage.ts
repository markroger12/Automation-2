import { z } from 'zod';
import { db } from '../db';
import { AppError } from '../errors';
import { audit } from '../audit';
import { parseJson } from '../json';
import { findPromptDefault, type PromptVariableDoc } from '@/modules/prompt-defaults';
import { TemplateSyntaxError, parseTemplate, referencedVariables } from './template';
import { promptHash } from './seed';

/** Prompts of a retired writer (Celebrity Writer 2.0) stay readable as an archive and are never edited or used. */
export function isArchivedPromptModule(moduleKey: string): boolean {
  return !['celebrity-writer', 'tigram-writer', 'shared'].includes(moduleKey);
}

function assertEditable(row: { moduleKey: string }) {
  if (isArchivedPromptModule(row.moduleKey)) throw new AppError(409, 'RETIRED_WRITER', 'This prompt belongs to the retired Celebrity Writer 2.0. It is kept read-only as an archive.');
}

export async function listPrompts() {
  const rows = await db.promptTemplate.findMany({ orderBy: [{ moduleKey: 'asc' }, { stageKey: 'asc' }] });
  return rows.map((r) => {
    const def = findPromptDefault(r.moduleKey, r.stageKey);
    return {
      id: r.id,
      moduleKey: r.moduleKey,
      stageKey: r.stageKey,
      name: r.name,
      description: r.description,
      version: r.version,
      customized: def ? promptHash(r.content) !== promptHash(def.content) : r.customized,
      kind: def?.kind ?? 'text',
      archived: isArchivedPromptModule(r.moduleKey),
      updatedAt: r.updatedAt,
    };
  });
}

export async function getPrompt(id: string) {
  const row = await db.promptTemplate.findUnique({ where: { id }, include: { versions: { orderBy: { version: 'desc' }, take: 50 } } });
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Prompt not found.');
  const def = findPromptDefault(row.moduleKey, row.stageKey);
  const submissions = await db.chatGPTResponse.findMany({
    where: { stageKey: row.stageKey, task: { moduleKey: row.moduleKey === 'shared' ? undefined : row.moduleKey } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, taskId: true, createdAt: true, status: true, renderedPrompt: true, task: { select: { keyword: true } } },
  });
  return {
    ...row,
    variablesList: parseJson<PromptVariableDoc[]>(row.variables, def?.variables ?? []),
    defaultContent: def?.content ?? null,
    defaultVersion: def?.version ?? null,
    kind: def?.kind ?? 'text',
    isDefault: def ? promptHash(row.content) === promptHash(def.content) : false,
    archived: isArchivedPromptModule(row.moduleKey),
    submissions,
  };
}

export interface PromptValidation {
  errors: string[];
  warnings: string[];
}

export function validatePromptContent(content: string, variables: PromptVariableDoc[]): PromptValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!content.trim()) errors.push('The prompt is empty.');
  try {
    parseTemplate(content);
  } catch (e) {
    if (e instanceof TemplateSyntaxError) errors.push(`Template syntax: ${e.message}`);
    else throw e;
  }
  if (errors.length) return { errors, warnings };
  const refs = referencedVariables(content);
  const known = new Set(variables.map((v) => v.name));
  for (const r of refs) if (!known.has(r)) warnings.push(`{{${r}}} is not a documented variable — it will be treated as REQUIRED and block sending if empty.`);
  for (const v of variables) if (v.required && !refs.includes(v.name)) warnings.push(`Required variable {{${v.name}}} is not used in this prompt.`);
  return { errors, warnings };
}

export const savePromptSchema = z.object({ content: z.string().max(100_000), note: z.string().trim().max(300).optional() });

export async function savePrompt(id: string, raw: unknown) {
  const input = savePromptSchema.parse(raw);
  const row = await db.promptTemplate.findUnique({ where: { id } });
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Prompt not found.');
  assertEditable(row);
  const variables = parseJson<PromptVariableDoc[]>(row.variables, []);
  const validation = validatePromptContent(input.content, variables);
  if (validation.errors.length) throw new AppError(400, 'VALIDATION', validation.errors[0], { content: validation.errors });
  const content = input.content.replace(/\r\n/g, '\n');
  if (content === row.content) return { ok: true, version: row.version, warnings: validation.warnings, unchanged: true };
  const def = findPromptDefault(row.moduleKey, row.stageKey);
  const isDefault = def ? promptHash(content) === promptHash(def.content) : false;
  const version = row.version + 1;
  await db.promptTemplate.update({
    where: { id },
    data: { content, version, customized: !isDefault, versions: { create: { version, content, note: input.note || (isDefault ? 'Matches shipped default' : 'Owner edit') } } },
  });
  await audit('prompt.save', 'PromptTemplate', id, { moduleKey: row.moduleKey, stageKey: row.stageKey, version });
  return { ok: true, version, warnings: validation.warnings, unchanged: false };
}

/** Restore the shipped default or an earlier version — always as a NEW version (history is kept). */
export async function restorePrompt(id: string, raw: unknown) {
  const { version: fromVersion } = z.object({ version: z.number().int().min(1).optional() }).parse(raw ?? {});
  const row = await db.promptTemplate.findUnique({ where: { id } });
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Prompt not found.');
  assertEditable(row);
  let content: string;
  let note: string;
  if (fromVersion) {
    const v = await db.promptTemplateVersion.findUnique({ where: { templateId_version: { templateId: id, version: fromVersion } } });
    if (!v) throw new AppError(404, 'NOT_FOUND', `Version ${fromVersion} not found.`);
    content = v.content;
    note = `Restored from version ${fromVersion}`;
  } else {
    const def = findPromptDefault(row.moduleKey, row.stageKey);
    if (!def) throw new AppError(400, 'NO_DEFAULT', 'This prompt has no shipped default.');
    content = def.content;
    note = `Restored shipped default v${def.version}`;
  }
  const def = findPromptDefault(row.moduleKey, row.stageKey);
  const version = row.version + 1;
  await db.promptTemplate.update({
    where: { id },
    data: { content, version, customized: def ? promptHash(content) !== promptHash(def.content) : true, versions: { create: { version, content, note } } },
  });
  await audit('prompt.restore', 'PromptTemplate', id, { fromVersion: fromVersion ?? 'default', version });
  return { ok: true, version };
}
