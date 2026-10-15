import { db } from '../db';
import { parseJson } from '../json';
import type { QualityFinding } from './gate';

/**
 * ArticleQualityReport (upgrade 12): one stored record per evaluation,
 * combining the quality gate's hard stops and warnings with the evidence
 * behind them, per area. Every number comes from a stage result (SEO
 * check, research analysis, duplicate check, links, images, Rank Math as
 * read from the editor, the WordPress read-back) — none is invented here.
 */

export interface QualitySections {
  seo?: { score: number; threshold: number; failed: string[] };
  structure?: { words: number; faqCount: number; expectedFaqCount: number; quickBioRows: number | null; quickBioColumnsOk: boolean | null; emptyHeadings: number; duplicateSentences: number };
  evidence?: { sources: number; uncertain: number; warnings: string[]; claims?: number; verified?: number; contradicted?: number; unsupportedInArticle?: number } | null;
  duplicates?: { highest: string | null; overridden: boolean; overrideReason: string | null; compared: number; matches: { otherTaskId: string; title: string; website: string; severity: string; wordingShare: number; longestRun: number; factWords: number }[] };
  links?: { external: number; internalLinkLine: boolean };
  images?: { count: number; withAlt: number; required: boolean };
  rankMath?: { mode: string; active: boolean | null; score: number | null; scoreVia: string | null; fieldsVerified: boolean | null } | null;
  wordpress?: { postId: number | null; verified: boolean; status: string | null } | null;
}

export type QualityStatus = 'PASS' | 'REVIEW' | 'BLOCKED';

export function statusOf(hardStops: QualityFinding[], warnings: QualityFinding[], overridden: boolean): QualityStatus {
  if (hardStops.length && !overridden) return 'BLOCKED';
  if (hardStops.length || warnings.length) return 'REVIEW';
  return 'PASS';
}

export async function saveQualityReport(taskId: string, stage: 'QUALITY_GATE' | 'VERIFIED_COMPLETE', input: { hardStops: QualityFinding[]; warnings: QualityFinding[]; sections: QualitySections; overridden?: boolean }) {
  const status = statusOf(input.hardStops, input.warnings, input.overridden ?? false);
  return db.articleQualityReport.create({ data: { taskId, stage, status, hardStops: JSON.stringify(input.hardStops), warnings: JSON.stringify(input.warnings), sections: JSON.stringify(input.sections) } });
}

export async function latestQualityReport(taskId: string) {
  const r = await db.articleQualityReport.findFirst({ where: { taskId }, orderBy: { createdAt: 'desc' } });
  if (!r) return null;
  return { id: r.id, stage: r.stage, status: r.status as QualityStatus, createdAt: r.createdAt, hardStops: parseJson<QualityFinding[]>(r.hardStops, []), warnings: parseJson<QualityFinding[]>(r.warnings, []), sections: parseJson<QualitySections>(r.sections, {}) };
}
