/** Plagiarism Evidence Checker result shapes (shared by the worker and the page). */

export interface Highlight {
  before: string;
  match: string;
  after: string;
}

export interface EvidenceItem {
  /** Index into `sources`. */
  source: number;
  kind: 'exact' | 'near';
  article: Highlight;
  match: Highlight;
  /** exact: words in the verified identical run; near: words in the article sentence. */
  words: number;
  /** near only: content words shared / content words of the article sentence, and word-order overlap (0–1). */
  shared?: number;
  contentWords?: number;
  ordered?: number;
}

export interface ExemptItem {
  source: number;
  reason: 'quotation' | 'boilerplate';
  text: string;
  words: number;
}

export interface SourceReport {
  kind: 'OWNER_ARTICLE' | 'LINKED_PAGE' | 'USER_URL' | 'WIKIPEDIA' | 'SEARCH_RESULT';
  title: string;
  url: string | null;
  taskId: string | null;
  query?: string;
  exactRuns: number;
  longestRun: number;
  exactWords: number;
  nearMatches: number;
}

export interface CoverageEntry {
  kind: 'OWNER_ARTICLES' | 'LINKED_PAGE' | 'USER_URL' | 'WIKIPEDIA' | 'SEARCH';
  label: string;
  url?: string;
  status: 'CHECKED' | 'FAILED' | 'SKIPPED' | 'NOT_CONFIGURED';
  detail: string;
}

export interface PlagiarismResult {
  articleWords: number;
  /** Saved articles, pages and extracts actually compared. */
  documentsCompared: number;
  /** Article words inside verified exact runs of ≥ 8 words (any source, counted once). */
  wordsInExactRuns: number;
  /** Article sentences with a near match (and no exact run). */
  nearSentences: number;
  exempt: { quotedWords: number; boilerplateWords: number; boilerplateBlocks: { text: string; articles: number }[] };
  /** Sources with at least one finding (or only exempt overlaps, so the exempt list can name them). */
  sources: SourceReport[];
  evidence: EvidenceItem[];
  exemptMatches: ExemptItem[];
  coverage: CoverageEntry[];
  limitations: string[];
  checkedAt: string;
}

export interface PlagiarismOptions {
  ownerArticles: boolean;
  linkedPages: boolean;
  wikipedia: boolean;
  search: boolean;
  urls: string[];
}
