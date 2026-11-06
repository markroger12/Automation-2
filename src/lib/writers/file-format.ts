import type { CustomWriterConfig, WriterBase, WriterStatus } from './types';

/**
 * The writer file (Writers → Export / Import; owner request 2026-11-06: “writer import export ka option add kr”).
 * Client-safe: the constants and shapes both the page and the server use. A file holds each writer's name, settings and
 * current prompts: no passwords, keys, websites or articles.
 */
export const WRITER_FILE_FORMAT = 'blog-automation-studio/writers';
export const WRITER_FILE_VERSION = 1;
/** The import's JSON body may be 2 MB (src/lib/api.ts); the page refuses a larger file before sending it. */
export const MAX_WRITER_FILE_BYTES = 1_900_000;
export const MAX_WRITERS_PER_FILE = 50;

export interface WriterFileEntry {
  /** The writer's key where it was exported (finds the same writer again on import). */
  key: string;
  name: string;
  shortName: string;
  description: string;
  base: WriterBase;
  /** Its status where it was exported (an import makes new writers drafts unless asked otherwise). */
  status: WriterStatus;
  config: CustomWriterConfig;
  prompts: { ARTICLE: string; TITLES: string | null };
}

export interface WriterFile {
  format: typeof WRITER_FILE_FORMAT;
  version: number;
  exportedAt: string;
  about: string;
  writers: WriterFileEntry[];
}

export type ImportAction = 'new' | 'update' | 'skip';

/** One writer of the file as the import dialog shows it (nothing is written yet). */
export interface ImportPreviewItem {
  index: number;
  name: string;
  base: WriterBase | null;
  description: string;
  /** Short facts: word range, FAQs, table, title step. */
  summary: string[];
  /** Why it cannot be imported (then only “Skip”). */
  error: string | null;
  warnings: string[];
  wasActive: boolean;
  /** A writer here that is the same one (same key) or has the same name. */
  match: {
    key: string;
    name: string;
    status: WriterStatus;
    by: 'key' | 'name';
    promptChanged: boolean;
    settingsChanged: boolean;
    /** Why “Update” is not possible now (else null). */
    updateBlocked: string | null;
  } | null;
  /** A free name for “Add as a new writer”. */
  suggestedName: string;
  defaultAction: ImportAction;
}

export interface ImportResult {
  imported: { index: number; key: string; name: string; action: 'new' | 'update'; status: WriterStatus; note: string | null }[];
  skipped: number;
}
