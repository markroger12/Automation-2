import { z } from 'zod';

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

/** Active writer modules. Exactly two; Celebrity Writer 2.0 is retired. */
export const ACTIVE_MODULE_KEYS = ['celebrity-writer', 'tigram-writer'] as const;
export type ActiveModuleKey = (typeof ACTIVE_MODULE_KEYS)[number];
export const activeModuleKeySchema = z.enum(ACTIVE_MODULE_KEYS, {
  error: 'Choose Celebrity Article Writer or Tigram Article Writer',
});
/** Archival identifier only — never queueable. */
export const LEGACY_MODULE_KEYS = ['celebrity-writer-2'] as const;
export type LegacyModuleKey = (typeof LEGACY_MODULE_KEYS)[number];

export function isActiveModuleKey(key: string): key is ActiveModuleKey {
  return (ACTIVE_MODULE_KEYS as readonly string[]).includes(key);
}

export const MODULE_DISPLAY_NAMES: Record<string, string> = {
  'celebrity-writer': 'Celebrity Article Writer',
  'tigram-writer': 'Tigram Article Writer',
  'celebrity-writer-2': 'Celebrity Writer 2.0 (retired)',
};

export function moduleDisplayName(key: string): string {
  return MODULE_DISPLAY_NAMES[key] ?? key;
}

export const WRITER_TYPES = ['UNKNOWN', 'CELEBRITY', 'TIGRAM'] as const;
export type WriterType = (typeof WRITER_TYPES)[number];
export function writerTypeToModule(type: WriterType): ActiveModuleKey | null {
  if (type === 'CELEBRITY') return 'celebrity-writer';
  if (type === 'TIGRAM') return 'tigram-writer';
  return null;
}
export function moduleToWriterType(key: string): WriterType {
  if (key === 'celebrity-writer') return 'CELEBRITY';
  if (key === 'tigram-writer') return 'TIGRAM';
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
