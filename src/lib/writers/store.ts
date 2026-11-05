import { z } from 'zod';
import type { CustomWriter } from '@prisma/client';
import { db } from '../db';
import { AppError } from '../errors';
import { audit } from '../audit';
import { parseJson } from '../json';
import { getSettings } from '../settings';
import { checkPrompt, EXTRA_PROMPT_VARIABLES } from './prompt-check';
import { promptHash } from '../prompts/seed';
import { findPromptDefault, type PromptVariableDoc } from '@/modules/prompt-defaults';
import { parseCustomArticle, type CustomArticleParse } from '@/modules/custom/parsers';
import { MODULE_DISPLAY_NAMES, MODULE_SHORT_NAMES } from '../domain';
import { allCustomWriters, setCustomWriters } from './catalog';
import {
  CUSTOM_PROMPT_VARIABLES,
  customWriterConfigSchema,
  defaultConfig,
  isCustomKey,
  keyFromName,
  WRITER_BASES,
  type CustomWriterConfig,
  type CustomWriterInfo,
  type WriterBase,
  type WriterStatus,
} from './types';
import { PERSON_STARTER_PROMPT, GENERAL_STARTER_PROMPT, OWN_TITLES_STARTER_PROMPT } from './starters';

/**
 * Writers the owner builds in the app (server side): stored in CustomWriter, their prompts in PromptTemplate under the
 * writer's key (every save is a new version, as in Prompt Manager). `ensureCustomWriters` keeps this process's
 * catalog (src/lib/writers/catalog.ts) up to date; the API, the pages and the worker call it.
 */

const toInfo = (row: CustomWriter): CustomWriterInfo => ({
  key: row.key,
  name: row.name,
  shortName: row.shortName,
  description: row.description,
  base: (WRITER_BASES as readonly string[]).includes(row.base) ? (row.base as WriterBase) : 'general',
  status: (['DRAFT', 'ACTIVE', 'ARCHIVED'].includes(row.status) ? row.status : 'DRAFT') as WriterStatus,
  startedFrom: row.startedFrom,
  config: (() => {
    const parsed = customWriterConfigSchema.safeParse(parseJson<unknown>(row.config, {}));
    return parsed.success ? parsed.data : defaultConfig(row.base === 'person' ? 'person' : 'general');
  })(),
});

let loadedAt = 0;
let loading: Promise<CustomWriterInfo[]> | null = null;

/** Load the owner's writers into this process's catalog (at most every 2 s unless forced). */
export async function ensureCustomWriters(opts: { force?: boolean } = {}): Promise<CustomWriterInfo[]> {
  if (!opts.force && Date.now() - loadedAt < 2000 && !loading) return allCustomWriters();
  if (loading && !opts.force) return loading;
  loading = (async () => {
    try {
      const rows = await db.customWriter.findMany({ orderBy: { createdAt: 'asc' } });
      const list = rows.map(toInfo);
      setCustomWriters(list);
      loadedAt = Date.now();
      return list;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Variable notes stored with a custom prompt (all optional: an empty one never blocks sending). */
function promptVariables(): PromptVariableDoc[] {
  return [
    ...CUSTOM_PROMPT_VARIABLES.map((v) => ({ name: v.name, description: v.label, required: false, source: 'input' as const })),
    ...EXTRA_PROMPT_VARIABLES.map((name) => ({ name, description: name.replace(/_/g, ' '), required: false, source: 'settings' as const })),
  ];
}

export { checkPrompt };

const nameSchema = z.string().trim().min(2, 'At least 2 characters.').max(60, 'At most 60 characters.');
const BUILT_IN_NAMES = new Set([...Object.values(MODULE_DISPLAY_NAMES), ...Object.values(MODULE_SHORT_NAMES), 'celebrity', 'celebrity 2', 'tigram'].map((n) => n.toLowerCase()));

async function assertNameFree(name: string, shortName: string, exceptKey?: string) {
  for (const n of [name, shortName]) {
    if (BUILT_IN_NAMES.has(n.toLowerCase())) throw new AppError(409, 'NAME_TAKEN', `“${n}” is the name of a built-in writer. Choose another name.`, { name: ['Choose another name.'] });
  }
  const others = await db.customWriter.findMany({ where: exceptKey ? { key: { not: exceptKey } } : {}, select: { name: true, shortName: true } });
  if (others.some((o) => [o.name, o.shortName].some((x) => [name, shortName].some((n) => x.toLowerCase() === n.toLowerCase())))) {
    throw new AppError(409, 'NAME_TAKEN', `A writer named “${name}” already exists. Choose another name.`, { name: ['Already used by another writer.'] });
  }
}

async function storedPrompt(moduleKey: string, stageKey: string): Promise<string | null> {
  const row = await db.promptTemplate.findUnique({ where: { moduleKey_stageKey: { moduleKey, stageKey } } });
  return row?.content ?? findPromptDefault(moduleKey, stageKey)?.content ?? null;
}

async function writePrompt(key: string, writerName: string, stageKey: 'ARTICLE' | 'TITLES', content: string, note: string) {
  const text = content.replace(/\r\n/g, '\n');
  const existing = await db.promptTemplate.findUnique({ where: { moduleKey_stageKey: { moduleKey: key, stageKey } } });
  const name = `${writerName} — ${stageKey === 'ARTICLE' ? 'Article' : 'Titles'}`;
  const description = stageKey === 'ARTICLE' ? `The article prompt of your writer “${writerName}”.` : `The title prompt of your writer “${writerName}”.`;
  if (!existing) {
    await db.promptTemplate.create({
      data: { moduleKey: key, stageKey, name, description, content: text, defaultHash: promptHash(text), defaultVersion: 0, customized: true, variables: JSON.stringify(promptVariables()), versions: { create: { version: 1, content: text, note } } },
    });
    return 1;
  }
  if (existing.content === text) {
    if (existing.name !== name) await db.promptTemplate.update({ where: { id: existing.id }, data: { name, description } });
    return existing.version;
  }
  const version = existing.version + 1;
  await db.promptTemplate.update({ where: { id: existing.id }, data: { content: text, version, name, description, customized: true, variables: JSON.stringify(promptVariables()), versions: { create: { version, content: text, note } } } });
  return version;
}

export const START_FROM = ['celebrity2-writer', 'celebrity-writer', 'tigram-writer', 'blank-person', 'blank-general'] as const;

export const createWriterSchema = z.object({
  name: nameSchema,
  shortName: z.string().trim().max(24).optional(),
  description: z.string().trim().max(300).optional(),
  /** A built-in writer, an empty person or general writer, or one of the owner's writers (custom-…). */
  startFrom: z.string().trim().max(60).default('blank-person'),
});

/** A new writer (a draft): its settings and prompts copied from the writer it starts from. */
export async function createCustomWriter(raw: unknown): Promise<CustomWriterInfo> {
  const input = createWriterSchema.parse(raw);
  const shortName = input.shortName?.trim() || input.name.trim();
  await assertNameFree(input.name, shortName);
  const settings = await getSettings();
  let base: WriterBase = 'person';
  let config: CustomWriterConfig;
  let article: string;
  let titles: string | null = null;
  let description = input.description ?? '';
  const from = input.startFrom;
  if (from === 'celebrity2-writer') {
    config = customWriterConfigSchema.parse({ titles: 'app', category: { mode: 'celebrity' }, rules: { faqCount: 5, exactFaqs: true, table: 'required', tableHeading: 'Family Profile', tableHeadingDe: 'Familienprofil', wordMin: 1300, wordMax: 1600, seoLines: true, noLists: true } });
    article = (await storedPrompt('celebrity2-writer', 'ARTICLE')) ?? PERSON_STARTER_PROMPT;
    description ||= 'Started from Celebrity 2: the whole article in one answer to your prompt.';
  } else if (from === 'celebrity-writer') {
    config = customWriterConfigSchema.parse({ titles: 'app', category: { mode: 'celebrity' }, rules: { faqCount: settings.content.faqCount, exactFaqs: true, table: 'required', tableHeading: 'Quick Bio', tableHeadingDe: 'Kurzbiografie', wordMin: Math.max(600, settings.content.maxArticleWordCount - 300), wordMax: settings.content.maxArticleWordCount + 300, seoLines: true, noLists: true } });
    article = PERSON_STARTER_PROMPT;
    description ||= 'Started from Celebrity (which writes in several steps): this writer writes the whole article in one answer to your prompt.';
  } else if (from === 'tigram-writer') {
    base = 'general';
    const [lo, hi] = settings.content.tigramWordRange.split(/\s*[-–]\s*/).map(Number);
    config = customWriterConfigSchema.parse({ titles: 'off', category: { mode: 'chatgpt' }, rules: { faqCount: settings.content.tigramFaqCount, exactFaqs: false, table: 'none', wordMin: lo || 1500, wordMax: hi || 2200, seoLines: true } });
    article = (await storedPrompt('tigram-writer', 'ARTICLE')) ?? GENERAL_STARTER_PROMPT;
    description ||= 'Started from Tigram: general topics, the title from the article itself.';
  } else if (from === 'blank-general') {
    base = 'general';
    config = defaultConfig('general');
    article = GENERAL_STARTER_PROMPT;
  } else if (isCustomKey(from)) {
    const src = await db.customWriter.findUnique({ where: { key: from } });
    if (!src) throw new AppError(404, 'NOT_FOUND', 'The writer to copy was not found.');
    const info = toInfo(src);
    base = info.base;
    config = info.config;
    article = (await storedPrompt(from, 'ARTICLE')) ?? (base === 'person' ? PERSON_STARTER_PROMPT : GENERAL_STARTER_PROMPT);
    titles = info.config.titles === 'own' ? await storedPrompt(from, 'TITLES') : null;
    description ||= `Copy of ${info.name}.`;
  } else {
    config = defaultConfig('person');
    article = PERSON_STARTER_PROMPT;
  }
  let key = keyFromName(input.name);
  for (let i = 2; await db.customWriter.findUnique({ where: { key } }); i++) key = `${keyFromName(input.name).slice(0, 44)}-${i}`;
  await db.customWriter.create({ data: { key, name: input.name.trim(), shortName, description, base, startedFrom: from, status: 'DRAFT', config: JSON.stringify(config) } });
  const fromName = MODULE_DISPLAY_NAMES[from] ?? (from === 'blank-person' ? 'an empty person writer' : from === 'blank-general' ? 'an empty general writer' : from);
  await writePrompt(key, input.name.trim(), 'ARTICLE', article, `Created from ${fromName}`);
  if (titles) await writePrompt(key, input.name.trim(), 'TITLES', titles, `Created from ${fromName}`);
  await audit('writer.create', 'CustomWriter', key, { name: input.name, startFrom: from });
  await ensureCustomWriters({ force: true });
  return (await getCustomWriter(key)).writer;
}

export interface WriterReadiness {
  ok: boolean;
  checks: { id: string; label: string; passed: boolean; detail?: string; blocking: boolean }[];
}

export interface LastTest {
  at: string;
  ok: boolean;
  words: number;
  faqs: number;
  tableRows: number;
  h2: string[];
  problems: string[];
  warnings: string[];
  configHash: string;
}

const configHash = (config: CustomWriterConfig, article: string) => promptHash(JSON.stringify(config.rules) + config.titles + article).slice(0, 16);

export function readiness(w: CustomWriterInfo, prompts: { ARTICLE: string | null; TITLES: string | null }, lastTest: LastTest | null): WriterReadiness {
  const article = prompts.ARTICLE ?? '';
  const a = checkPrompt(article, 'ARTICLE');
  const t = w.config.titles === 'own' ? checkPrompt(prompts.TITLES ?? '', 'TITLES') : null;
  const tested = Boolean(lastTest && lastTest.ok && lastTest.configHash === configHash(w.config, article));
  const checks: WriterReadiness['checks'] = [
    { id: 'name', label: 'Name', passed: w.name.length >= 2, blocking: true },
    { id: 'article', label: 'Article prompt', passed: a.errors.length === 0, detail: a.errors[0] ?? a.warnings[0], blocking: true },
    ...(t ? [{ id: 'titles', label: 'Title prompt', passed: t.errors.length === 0, detail: t.errors[0] ?? t.warnings[0], blocking: true }] : []),
    { id: 'category', label: 'Category rule', passed: w.config.category.mode !== 'fixed' || w.config.category.name.length >= 2, detail: w.config.category.mode === 'fixed' ? `Always “${w.config.category.name || '…'}”` : undefined, blocking: true },
    { id: 'test', label: 'Tested with a ChatGPT answer', passed: tested, detail: tested ? `${lastTest!.words} words, ${lastTest!.faqs} FAQs` : lastTest && !lastTest.ok ? (lastTest.problems[0] ?? 'The last test found problems.') : lastTest ? 'Changed since the last test — test again.' : 'Paste one answer of your prompt and test it (recommended).', blocking: false },
  ];
  return { ok: checks.every((c) => c.passed || !c.blocking), checks };
}

export async function getCustomWriter(key: string) {
  const row = await db.customWriter.findUnique({ where: { key } });
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Writer not found.');
  const writer = toInfo(row);
  const [article, titles, tasks] = await Promise.all([
    db.promptTemplate.findUnique({ where: { moduleKey_stageKey: { moduleKey: key, stageKey: 'ARTICLE' } }, select: { id: true, content: true, version: true, updatedAt: true } }),
    db.promptTemplate.findUnique({ where: { moduleKey_stageKey: { moduleKey: key, stageKey: 'TITLES' } }, select: { id: true, content: true, version: true, updatedAt: true } }),
    db.articleTask.count({ where: { moduleKey: key } }),
  ]);
  const lastTest = parseJson<LastTest | null>(row.lastTest, null);
  const prompts = { ARTICLE: article?.content ?? null, TITLES: titles?.content ?? null };
  return { writer, prompts, promptIds: { ARTICLE: article?.id ?? null, TITLES: titles?.id ?? null }, promptVersions: { ARTICLE: article?.version ?? 0, TITLES: titles?.version ?? 0 }, tasks, lastTest, readiness: readiness(writer, prompts, lastTest), createdAt: row.createdAt, updatedAt: row.updatedAt };
}
export type CustomWriterDetail = Awaited<ReturnType<typeof getCustomWriter>>;

export async function listCustomWriters() {
  await ensureCustomWriters({ force: true });
  const rows = await db.customWriter.findMany({ orderBy: [{ status: 'asc' }, { createdAt: 'asc' }] });
  const counts = await db.articleTask.groupBy({ by: ['moduleKey'], where: { moduleKey: { in: rows.map((r) => r.key) } }, _count: { _all: true } });
  return rows.map((r) => ({ ...toInfo(r), tasks: counts.find((c) => c.moduleKey === r.key)?._count._all ?? 0, lastTest: parseJson<LastTest | null>(r.lastTest, null), updatedAt: r.updatedAt }));
}

export const updateWriterSchema = z.object({
  name: nameSchema.optional(),
  shortName: z.string().trim().min(1).max(24).optional(),
  description: z.string().trim().max(300).optional(),
  base: z.enum(WRITER_BASES).optional(),
  config: z.unknown().optional(),
  prompts: z.object({ ARTICLE: z.string().max(100_000).optional(), TITLES: z.string().max(100_000).optional() }).optional(),
  note: z.string().trim().max(200).optional(),
});

/** Save the writer's settings and prompts (each prompt change is a new version). */
export async function updateCustomWriter(key: string, raw: unknown) {
  const input = updateWriterSchema.parse(raw);
  const row = await db.customWriter.findUnique({ where: { key } });
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Writer not found.');
  const current = toInfo(row);
  const name = input.name ?? current.name;
  const shortName = input.shortName ?? (input.name && current.shortName === current.name ? input.name : current.shortName);
  if (input.name || input.shortName) await assertNameFree(name, shortName, key);
  let config = current.config;
  if (input.config !== undefined) {
    const parsed = customWriterConfigSchema.safeParse(input.config);
    if (!parsed.success) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) (fieldErrors[`config.${issue.path.join('.')}`] ??= []).push(issue.message);
      throw new AppError(400, 'VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid settings.', fieldErrors);
    }
    config = parsed.data;
  }
  const base = input.base ?? current.base;
  if (base !== current.base && (await db.articleTask.count({ where: { moduleKey: key, status: { notIn: ['COMPLETED', 'CANCELLED', 'FAILED'] } } }))) {
    throw new AppError(409, 'IN_USE', 'Articles of this writer are still running; person/general can be changed when they are done.');
  }
  for (const stage of ['ARTICLE', 'TITLES'] as const) {
    const text = input.prompts?.[stage];
    if (text === undefined) continue;
    const check = checkPrompt(text, stage);
    if (check.errors.length) throw new AppError(400, 'VALIDATION', `${stage === 'ARTICLE' ? 'Article' : 'Title'} prompt: ${check.errors[0]}`, { [`prompts.${stage}`]: check.errors });
  }
  if (current.status === 'ACTIVE' && config.titles === 'own' && !input.prompts?.TITLES && !(await db.promptTemplate.findUnique({ where: { moduleKey_stageKey: { moduleKey: key, stageKey: 'TITLES' } } }))) {
    throw new AppError(400, 'VALIDATION', 'Write the title prompt first (or use the app’s title step).', { 'prompts.TITLES': ['Write the title prompt.'] });
  }
  await db.customWriter.update({ where: { key }, data: { name, shortName, description: input.description ?? current.description, base, config: JSON.stringify(config) } });
  for (const stage of ['ARTICLE', 'TITLES'] as const) {
    const text = input.prompts?.[stage];
    if (text !== undefined && text.trim()) await writePrompt(key, name, stage, text, input.note || 'Edited on the writer page');
  }
  await audit('writer.update', 'CustomWriter', key, { name, base, prompts: Object.keys(input.prompts ?? {}) });
  await ensureCustomWriters({ force: true });
  return getCustomWriter(key);
}

/** Active: offered everywhere a writer is chosen. Draft: only on its page. Archived: hidden; its articles still finish. */
export async function setWriterStatus(key: string, status: WriterStatus) {
  const detail = await getCustomWriter(key);
  if (status === 'ACTIVE' && !detail.readiness.ok) {
    const missing = detail.readiness.checks.filter((c) => c.blocking && !c.passed).map((c) => `${c.label}${c.detail ? `: ${c.detail}` : ''}`);
    throw new AppError(400, 'NOT_READY', `Not ready to use: ${missing.join('; ')}.`);
  }
  await db.customWriter.update({ where: { key }, data: { status } });
  await audit('writer.status', 'CustomWriter', key, { status });
  await ensureCustomWriters({ force: true });
  return getCustomWriter(key);
}

/** Deleted only when no article used it (otherwise archive it: its articles keep their writer). */
export async function deleteCustomWriter(key: string) {
  const row = await db.customWriter.findUnique({ where: { key } });
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Writer not found.');
  const tasks = await db.articleTask.count({ where: { moduleKey: key } });
  const keywords = await db.workflowKeyword.count({ where: { writerType: key, status: { in: ['WAITING', 'WRITING', 'READY', 'SCHEDULED'] } } });
  if (tasks || keywords) throw new AppError(409, 'IN_USE', `${tasks ? `${tasks} article(s)` : ''}${tasks && keywords ? ' and ' : ''}${keywords ? `${keywords} workflow keyword(s)` : ''} use this writer. Archive it instead: it disappears from the writer lists, and its articles keep it.`);
  await db.promptTemplate.deleteMany({ where: { moduleKey: key } });
  await db.customWriter.delete({ where: { key } });
  await audit('writer.delete', 'CustomWriter', key, { name: row.name });
  await ensureCustomWriters({ force: true });
  return { deleted: true };
}

export const testWriterSchema = z.object({
  answer: z.string().min(1, 'Paste a ChatGPT answer.').max(200_000),
  language: z.enum(['en', 'de']).default('en'),
  title: z.string().trim().max(200).optional(),
  /** Unsaved settings from the page (else the saved ones). */
  config: z.unknown().optional(),
  base: z.enum(WRITER_BASES).optional(),
  article: z.string().max(100_000).optional(),
});

/** Read a ChatGPT answer as this writer would: what the article gets, and what would be asked again or reviewed. */
export async function testCustomWriter(key: string, raw: unknown): Promise<{ parse: CustomArticleParse; result: LastTest; saved: boolean }> {
  const input = testWriterSchema.parse(raw);
  const detail = await getCustomWriter(key);
  const config = input.config !== undefined ? customWriterConfigSchema.parse(input.config) : detail.writer.config;
  const base = input.base ?? detail.writer.base;
  const parse = parseCustomArticle(input.answer, input.language, input.title || null, { base, rules: config.rules });
  const article = input.article ?? detail.prompts.ARTICLE ?? '';
  const result: LastTest = {
    at: new Date().toISOString(),
    ok: parse.problems.length === 0,
    words: parse.words,
    faqs: parse.faqs.length,
    tableRows: parse.bioRows.length,
    h2: parse.h2,
    problems: parse.problems,
    warnings: parse.warnings,
    configHash: configHash(config, article),
  };
  // Saved as the writer's last test when it was made with the saved settings and prompt.
  const saved = input.config === undefined || JSON.stringify(config) === JSON.stringify(detail.writer.config);
  if (saved && (input.article === undefined || input.article === detail.prompts.ARTICLE) && base === detail.writer.base) {
    await db.customWriter.update({ where: { key }, data: { lastTest: JSON.stringify(result) } });
    return { parse, result, saved: true };
  }
  return { parse, result, saved: false };
}

/** The writer's prompts rendered with example values (the editor's “Preview”). */
export { CUSTOM_PROMPT_VARIABLES, OWN_TITLES_STARTER_PROMPT };
