import { z } from 'zod';
import { db } from '../db';
import { AppError } from '../errors';
import { audit } from '../audit';
import { checkPrompt } from './prompt-check';
import { customWriterConfigSchema, isCustomKey, keyFromName, PROMPT_STAGE_LABELS, WRITER_BASES, WRITER_STATUSES, type CustomWriterConfig, type PhotoPromptStage, type WriterBase } from './types';
import { ensureCustomWriters, nameProblem, nameSchema, ownPhotoStages, setWriterStatus, toInfo, updateCustomWriter, writePrompt } from './store';
import {
  MAX_WRITERS_PER_FILE,
  WRITER_FILE_FORMAT,
  WRITER_FILE_VERSION,
  type ImportAction,
  type ImportPreviewItem,
  type ImportResult,
  type WriterFile,
  type WriterFileEntry,
} from './file-format';

/**
 * Writers → Export / Import (owner request 2026-11-06: “writer import export ka option add kr”): a writer's settings and
 * current prompts in one JSON file, to keep as a backup, move to another PC, or share. An import shows each writer of
 * the file first; a writer is added as a new draft (unless the owner asks to make the active ones active), or updates
 * the same writer here (its prompt becomes a new version, the old one stays under Versions). Nothing from the file is
 * run: the settings and prompts are checked exactly as when they are saved on the writer page.
 */

const ABOUT = 'Writers exported from Blog Automation Studio (Writers → Export). Import them with Writers → Import. Each writer’s name, settings and current prompts — no passwords, keys, websites or articles.';
const FINISHED = ['COMPLETED', 'CANCELLED', 'FAILED'];
const norm = (s: string | null | undefined) => (s ?? '').replace(/\r\n/g, '\n');
const PHOTO_STAGES: PhotoPromptStage[] = ['IMAGE_PLAN', 'IMAGE_GENERATION', 'IMAGE_SEARCH'];
const ALL_STAGES = ['ARTICLE', 'TITLES', ...PHOTO_STAGES];

/** The owner's writers (all, or the given keys) as a writer file. */
export async function exportWriters(keys: string[] = []): Promise<{ file: WriterFile; filename: string }> {
  const wanted = [...new Set(keys)];
  if (wanted.some((k) => !isCustomKey(k))) throw new AppError(400, 'VALIDATION', 'Only your own writers can be exported (built-in writers are in every installation).');
  const rows = await db.customWriter.findMany({ where: wanted.length ? { key: { in: wanted } } : {}, orderBy: { createdAt: 'asc' } });
  if (wanted.length && rows.length !== wanted.length) throw new AppError(404, 'NOT_FOUND', 'Writer not found.');
  if (!rows.length) throw new AppError(404, 'NOT_FOUND', 'There is no writer of your own to export yet.');
  const prompts = await db.promptTemplate.findMany({ where: { moduleKey: { in: rows.map((r) => r.key) }, stageKey: { in: ALL_STAGES } }, select: { moduleKey: true, stageKey: true, content: true } });
  const prompt = (key: string, stage: string) => prompts.find((p) => p.moduleKey === key && p.stageKey === stage)?.content ?? null;
  const writers: WriterFileEntry[] = rows.map((row) => {
    const w = toInfo(row);
    const photos = Object.fromEntries(PHOTO_STAGES.map((stage) => [stage, prompt(w.key, stage)]).filter(([, text]) => text !== null));
    return { key: w.key, name: w.name, shortName: w.shortName, description: w.description, base: w.base, status: w.status, config: w.config, prompts: { ARTICLE: prompt(w.key, 'ARTICLE') ?? '', TITLES: prompt(w.key, 'TITLES'), ...photos } };
  });
  const exportedAt = new Date().toISOString();
  const filename = writers.length === 1 && wanted.length === 1 ? `writer-${writers[0].key.replace(/^custom-/, '')}.json` : `writers-${exportedAt.slice(0, 10)}.json`;
  await audit('writer.export', 'CustomWriter', wanted.length === 1 ? wanted[0] : null, { writers: writers.map((w) => w.key) });
  return { file: { format: WRITER_FILE_FORMAT, version: WRITER_FILE_VERSION, exportedAt, about: ABOUT, writers }, filename };
}

const fileShape = z.object({
  format: z.string(),
  version: z.number().int().min(1),
  writers: z.array(z.unknown()).max(MAX_WRITERS_PER_FILE, `A file can hold at most ${MAX_WRITERS_PER_FILE} writers.`),
});

const entrySchema = z.object({
  key: z.string().max(80).optional(),
  name: nameSchema,
  shortName: z.string().trim().max(24).optional(),
  description: z.string().trim().max(300).optional(),
  base: z.enum(WRITER_BASES),
  status: z.enum(WRITER_STATUSES).optional(),
  config: z.unknown(),
  prompts: z.object({
    ARTICLE: z.string().max(100_000),
    TITLES: z.string().max(100_000).nullable().optional(),
    IMAGE_PLAN: z.string().max(100_000).nullable().optional(),
    IMAGE_GENERATION: z.string().max(100_000).nullable().optional(),
    IMAGE_SEARCH: z.string().max(100_000).nullable().optional(),
  }),
});

interface ParsedEntry {
  key: string | null;
  name: string;
  shortName: string;
  description: string;
  base: WriterBase;
  wasActive: boolean;
  config: CustomWriterConfig;
  article: string;
  titles: string | null;
  photos: Partial<Record<PhotoPromptStage, string>>;
}

/** The file's writers (each still to be checked on its own), or why the file cannot be read at all. */
function readWriterFile(raw: unknown): unknown[] {
  const f = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!f || f.format !== WRITER_FILE_FORMAT) throw new AppError(400, 'NOT_A_WRITER_FILE', 'This is not a writer file. Make one with Export (on the Writers page or on a writer’s page), then import that file.');
  const parsed = fileShape.safeParse(f);
  if (!parsed.success) throw new AppError(400, 'BAD_WRITER_FILE', `The writer file is damaged (${parsed.error.issues[0]?.path.join('.') || 'file'}: ${parsed.error.issues[0]?.message}). Export it again.`);
  if (parsed.data.version > WRITER_FILE_VERSION) throw new AppError(400, 'NEWER_WRITER_FILE', 'This file was made by a newer version of the app. Update this app first (Settings → App updates), then import it again.');
  if (!parsed.data.writers.length) throw new AppError(400, 'EMPTY_WRITER_FILE', 'The file has no writers.');
  return parsed.data.writers;
}

function readEntry(raw: unknown): { entry: ParsedEntry | null; name: string; base: WriterBase | null; error: string | null; warnings: string[] } {
  const looseName = raw && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string' ? String((raw as { name: string }).name).trim().slice(0, 60) : '';
  const e = entrySchema.safeParse(raw);
  if (!e.success) {
    const issue = e.error.issues[0];
    return { entry: null, name: looseName || 'Unnamed writer', base: null, error: `Not readable: ${issue?.path.join('.') || 'writer'} — ${issue?.message}`, warnings: [] };
  }
  const d = e.data;
  const config = customWriterConfigSchema.safeParse(d.config);
  if (!config.success) {
    const issue = config.error.issues[0];
    return { entry: null, name: d.name, base: d.base, error: `Its settings are not valid (${issue?.path.join('.') || 'settings'}: ${issue?.message}).`, warnings: [] };
  }
  const article = norm(d.prompts.ARTICLE);
  const titles = d.prompts.TITLES && d.prompts.TITLES.trim() ? norm(d.prompts.TITLES) : null;
  const a = checkPrompt(article, 'ARTICLE');
  if (a.errors.length) return { entry: null, name: d.name, base: d.base, error: `Article prompt: ${a.errors[0]}`, warnings: [] };
  const warnings = a.warnings.map((w) => `Article prompt: ${w}`);
  if (titles) {
    const t = checkPrompt(titles, 'TITLES');
    if (t.errors.length) return { entry: null, name: d.name, base: d.base, error: `Title prompt: ${t.errors[0]}`, warnings: [] };
    if (config.data.titles === 'own') warnings.push(...t.warnings.map((w) => `Title prompt: ${w}`));
  } else if (config.data.titles === 'own') {
    warnings.push('It uses its own title prompt, but the file has none: write one on its page before making it active.');
  }
  const photos: Partial<Record<PhotoPromptStage, string>> = {};
  const usedPhotos = ownPhotoStages({ base: d.base, config: config.data });
  for (const stage of PHOTO_STAGES) {
    const text = d.prompts[stage]?.trim() ? norm(d.prompts[stage]) : null;
    if (!text) {
      if (usedPhotos.includes(stage)) warnings.push(`It uses its own photo prompts, but the file has no ${PROMPT_STAGE_LABELS[stage].toLowerCase()} prompt: write one on its page before making it active.`);
      continue;
    }
    const check = checkPrompt(text, stage);
    if (check.errors.length) return { entry: null, name: d.name, base: d.base, error: `${PROMPT_STAGE_LABELS[stage]} prompt: ${check.errors[0]}`, warnings: [] };
    if (usedPhotos.includes(stage)) warnings.push(...check.warnings.map((w) => `${PROMPT_STAGE_LABELS[stage]} prompt: ${w}`));
    photos[stage] = text;
  }
  return {
    entry: { key: d.key && isCustomKey(d.key) ? d.key : null, name: d.name, shortName: d.shortName?.trim() || d.name, description: d.description ?? '', base: d.base, wasActive: d.status === 'ACTIVE', config: config.data, article, titles, photos },
    name: d.name,
    base: d.base,
    error: null,
    warnings,
  };
}

function summary(c: CustomWriterConfig, base: WriterBase): string[] {
  const r = c.rules;
  return [
    `${r.wordMin}–${r.wordMax} words`,
    r.faqCount ? `${r.exactFaqs ? '' : 'about '}${r.faqCount} FAQs` : 'no FAQs',
    ...(base === 'person' && r.table !== 'none' ? [`“${r.tableHeading || 'Family Profile'}” table${r.table === 'optional' ? ' (optional)' : ''}`] : []),
    c.titles === 'app' ? 'the app’s title step' : c.titles === 'own' ? 'its own title prompt' : 'no title step',
    c.category.mode === 'celebrity' ? 'category: Celebrity' : c.category.mode === 'fixed' ? `category: ${c.category.name}` : 'category chosen by ChatGPT',
    c.images === 'on' ? 'photos' : 'no photos',
  ];
}

/** A free name for a new writer: the name itself, else “Name 2”, “Name 3” … */
async function freeName(name: string, others: { name: string; shortName: string }[]): Promise<string> {
  if (!(await nameProblem(name, name, undefined, others))) return name;
  for (let i = 2; i < 1000; i++) {
    const tail = ` ${i}`;
    const candidate = `${name.slice(0, 60 - tail.length).trim()}${tail}`;
    if (!(await nameProblem(candidate, candidate, undefined, others))) return candidate;
  }
  return name;
}

interface Plan {
  items: ImportPreviewItem[];
  entries: (ParsedEntry | null)[];
}

/** Read the file and compare each of its writers with the writers here (nothing is written). */
async function planImport(rawFile: unknown): Promise<Plan> {
  const raws = readWriterFile(rawFile);
  const rows = await db.customWriter.findMany();
  const prompts = await db.promptTemplate.findMany({ where: { moduleKey: { in: rows.map((r) => r.key) }, stageKey: { in: ALL_STAGES } }, select: { moduleKey: true, stageKey: true, content: true } });
  const running = await db.articleTask.groupBy({ by: ['moduleKey'], where: { moduleKey: { in: rows.map((r) => r.key) }, status: { notIn: FINISHED } }, _count: { _all: true } });
  const taken = rows.map((r) => ({ name: r.name, shortName: r.shortName }));
  const items: ImportPreviewItem[] = [];
  const entries: (ParsedEntry | null)[] = [];
  for (const [index, raw] of raws.entries()) {
    const read = readEntry(raw);
    const e = read.entry;
    entries.push(e);
    if (!e) {
      items.push({ index, name: read.name, base: read.base, description: '', summary: [], error: read.error, warnings: [], wasActive: false, match: null, suggestedName: read.name, defaultAction: 'skip' });
      continue;
    }
    const byKey = e.key ? rows.find((r) => r.key === e.key) : undefined;
    const byName = rows.find((r) => r.name.toLowerCase() === e.name.toLowerCase());
    const row = byKey ?? byName;
    let match: ImportPreviewItem['match'] = null;
    if (row) {
      const here = toInfo(row);
      const stored = (stage: string) => norm(prompts.find((p) => p.moduleKey === row.key && p.stageKey === stage)?.content);
      const promptChanged = stored('ARTICLE') !== e.article || (e.titles !== null && stored('TITLES') !== e.titles) || (Object.entries(e.photos) as [PhotoPromptStage, string][]).some(([stage, text]) => stored(stage) !== text);
      const settingsChanged = JSON.stringify(here.config) !== JSON.stringify(e.config) || here.base !== e.base || here.description !== e.description;
      const busy = running.find((c) => c.moduleKey === row.key)?._count._all ?? 0;
      const missingPhoto = here.status === 'ACTIVE' ? ownPhotoStages({ base: e.base, config: e.config }).find((stage) => !e.photos[stage] && !stored(stage)) : undefined;
      const updateBlocked =
        here.base !== e.base && busy
          ? `${busy} article(s) of “${here.name}” are still running: “about a person” / “any topic” can change when they are done.`
          : here.status === 'ACTIVE' && e.config.titles === 'own' && !e.titles && !stored('TITLES')
            ? 'It would use its own title prompt, which neither the file nor your writer has.'
            : missingPhoto
              ? `It would use its own ${PROMPT_STAGE_LABELS[missingPhoto].toLowerCase()} prompt, which neither the file nor your writer has.`
              : null;
      match = { key: row.key, name: here.name, status: here.status, by: byKey ? 'key' : 'name', promptChanged, settingsChanged, updateBlocked };
    }
    const suggestedName = await freeName(e.name, taken);
    taken.push({ name: suggestedName, shortName: suggestedName });
    const defaultAction: ImportAction = match && !match.promptChanged && !match.settingsChanged ? 'skip' : match?.by === 'key' && !match.updateBlocked ? 'update' : 'new';
    items.push({ index, name: e.name, base: e.base, description: e.description, summary: summary(e.config, e.base), error: null, warnings: read.warnings, wasActive: e.wasActive, match, suggestedName, defaultAction });
  }
  return { items, entries };
}

export const importWritersSchema = z.object({
  file: z.unknown(),
  fileName: z.string().trim().max(200).optional(),
  /** Only read the file and show what would happen. */
  preview: z.boolean().default(false),
  choices: z
    .array(z.object({ index: z.number().int().min(0).max(MAX_WRITERS_PER_FILE - 1), action: z.enum(['new', 'update', 'skip']), name: z.string().trim().max(60).optional() }))
    .max(MAX_WRITERS_PER_FILE)
    .optional(),
  /** Make the new writers that are active in the file active here too (each only when its checklist is complete). */
  activate: z.boolean().default(false),
});

export async function previewWriterImport(rawFile: unknown): Promise<ImportPreviewItem[]> {
  return (await planImport(rawFile)).items;
}

/**
 * Import the file's writers as chosen (the default for each: what the preview showed). Every choice is checked first;
 * when one cannot be done nothing is written.
 */
export async function importWriters(raw: unknown): Promise<ImportResult | { preview: ImportPreviewItem[] }> {
  const input = importWritersSchema.parse(raw);
  const { items, entries } = await planImport(input.file);
  if (input.preview) return { preview: items };
  const from = input.fileName ? `the file ${input.fileName}` : 'a writer file';
  const fieldErrors: Record<string, string[]> = {};
  const fail = (index: number, message: string) => (fieldErrors[`choices.${index}`] ??= []).push(message);
  const others = (await db.customWriter.findMany({ select: { name: true, shortName: true } })).map((o) => ({ ...o }));
  const updated = new Set<string>();
  const todo: { item: ImportPreviewItem; entry: ParsedEntry; action: 'new' | 'update'; name: string; shortName: string }[] = [];
  for (const item of items) {
    const choice = input.choices?.find((c) => c.index === item.index);
    const action = choice?.action ?? item.defaultAction;
    if (action === 'skip') continue;
    const entry = entries[item.index];
    if (!entry || item.error) {
      fail(item.index, item.error ?? 'This writer cannot be imported.');
      continue;
    }
    if (action === 'update') {
      if (!item.match) fail(item.index, `There is no writer “${item.name}” here to update: add it as a new writer.`);
      else if (item.match.updateBlocked) fail(item.index, item.match.updateBlocked);
      else if (updated.has(item.match.key)) fail(item.index, `Two writers of the file would update “${item.match.name}”.`);
      else {
        updated.add(item.match.key);
        todo.push({ item, entry, action, name: item.match.name, shortName: '' });
      }
      continue;
    }
    const name = choice?.name?.trim() || item.suggestedName;
    const checked = nameSchema.safeParse(name);
    if (!checked.success) {
      fail(item.index, `Name: ${checked.error.issues[0]?.message}`);
      continue;
    }
    // The short name from the file when it is still free here, else the (new) name.
    const fileShort = entry.shortName && !(await nameProblem(name, entry.shortName, undefined, others)) ? entry.shortName : name.slice(0, 24).trim();
    const problem = await nameProblem(name, fileShort, undefined, others);
    if (problem) {
      fail(item.index, problem);
      continue;
    }
    others.push({ name, shortName: fileShort });
    todo.push({ item, entry, action: 'new', name, shortName: fileShort });
  }
  if (Object.keys(fieldErrors).length) {
    const [firstKey, [first]] = Object.entries(fieldErrors)[0];
    const index = Number(firstKey.split('.')[1]);
    throw new AppError(400, 'VALIDATION', `${items[index]?.name ?? 'A writer'}: ${first}`, fieldErrors);
  }
  if (!todo.length) throw new AppError(400, 'NOTHING_TO_IMPORT', 'Nothing to import: every writer is skipped.');

  const result: ImportResult = { imported: [], skipped: items.length - todo.length };
  for (const { item, entry, action, name, shortName } of todo) {
    if (action === 'update') {
      const key = item.match!.key;
      const detail = await updateCustomWriter(key, { description: entry.description, base: entry.base, config: entry.config, prompts: { ARTICLE: entry.article, ...(entry.titles ? { TITLES: entry.titles } : {}), ...entry.photos }, note: `Imported from ${from}` });
      await audit('writer.import', 'CustomWriter', key, { action: 'update', name: detail.writer.name, fileKey: entry.key, fileName: input.fileName ?? null });
      result.imported.push({ index: item.index, key, name: detail.writer.name, action, status: detail.writer.status, note: null });
      continue;
    }
    let key = keyFromName(name);
    for (let i = 2; await db.customWriter.findUnique({ where: { key } }); i++) key = `${keyFromName(name).slice(0, 44)}-${i}`;
    await db.customWriter.create({ data: { key, name, shortName, description: entry.description, base: entry.base, startedFrom: 'import', status: 'DRAFT', config: JSON.stringify(entry.config) } });
    await writePrompt(key, name, 'ARTICLE', entry.article, `Imported from ${from}`);
    if (entry.titles) await writePrompt(key, name, 'TITLES', entry.titles, `Imported from ${from}`);
    for (const [stage, text] of Object.entries(entry.photos) as [PhotoPromptStage, string][]) await writePrompt(key, name, stage, text, `Imported from ${from}`);
    await audit('writer.import', 'CustomWriter', key, { action: 'new', name, fileKey: entry.key, fileName: input.fileName ?? null });
    let status: ImportResult['imported'][number]['status'] = 'DRAFT';
    let note: string | null = null;
    if (input.activate && entry.wasActive) {
      await ensureCustomWriters({ force: true });
      try {
        status = (await setWriterStatus(key, 'ACTIVE')).writer.status;
      } catch (error) {
        note = `Stays a draft: ${(error as Error).message}`;
      }
    }
    result.imported.push({ index: item.index, key, name, action: 'new', status, note });
  }
  await ensureCustomWriters({ force: true });
  return result;
}
