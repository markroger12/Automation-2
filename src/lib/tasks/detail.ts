import { db } from '../db';
import { parseJson, stringArray } from '../json';
import { moduleDisplayName, statusGroup } from '../domain';
import { sanitizeArticleHtml } from '../html/sanitize';
import { stripTags } from '../content/text';

/** Rank Math report as stored by the RANKMATH stage (values read from WordPress, never computed). */
export interface RankMathReportView {
  mode: string;
  active: boolean;
  target: number;
  score: number | null;
  scoreText: string | null;
  scoreVia: string | null;
  fields: { focusKeyword: string | null; title: string | null; description: string | null } | null;
  fieldsVerified: boolean;
  fieldProblems: string[];
  recommendations: { text: string; state: string }[];
  rounds: { round: number; kind: string; scoreBefore: number | null; scoreAfter?: number | null; changes: string[]; accepted: boolean; reasons?: string[]; before?: string; after?: string }[];
  editor: string | null;
  invalidBlocksFixed: number;
  editorSave: string | null;
  notes: string[];
  checkedAt: string;
}

export async function getTaskDetail(id: string) {
  const task = await db.articleTask.findUnique({
    where: { id },
    include: {
      website: { select: { id: true, name: true, language: true, publicUrl: true, adminUrl: true, canPublish: true, internalLinkLine: true } },
      stages: { orderBy: { position: 'asc' } },
      responses: { orderBy: { createdAt: 'asc' } },
      seoReports: { orderBy: { createdAt: 'desc' }, take: 10 },
      mediaAssets: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!task) return null;
  const [logs, jobs, incidents, revisions] = await Promise.all([
    db.log.findMany({ where: { taskId: id }, orderBy: { createdAt: 'desc' }, take: 300 }),
    db.queueJob.findMany({ where: { taskId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    db.recoveryIncident.findMany({ where: { taskId: id }, orderBy: { createdAt: 'desc' } }),
    db.articleStageRevision.findMany({ where: { taskId: id }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ]);
  return {
    ...task,
    writerName: moduleDisplayName(task.moduleKey),
    group: statusGroup(task.status),
    secondaryKeywordList: stringArray(task.secondaryKeywords),
    titleOptionList: stringArray(task.titleOptions),
    tagList: stringArray(task.tags),
    faqList: parseJson<{ question: string; answer: string }[]>(task.faqs, []),
    quickBioRows: parseJson<{ attribute: string; details: string }[]>(task.quickBio, []),
    reviewReasonList: parseJson<string[]>(task.reviewReasons, []),
    errorList: parseJson<{ at: string; stage: string | null; message: string }[]>(task.errors, []),
    optionValues: parseJson<Record<string, unknown>>(task.options, {}),
    config: parseJson<Record<string, unknown>>(task.configSnapshot, {}),
    metricsValues: parseJson<Record<string, unknown>>(task.metrics, {}),
    routeDecisionValue: parseJson<Record<string, unknown>>(task.routeDecision, {}),
    rankMathReportValue: parseJson<RankMathReportView | null>(task.rankMathReport, null),
    logs,
    jobs,
    incidents,
    revisions,
  };
}

export type TaskDetail = NonNullable<Awaited<ReturnType<typeof getTaskDetail>>>;

/** JSON-safe version for client components (Dates → ISO strings). */
export function serializeDetail(detail: TaskDetail) {
  const safe = {
    ...detail,
    bodyHtml: detail.bodyHtml ? sanitizeArticleHtml(detail.bodyHtml) : null,
    editedHtml: detail.editedHtml ? sanitizeArticleHtml(detail.editedHtml) : null,
    assembledHtml: detail.assembledHtml ? sanitizeArticleHtml(detail.assembledHtml) : null,
    quickBioHtml: detail.quickBioHtml ? sanitizeArticleHtml(detail.quickBioHtml) : null,
    // Correction rounds are shown as text only.
    rankMathReportValue: detail.rankMathReportValue
      ? {
          ...detail.rankMathReportValue,
          rounds: detail.rankMathReportValue.rounds.map((r) => ({ ...r, before: r.before ? stripTags(r.before) : undefined, after: r.after ? stripTags(r.after) : undefined })),
        }
      : null,
  };
  return JSON.parse(JSON.stringify(safe)) as SerializedTaskDetail;
}

type Serialized<T> = T extends Date ? string : T extends (infer U)[] ? Serialized<U>[] : T extends object ? { [K in keyof T]: Serialized<T[K]> } : T;
export type SerializedTaskDetail = Serialized<TaskDetail>;
