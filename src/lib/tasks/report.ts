import { db } from '../db';
import { parseJson } from '../json';
import { redact } from '../redact';
import { APP_VERSION } from '../version';
import { EXPECTED_EXTENSION_VERSION } from '../agent/version';
import { AppError } from '../errors';

/**
 * Everything the app knows about one article, as one JSON document the owner can save and share for support:
 * the task, every stage (prompt and output), every ChatGPT exchange, quality reports, the research evidence,
 * WordPress / Rank Math verification, recovery incidents and the article's logs. No settings, cookies or keys;
 * strings pass through the same redaction as the diagnostic bundle.
 */
export async function articleReport(taskId: string) {
  const task = await db.articleTask.findUnique({ where: { id: taskId }, include: { website: { select: { name: true, publicUrl: true, language: true, timezone: true } } } });
  if (!task) throw new AppError(404, 'NOT_FOUND', 'Task not found.');
  const [stages, responses, qualityReports, claims, incidents, logs, seoReports, linkSuggestions] = await Promise.all([
    db.articleStage.findMany({ where: { taskId }, orderBy: { position: 'asc' } }),
    db.chatGPTResponse.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } }),
    db.articleQualityReport.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } }),
    db.claimEvidence.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } }),
    db.recoveryIncident.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } }),
    db.log.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' }, take: 2000 }),
    db.sEOReport.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } }),
    db.suggestedInternalLink.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } }),
  ]);
  const json = (raw: string | null | undefined) => parseJson<unknown>(raw, raw ?? null);
  const report = {
    kind: 'blog-automation-studio.article-report',
    generatedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    expectedExtensionVersion: EXPECTED_EXTENSION_VERSION,
    task: {
      id: task.id,
      writer: task.moduleKey,
      website: task.website,
      keyword: task.keyword,
      secondaryKeywords: json(task.secondaryKeywords),
      exampleTitle: task.exampleTitle,
      language: task.language,
      targetCountry: task.targetCountry,
      category: task.categoryName,
      status: task.status,
      stage: task.stage,
      percent: task.percent,
      message: task.message,
      nextAction: task.nextAction,
      reviewReasons: json(task.reviewReasons),
      errors: json(task.errors),
      titleOptions: json(task.titleOptions),
      recommendedTitle: task.recommendedTitle,
      selectedTitle: task.selectedTitle,
      seoTitle: task.seoTitle,
      metaDescription: task.metaDescription,
      slug: task.slug,
      focusKeyword: task.focusKeyword,
      seoBrief: json(task.seoBrief),
      seoScore: task.seoScore,
      rankMathScore: task.rankMathScore,
      rankMathReport: json(task.rankMathReport),
      faqs: json(task.faqs),
      quickBio: json(task.quickBio),
      tags: json(task.tags),
      metrics: json(task.metrics),
      conversationUrl: task.conversationUrl,
      // The settings this article runs with, fixed when it started (later changes in Settings do not apply to it).
      settingsUsed: json(task.configSnapshot),
      options: json(task.options),
      wordpress: { postId: task.wpPostId, editUrl: task.wpEditUrl, status: task.wpPostStatus, draftAt: task.wpDraftAt, verifiedAt: task.wpVerifiedAt, slug: task.wpSlug },
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      verifiedCompleteAt: task.verifiedCompleteAt,
    },
    article: { researchNotes: task.researchNotes, bodyHtml: task.bodyHtml, editedHtml: task.editedHtml, assembledHtml: task.assembledHtml, quickBioHtml: task.quickBioHtml },
    // ("stageKey", not "key": the redaction hides any field named "key".)
    stages: stages.map((s) => ({
      stageKey: s.key,
      label: s.label,
      kind: s.kind,
      status: s.status,
      attempts: s.attempts,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      durationMs: s.durationMs,
      message: s.message,
      error: s.error,
      promptVersion: s.promptVersion,
      prompt: s.prompt,
      output: s.output,
      outputJson: json(s.outputJson),
    })),
    chatgpt: responses.map((r) => ({
      stageKey: r.stageKey,
      attempt: r.attempt,
      operationId: r.operationId,
      status: r.status,
      error: r.error,
      recovered: r.recovered,
      reused: r.reused,
      conversationSwitch: r.conversationSwitch,
      conversationUrl: r.conversationUrl,
      elapsedMs: r.elapsedMs,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
      prompt: r.renderedPrompt,
      answer: r.resultText,
    })),
    qualityReports: qualityReports.map((q) => ({ stage: q.stage, status: q.status, hardStops: json(q.hardStops), warnings: json(q.warnings), sections: json(q.sections), createdAt: q.createdAt })),
    seoReports: seoReports.map((r) => ({ source: r.source, score: r.score, checks: json(r.checks), metrics: json(r.metrics), createdAt: r.createdAt })),
    researchEvidence: claims.map((c) => ({
      type: c.claimType,
      claim: c.claimText,
      nature: c.nature,
      highImpact: c.highImpact,
      status: c.status,
      articleParagraph: c.articleParagraph,
      citations: json(c.citations),
      evidence: json(c.evidence),
      ownerDecision: c.ownerDecision,
      ownerValue: c.ownerValue,
    })),
    internalLinks: linkSuggestions.map((l) => ({ url: l.url, title: l.title, kind: l.kind, anchor: l.anchor, score: l.score, status: l.status, reasons: json(l.reasons), note: l.note })),
    incidents: incidents.map((i) => ({ kind: i.kind, severity: i.severity, status: i.status, stageKey: i.stageKey, description: i.description, resolution: i.resolution, createdAt: i.createdAt, resolvedAt: i.resolvedAt })),
    logs: logs.map((l) => ({ at: l.createdAt, level: l.level, category: l.category, stage: l.stage, message: l.message, details: json(l.details) })),
  };
  return redact(report);
}

export function articleReportFilename(task: { id: string; slug?: string | null; keyword: string }): string {
  const base = (task.slug || task.keyword || task.id)
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `article-report-${base || task.id}.json`;
}
