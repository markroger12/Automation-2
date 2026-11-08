import { z } from 'zod';
import { customWriter, isActiveCustomWriter, isPersonCustomWriter } from './writers/catalog';
import { isCustomKey } from './writers/types';

/**
 * Shared, client-safe domain vocabulary. Every status column in SQLite is a
 * string validated against these lists.
 */

export const TASK_STATUSES = [
  'QUEUED',
  'OPENING_CHATGPT',
  'GENERATING_TITLES',
  'AWAITING_TITLE_APPROVAL',
  'RESEARCHING',
  'WRITING_ARTICLE',
  'OPTIMIZING',
  'GENERATING_FAQS',
  'GENERATING_BIO_TABLE',
  'LINKING',
  'PROCESSING_IMAGES',
  'HUMANIZING',
  'ASSEMBLING',
  'SEO_CHECKING',
  'QUALITY_CHECKING',
  'AWAITING_ARTICLE_APPROVAL',
  'OPENING_WORDPRESS',
  'CREATING_DRAFT',
  'RUNNING_RANKMATH',
  'DRAFT_CREATED',
  'COMPLETED',
  'NEEDS_REVIEW',
  'LOGIN_REQUIRED',
  'PAUSED',
  'FAILED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const taskStatusSchema = z.enum(TASK_STATUSES);

export const RUNNING_STATUSES: TaskStatus[] = [
  'OPENING_CHATGPT',
  'GENERATING_TITLES',
  'RESEARCHING',
  'WRITING_ARTICLE',
  'OPTIMIZING',
  'GENERATING_FAQS',
  'GENERATING_BIO_TABLE',
  'LINKING',
  'PROCESSING_IMAGES',
  'HUMANIZING',
  'ASSEMBLING',
  'SEO_CHECKING',
  'QUALITY_CHECKING',
  'OPENING_WORDPRESS',
  'CREATING_DRAFT',
  'RUNNING_RANKMATH',
];
export const REVIEW_STATUSES: TaskStatus[] = ['AWAITING_TITLE_APPROVAL', 'AWAITING_ARTICLE_APPROVAL', 'NEEDS_REVIEW'];
export const PAUSED_STATUSES: TaskStatus[] = ['LOGIN_REQUIRED', 'PAUSED'];
export const DRAFT_STATUSES: TaskStatus[] = ['DRAFT_CREATED', 'COMPLETED'];
/** Statuses in which no further automatic processing happens without user action. */
export const TERMINAL_STATUSES: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export type StatusGroup = 'queued' | 'running' | 'review' | 'paused' | 'draft' | 'failed' | 'cancelled';

export function statusGroup(status: string): StatusGroup {
  if (status === 'QUEUED') return 'queued';
  if ((RUNNING_STATUSES as string[]).includes(status)) return 'running';
  if ((REVIEW_STATUSES as string[]).includes(status)) return 'review';
  if ((PAUSED_STATUSES as string[]).includes(status)) return 'paused';
  if ((DRAFT_STATUSES as string[]).includes(status)) return 'draft';
  if (status === 'FAILED') return 'failed';
  return 'cancelled';
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  QUEUED: 'Queued',
  OPENING_CHATGPT: 'Opening ChatGPT',
  GENERATING_TITLES: 'Generating titles',
  AWAITING_TITLE_APPROVAL: 'Awaiting title approval',
  RESEARCHING: 'Researching',
  WRITING_ARTICLE: 'Writing article',
  OPTIMIZING: 'Optimizing',
  GENERATING_FAQS: 'Generating FAQs',
  GENERATING_BIO_TABLE: 'Generating Quick Bio',
  LINKING: 'Linking',
  PROCESSING_IMAGES: 'Processing images',
  HUMANIZING: 'Humanizing',
  ASSEMBLING: 'Assembling',
  SEO_CHECKING: 'SEO check',
  QUALITY_CHECKING: 'Quality gate',
  AWAITING_ARTICLE_APPROVAL: 'Awaiting article approval',
  OPENING_WORDPRESS: 'Opening WordPress',
  CREATING_DRAFT: 'Creating draft',
  RUNNING_RANKMATH: 'Rank Math',
  DRAFT_CREATED: 'Draft created',
  COMPLETED: 'Verified complete',
  NEEDS_REVIEW: 'Needs review',
  LOGIN_REQUIRED: 'Login required',
  PAUSED: 'Paused',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

export const STAGE_STATUSES = ['PENDING', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'SKIPPED'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const STAGE_KINDS = ['chatgpt', 'local', 'gate', 'wordpress'] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const QUEUES = ['article', 'chatgpt', 'control', 'workflow', 'humanizer', 'maintenance', 'gsc'] as const;
export type QueueName = (typeof QUEUES)[number];

export const JOB_STATUSES = ['WAITING', 'ACTIVE', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const PROFILE_KINDS = ['CHATGPT', 'WORDPRESS', 'GENERIC'] as const;
export const SESSION_STATES = ['UNKNOWN', 'ACTIVE', 'LOGIN_REQUIRED', 'ERROR'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const EDITOR_TYPES = ['AUTO', 'GUTENBERG', 'CLASSIC'] as const;
export type EditorType = (typeof EDITOR_TYPES)[number];

export const LANGUAGES = ['en', 'de'] as const;
export type Language = (typeof LANGUAGES)[number];
export const languageSchema = z.enum(LANGUAGES);
export const LANGUAGE_LABELS: Record<Language, string> = { en: 'English', de: 'German' };

export const PRESET_COUNTRIES = ['United States', 'Germany', 'United Kingdom'] as const;
/** Custom country names: letters (incl. accents), spaces, apostrophes, dots and hyphens. */
export const countrySchema = z
  .string()
  .trim()
  .min(2, 'Country must be at least 2 characters')
  .max(56, 'Country must be at most 56 characters')
  .regex(/^[\p{L}][\p{L} .'-]*$/u, 'Country may only contain letters, spaces, dots, apostrophes and hyphens');

/**
 * Active writer modules. Celebrity Writer 2.0 is retired. “Celebrity 2” (owner request, 2026-11-04: the owner's own
 * one-prompt celebrity article) is a separate, new writer with its own key — never the retired 2.0.
 */
export const ACTIVE_MODULE_KEYS = ['celebrity-writer', 'celebrity2-writer', 'tigram-writer'] as const;
/** The writers in the code. Writers the owner builds in the app have keys “custom-…” (src/lib/writers). */
export type BuiltInModuleKey = (typeof ACTIVE_MODULE_KEYS)[number];
export type ActiveModuleKey = BuiltInModuleKey | `custom-${string}`;
export const isBuiltInModuleKey = (key: string | null | undefined): key is BuiltInModuleKey => Boolean(key) && (ACTIVE_MODULE_KEYS as readonly string[]).includes(key!);
export const activeModuleKeySchema = z.custom<ActiveModuleKey>((v) => typeof v === 'string' && isActiveModuleKey(v), {
  error: 'Choose one of the active writers (Celebrity, Celebrity 2, Tigram or one of your own).',
});
/** Archival identifier only — never queueable. */
export const LEGACY_MODULE_KEYS = ['celebrity-writer-2'] as const;
export type LegacyModuleKey = (typeof LEGACY_MODULE_KEYS)[number];

/** A writer new articles may be started with: a built-in one, or one of the owner's that is active. */
export function isActiveModuleKey(key: string): key is ActiveModuleKey {
  return isBuiltInModuleKey(key) || isActiveCustomWriter(key);
}

/** A writer whose articles still run: also the owner's drafts and archived writers (their articles finish). */
export function isRunnableModuleKey(key: string): key is ActiveModuleKey {
  return isBuiltInModuleKey(key) || Boolean(customWriter(key));
}

/** Person articles (celebrity photos, the facts table, family-claim checks): both celebrity writers and the owner's person writers. */
export function isCelebrityModule(key: string | null | undefined): boolean {
  return key === 'celebrity-writer' || key === 'celebrity2-writer' || isPersonCustomWriter(key);
}

export const MODULE_DISPLAY_NAMES: Record<string, string> = {
  'celebrity-writer': 'Celebrity Article Writer',
  'celebrity2-writer': 'Celebrity 2 Article Writer',
  'tigram-writer': 'Tigram Article Writer',
  'celebrity-writer-2': 'Celebrity Writer 2.0 (retired)',
};

/** Short writer names for tables and buttons. */
export const MODULE_SHORT_NAMES: Record<string, string> = { 'celebrity-writer': 'Celebrity', 'celebrity2-writer': 'Celebrity 2', 'tigram-writer': 'Tigram' };

export function moduleDisplayName(key: string): string {
  return MODULE_DISPLAY_NAMES[key] ?? customWriter(key)?.name ?? key;
}

export function moduleShortName(key: string): string {
  return MODULE_SHORT_NAMES[key] ?? customWriter(key)?.shortName ?? key;
}

/** Workflow keywords store their writer as a type; the owner's writers are stored by their key. */
export const WRITER_TYPES = ['UNKNOWN', 'CELEBRITY', 'CELEBRITY2', 'TIGRAM'] as const;
export type WriterType = (typeof WRITER_TYPES)[number] | `custom-${string}`;
export const isWriterType = (v: string): v is WriterType => (WRITER_TYPES as readonly string[]).includes(v) || isCustomKey(v);
export function writerTypeToModule(type: string): ActiveModuleKey | null {
  if (type === 'CELEBRITY') return 'celebrity-writer';
  if (type === 'CELEBRITY2') return 'celebrity2-writer';
  if (type === 'TIGRAM') return 'tigram-writer';
  if (isActiveCustomWriter(type)) return type as ActiveModuleKey;
  return null;
}
export function moduleToWriterType(key: string | null | undefined): WriterType {
  if (key === 'celebrity-writer') return 'CELEBRITY';
  if (key === 'celebrity2-writer') return 'CELEBRITY2';
  if (key === 'tigram-writer') return 'TIGRAM';
  if (isCustomKey(key)) return key as WriterType;
  return 'UNKNOWN';
}

export const TASK_SOURCES = ['SINGLE', 'BULK', 'WORKFLOW', 'BENCHMARK', 'REFRESH'] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export const EXTENSION_FAIL_CODES = ['LOGIN', 'HUMAN_CHECK', 'CONVERSATION_LOST', 'USAGE_LIMIT', 'CANCELLED', 'ERROR'] as const;
export type ExtensionFailCode = (typeof EXTENSION_FAIL_CODES)[number];

export const WORKFLOW_KEYWORD_STATUSES = [
  'WAITING',
  'WRITING',
  'READY',
  'SCHEDULED',
  'PUBLISHED',
  'INDEXING_REQUESTED',
  'INDEXED',
  'FAILED',
  'SKIPPED',
  'DONE',
] as const;
export type WorkflowKeywordStatus = (typeof WORKFLOW_KEYWORD_STATUSES)[number];

export function normalizeKeyword(keyword: string): string {
  return keyword
    .normalize('NFKC')
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
