import { db } from '@/lib/db';
import { parseJson, stringArray } from '@/lib/json';
import { NeedsReviewError } from '@/lib/pipeline-errors';
import { assembleArticle, firstParagraphText, type AssemblyImage } from '@/lib/content/assembly';
import { makeSlug, sentences, truncateAtWord } from '@/lib/content/text';
import { runSeoChecks } from '@/lib/seo/checks';
import { parseSeoBrief } from '@/lib/seo/intent';
import { evaluateQuality, type QualityFinding } from '@/lib/quality/gate';
import { latestQualityReport, saveQualityReport, type QualitySections } from '@/lib/quality/report';
import { runDuplicateCheck } from '@/lib/duplicates/service';
import { evaluateArticleEvidence } from '@/lib/research/ledger';
import { baseVariables } from '@/lib/prompts/variables';
import { recordMetric } from '@/lib/metrics';
import { isNearDuplicate } from '@/lib/campaigns/dedupe';
import { deletedPostKeys } from '@/lib/tasks/deleted-posts';
import { STOPWORDS } from '@/lib/plagiarism/text';
import type { TemplateVars } from '@/lib/prompts/template';
import type { StageManifest } from '@/modules/types';
import type { PipelineContext, PipelineStage, StageResult } from '../pipeline/types';

export const waiting = (message: string): StageResult => ({ outcome: 'waiting', message });

export function bind(manifest: StageManifest, impl: Pick<PipelineStage, 'run'> & Partial<Pick<PipelineStage, 'shouldRun'>>): PipelineStage {
  return { ...manifest, ...impl };
}

export function stageFrom(stages: StageManifest[], key: string): StageManifest {
  const s = stages.find((x) => x.key === key);
  if (!s) throw new Error(`Unknown stage ${key}`);
  return s;
}

/** Variables shared by every prompt of a task. */
export async function taskVariables(ctx: PipelineContext, extra: TemplateVars = {}): Promise<TemplateVars> {
  return { ...syncTaskVariables(ctx), ...extra };
}

export function syncTaskVariables(ctx: PipelineContext): TemplateVars {
  const t = ctx.task;
  return baseVariables({
    moduleKey: t.moduleKey,
    keyword: t.keyword,
    secondaryKeywords: stringArray(t.secondaryKeywords),
    exampleTitle: t.exampleTitle,
    language: t.language,
    country: t.targetCountry,
    categories: [],
    config: ctx.config,
    selectedTitle: t.selectedTitle,
  });
}

// ---------------- shared stages ----------------

export function precheck(manifest: StageManifest): PipelineStage {
  return bind(manifest, {
    run: async (ctx) => {
      const site = await db.website.findUniqueOrThrow({ where: { id: ctx.task.websiteId }, include: { categories: true } });
      const problems: string[] = [];
      if (!site.active) problems.push(`${site.name} is inactive.`);
      if (ctx.task.categoryId && !site.categories.some((c) => c.id === ctx.task.categoryId)) problems.push('The chosen category no longer exists on this website (re-sync categories and choose again).');
      if (ctx.task.moduleKey === 'celebrity-writer' && !ctx.task.categoryId) problems.push('A category is required for the Celebrity Article Writer.');
      if (!['en', 'de'].includes(ctx.task.language)) problems.push(`Unsupported language ${ctx.task.language}.`);
      if (problems.length) throw new NeedsReviewError(problems.join(' '), problems, 'Fix the website/category, then Retry.');
      return { outcome: 'completed', data: { website: site.name, category: ctx.task.categoryName, language: ctx.task.language, country: ctx.task.targetCountry }, message: 'Inputs valid' };
    },
  });
}

const contentWords = (s: string) => [...new Set(s.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((w) => w.length > 2 && !STOPWORDS.has(w));

export function duplicatePrecheck(manifest: StageManifest): PipelineStage {
  return bind(manifest, {
    run: async (ctx) => {
      const others = await db.articleTask.findMany({
        where: { normalizedKeyword: ctx.task.normalizedKeyword, id: { not: ctx.task.id }, status: { notIn: ['CANCELLED', 'FAILED'] } },
        select: { id: true, websiteId: true, status: true, keyword: true, wpEditUrl: true, website: { select: { name: true } } },
        take: 20,
      });
      const sameSite = others.filter((o) => o.websiteId === ctx.task.websiteId);
      const crossSite = others.filter((o) => o.websiteId !== ctx.task.websiteId);
      // Near-duplicates on this website (word order, plurals, small typos; different numbers stay different).
      const siteTasks = await db.articleTask.findMany({ where: { websiteId: ctx.task.websiteId, id: { not: ctx.task.id }, normalizedKeyword: { not: ctx.task.normalizedKeyword }, status: { notIn: ['CANCELLED', 'FAILED'] } }, select: { id: true, keyword: true, status: true }, orderBy: { createdAt: 'desc' }, take: 2000 });
      const near = siteTasks.filter((o) => isNearDuplicate(o.keyword, ctx.task.keyword));
      // Posts already published on this website whose title covers every content word of the keyword.
      const words = contentWords(ctx.task.keyword);
      // Posts of articles you deleted here do not count (owner request: a deleted article can be written again).
      const deleted = await deletedPostKeys();
      const published = words.length >= 2 ? (await db.linkTarget.findMany({ where: { websiteId: ctx.task.websiteId, status: 'ACTIVE' }, select: { wpPostId: true, title: true, url: true }, take: 5000 })).filter((p) => { const tw = new Set(contentWords(p.title)); return !deleted.has(`${ctx.task.websiteId}:${p.wpPostId}`) && words.every((w) => tw.has(w)); }) : [];
      const options = parseJson<Record<string, unknown>>(ctx.task.options, {});
      if ((sameSite.length || near.length) && options.allowDuplicate !== true) {
        const hits = [...sameSite.map((s) => ({ id: s.id, keyword: ctx.task.keyword, status: s.status })), ...near];
        throw new NeedsReviewError(
          sameSite.length ? `“${ctx.task.keyword}” already has ${sameSite.length} article(s) on this website (${sameSite.map((s) => s.status.toLowerCase()).join(', ')}).` : `“${ctx.task.keyword}” is very similar to “${near[0].keyword}”, which already has an article on this website.`,
          hits.slice(0, 5).map((h) => `Possible duplicate on this website: “${h.keyword}” (${h.status.toLowerCase()}), task ${h.id}.`),
          'If this is an intentional new version, use “Allow duplicate and continue”. Otherwise cancel this task.',
        );
      }
      const warnings = published.slice(0, 3).map((p) => `A published post on this website already covers “${ctx.task.keyword}”: “${p.title}” (${p.url}). Make sure the new article has a different angle.`);
      return {
        outcome: 'completed',
        data: { sameSite: sameSite.map((s) => s.id), near: near.map((n) => n.id), crossSite: crossSite.map((s) => ({ id: s.id, website: s.website.name })), publishedPosts: published.slice(0, 10), warnings },
        message: [crossSite.length ? `Same keyword exists on ${crossSite.length} other website(s); wording is compared at the quality gate.` : '', published.length ? `${published.length} published post(s) on this website cover the keyword.` : ''].filter(Boolean).join(' ') || 'No duplicate keyword found',
      };
    },
  });
}

/** Placeholder for a stage whose implementation arrives in a later milestone: SKIPPED with an honest reason. */
export function notAvailableYet(manifest: StageManifest, reason: string): PipelineStage {
  return bind(manifest, { run: async () => ({ outcome: 'skipped', reason }) });
}

export function bodyForAssembly(ctx: PipelineContext): string {
  const humanized = ctx.stages.get('HUMANIZE');
  if (humanized?.status === 'COMPLETED' && humanized.outputHtml) return humanized.outputHtml;
  const linked = ctx.stages.get('EXTERNAL_LINKS');
  if (linked?.status === 'COMPLETED' && linked.outputHtml) return linked.outputHtml;
  return ctx.task.bodyHtml ?? '';
}

/** Assemble the article for this task (shared by the ASSEMBLY stage and Rank Math content corrections). */
export async function assembleForTask(ctx: PipelineContext, bodyHtml: string) {
  const internal = ctx.stageJson<{ line: string | null; url: string | null; title: string | null; contextual?: { anchor: string; url: string }[] } | null>('INTERNAL_LINKS');
  // Contextual internal links chosen by INTERNAL_LINKS, placed on the final body (after any humanizer edits).
  if (internal?.contextual?.length) {
    const { placeLinks } = await import('@/lib/links/place');
    bodyHtml = placeLinks(bodyHtml, internal.contextual.map((c) => ({ anchor: c.anchor, url: c.url, kind: 'int' as const })), { keyword: ctx.task.focusKeyword ?? ctx.task.keyword }).html;
  }
  const images = (ctx.stageJson<{ slots?: { slot: string; html?: string }[] }>('IMAGES')?.slots ?? []).filter((x): x is AssemblyImage => (x.slot === 'BODY1' || x.slot === 'BODY2') && Boolean(x.html));
  const quickBio = parseJson<{ attribute: string; details: string }[]>(ctx.task.quickBio, []);
  const { confirmedFullName } = await import('@/modules/celebrity-writer/parsers');
  const { getSettings } = await import('@/lib/settings');
  const settings = await getSettings();
  return assembleArticle({
    boldLinks: settings.content.boldLinks,
    title: ctx.task.selectedTitle ?? ctx.task.seoTitle,
    bodyHtml,
    language: ctx.task.language,
    moduleKey: ctx.task.moduleKey,
    quickBioHtml: ctx.task.quickBioHtml,
    quickBioName: confirmedFullName(quickBio),
    faqs: parseJson(ctx.task.faqs, []),
    internalLink: internal && internal.url && internal.line ? { line: internal.line, url: internal.url, title: internal.title ?? internal.url } : null,
    images,
  });
}

export function assembly(manifest: StageManifest): PipelineStage {
  return bind(manifest, {
    run: async (ctx) => {
      const result = await assembleForTask(ctx, bodyForAssembly(ctx));
      // Celebrity metadata (Tigram sets its own from the ARTICLE lines).
      const updates: Record<string, unknown> = { assembledHtml: result.html };
      if (ctx.task.moduleKey === 'celebrity-writer') {
        const title = ctx.task.selectedTitle ?? ctx.task.recommendedTitle ?? ctx.task.keyword;
        updates.seoTitle = ctx.task.seoTitle ?? title;
        updates.metaDescription = ctx.task.metaDescription ?? metaFromIntro(result.html, ctx.task.keyword, ctx.task.language);
        updates.slug = ctx.task.slug ?? makeSlug(ctx.task.keyword, ctx.task.language);
        updates.focusKeyword = ctx.task.keyword;
        if (stringArray(ctx.task.tags).length === 0) updates.tags = JSON.stringify([ctx.task.keyword, ...stringArray(ctx.task.secondaryKeywords)].slice(0, 6));
      } else if (!ctx.task.focusKeyword) {
        updates.focusKeyword = ctx.task.keyword;
        if (stringArray(ctx.task.tags).length === 0) updates.tags = JSON.stringify([ctx.task.keyword, ...stringArray(ctx.task.secondaryKeywords)].slice(0, 6));
      }
      await ctx.updateTask(updates);
      return { outcome: 'completed', outputHtml: result.html, data: { warnings: result.warnings, structure: result.structure }, message: result.warnings.length ? `${result.warnings.length} assembly note(s)` : 'Assembled' };
    },
  });
}

/** Meta description from the introduction: prefer a sentence containing the keyword; never invent. */
export function metaFromIntro(html: string, keyword: string, language: string): string {
  const intro = firstParagraphText(html);
  const sents = sentences(intro);
  const kw = keyword.toLowerCase();
  const withKw = sents.find((s) => s.toLowerCase().includes(kw));
  let meta = withKw ?? sents[0] ?? intro;
  if (meta.length < 110 && sents.length > 1) meta = sents.slice(0, 2).join(' ');
  const max = language === 'de' ? 158 : 156;
  return endAtBoundary(meta, max, language === 'de' ? 110 : 120);
}

/**
 * Shortened to `max` at a sentence end, else at a clause (“, ” → “.”), else at a word with “…” — never a half
 * phrase like “… spent more” (owner report).
 */
export function endAtBoundary(text: string, max: number, min: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max + 1);
  const ends = [...head.matchAll(/[.!?](?=\s)/g)].map((m) => m.index! + 1).filter((i) => i >= min && i <= max);
  if (ends.length) return text.slice(0, ends[ends.length - 1]).trim();
  const clauses = [...head.matchAll(/[,;:–—](?=\s)/g)].map((m) => m.index!).filter((i) => i >= min && i < max);
  if (clauses.length) return `${text.slice(0, clauses[clauses.length - 1]).trim()}.`;
  return `${truncateAtWord(text, max - 1)}…`;
}

export function articleHtml(ctx: PipelineContext): string {
  return ctx.task.editedHtml ?? ctx.task.assembledHtml ?? '';
}

/** Local SEO report for the task's current metadata and the given article HTML. */
export function seoReportFor(ctx: PipelineContext, html: string) {
  const t = ctx.task;
  const range = ctx.config.tigramWordRange.split(/\s*[-–]\s*/).map(Number) as [number, number];
  return runSeoChecks({
    html,
    moduleKey: t.moduleKey,
    language: t.language,
    keyword: t.focusKeyword ?? t.keyword,
    title: t.selectedTitle,
    seoTitle: t.seoTitle,
    metaDescription: t.metaDescription,
    slug: t.slug,
    categoryName: t.categoryName,
    tags: stringArray(t.tags),
    expectedFaqCount: t.moduleKey === 'tigram-writer' ? ctx.config.tigramFaqCount : ctx.config.faqCount,
    quickBioRows: ctx.config.quickBioRows,
    maxWords: ctx.config.maxWords,
    wordRange: t.moduleKey === 'tigram-writer' && range.length === 2 && range.every(Number.isFinite) ? range : null,
    minKeywordOccurrences: ctx.config.minKeywordOccurrences,
    maxKeywordOccurrences: ctx.config.maxKeywordOccurrences,
    densityCeilingPct: ctx.config.keywordDensityCeilingPct,
    externalLinksEnabled: ctx.config.externalLinks,
    internalLinksEnabled: ctx.config.internalLinks,
    imagesExpected: ctx.config.images && ctx.config.imagesRequired,
    brief: parseSeoBrief(t.seoBrief),
  });
}

export function seoCheck(manifest: StageManifest): PipelineStage {
  return bind(manifest, {
    run: async (ctx) => {
      const t = ctx.task;
      const report = seoReportFor(ctx, articleHtml(ctx));
      await db.sEOReport.create({ data: { taskId: t.id, source: 'INTERNAL', score: report.score, checks: JSON.stringify(report.checks), metrics: JSON.stringify(report.metrics) } });
      const metrics = parseJson<Record<string, unknown>>(t.metrics, {});
      await ctx.updateTask({ seoScore: report.score, metrics: JSON.stringify({ ...metrics, seo: report.metrics }) });
      return { outcome: 'completed', data: report, message: `SEO readiness ${report.score}/100` };
    },
  });
}

export function qualityGate(manifest: StageManifest): PipelineStage {
  return bind(manifest, {
    run: async (ctx) => {
      const t = ctx.task;
      const seo = ctx.stageJson<ReturnType<typeof runSeoChecks>>('SEO_CHECK');
      if (!seo) throw new NeedsReviewError('SEO report missing; rerun the SEO check.', ['SEO report missing'], 'Regenerate from SEO check.');
      const site = await db.website.findUniqueOrThrow({ where: { id: t.websiteId }, include: { categories: true } });
      const categoryValid = Boolean(t.categoryId && site.categories.some((c) => c.id === t.categoryId));
      const assemblyNotes = ctx.stageJson<{ warnings: string[] }>('ASSEMBLY')?.warnings ?? [];
      const extraWarnings: string[] = [];
      for (const key of ['DUPLICATE_PRECHECK', 'EXTERNAL_LINKS', 'INTERNAL_LINKS', 'IMAGES', 'HUMANIZE', 'RESEARCH_EVIDENCE', 'QUICK_BIO', 'FAQS']) {
        const w = ctx.stageJson<{ warnings?: string[] }>(key)?.warnings ?? [];
        extraWarnings.push(...w.map((x) => `${key}: ${x}`));
      }
      const result = evaluateQuality({
        html: articleHtml(ctx),
        moduleKey: t.moduleKey,
        language: t.language,
        keyword: t.keyword,
        seo,
        reviewThreshold: ctx.config.reviewThreshold,
        densityCeilingPct: ctx.config.keywordDensityCeilingPct,
        expectedFaqCount: t.moduleKey === 'tigram-writer' ? ctx.config.tigramFaqCount : ctx.config.faqCount,
        categoryValid,
        assemblyWarnings: assemblyNotes,
        imagesRequired: ctx.config.images && ctx.config.imagesRequired,
        imagesPresent: seo.metrics.images,
        extraWarnings,
      });
      // Duplicate Content Detector: wording overlap with every saved article on all websites.
      const dup = await runDuplicateCheck(t.id, articleHtml(ctx), ctx.config.duplicateSimilarityReview);
      const top = dup.comparisons[0];
      const dupFinding = (code: string): QualityFinding => ({
        code,
        message: `${Math.round((top?.wordingShare ?? 0) * 100)} % of the wording (longest identical run ${top?.longestRun ?? 0} words, ${top?.exactParagraphs ?? 0} identical paragraph(s)) repeats “${top?.otherTitle}” on ${top?.otherWebsite}. See Duplicate Review.`,
        source: 'DUPLICATES',
      });
      // Research evidence: contradicted / unsupported high-impact claims in the article, and leaked research notes.
      const ev = await evaluateArticleEvidence(t.id, articleHtml(ctx));
      for (const h of ev.hardStops) result.hardStops.push({ code: 'RESEARCH_LEAK', message: h, source: 'ASSEMBLY' });
      for (const w of ev.warnings) result.warnings.push({ code: 'EVIDENCE', message: w, source: 'RESEARCH_EVIDENCE' });
      if (dup.highest === 'HIGH' && !dup.overridden) result.hardStops.push(dupFinding('DUPLICATE_WORDING'));
      else if (dup.highest === 'MEDIUM' && !dup.overridden) result.warnings.push(dupFinding('DUPLICATE_SIMILAR'));
      result.passed = result.hardStops.length === 0;
      const options = parseJson<Record<string, unknown>>(t.options, {});
      const override = options.qualityOverride === true;
      const reasons = [...result.hardStops, ...result.warnings].map((f) => `${f.message} [${f.source}]`);
      await ctx.updateTask({ reviewReasons: JSON.stringify(reasons) });
      const research = ctx.stageJson<{ sources?: unknown[]; uncertain?: unknown[]; warnings?: string[] }>('RESEARCH_EVIDENCE');
      const sections: QualitySections = {
        seo: { score: seo.score, threshold: ctx.config.reviewThreshold, failed: seo.checks.filter((c) => !c.passed).map((c) => c.label) },
        structure: { words: seo.metrics.words, faqCount: seo.metrics.faqCount, expectedFaqCount: t.moduleKey === 'tigram-writer' ? ctx.config.tigramFaqCount : ctx.config.faqCount, quickBioRows: seo.metrics.quickBioRows, quickBioColumnsOk: seo.metrics.quickBioColumnsOk, emptyHeadings: seo.metrics.emptyHeadings, duplicateSentences: seo.metrics.duplicateSentences },
        evidence: research ? { sources: research.sources?.length ?? 0, uncertain: research.uncertain?.length ?? 0, warnings: research.warnings ?? [], claims: ev.summary.claims, verified: ev.summary.verified, contradicted: ev.summary.contradicted, unsupportedInArticle: ev.summary.unsupportedInArticle } : null,
        duplicates: { highest: dup.highest, overridden: dup.overridden, overrideReason: dup.overrideReason, compared: dup.compared, matches: dup.comparisons.filter((c) => c.severity !== 'LOW').slice(0, 5).map((c) => ({ otherTaskId: c.otherTaskId, title: c.otherTitle, website: c.otherWebsite, severity: c.severity, wordingShare: c.wordingShare, longestRun: c.longestRun, factWords: c.factWords })) },
        links: { external: seo.metrics.externalLinks, internalLinkLine: Boolean(seo.metrics.internalLinkLine) },
        images: { count: seo.metrics.images, withAlt: seo.metrics.imagesWithAlt, required: ctx.config.images && ctx.config.imagesRequired },
      };
      await saveQualityReport(t.id, 'QUALITY_GATE', { hardStops: result.hardStops, warnings: result.warnings, sections, overridden: override });
      // Review system off (owner decision, default): a hard stop does not hold the article. The draft is saved with
      // the problems as notes, and a workflow never publishes it automatically (see the workflow scheduler).
      if (!result.passed && !override && !ctx.config.holdForReview) {
        const blocked = result.hardStops.map((h) => h.message);
        await ctx.updateTask({ options: JSON.stringify({ ...options, publishBlocked: blocked }) });
        return { outcome: 'completed', data: { ...result, override, publishBlocked: blocked, duplicates: sections.duplicates }, message: `${blocked.length} serious problem(s) noted — saved as a draft only, never published automatically` };
      }
      if (options.publishBlocked) await ctx.updateTask({ options: JSON.stringify({ ...options, publishBlocked: undefined }) });
      if (!result.passed && !override) {
        throw new NeedsReviewError(
          `Quality gate stopped before WordPress: ${result.hardStops.map((h) => h.message).join(' ')}`,
          reasons,
          'Fix the listed items (edit, or regenerate the named stage), then Retry. Or use “Approve despite review reasons”.',
        );
      }
      return { outcome: 'completed', data: { ...result, override, duplicates: sections.duplicates }, message: result.passed ? (result.warnings.length ? (ctx.config.holdForReview ? `${result.warnings.length} warning(s) — draft will be flagged for review` : `${result.warnings.length} note(s) for the article page`) : 'All quality checks passed') : 'Hard stops overridden by the owner' };
    },
  });
}

export function articleApproval(manifest: StageManifest): PipelineStage {
  return bind(manifest, {
    run: async (ctx) => {
      if (ctx.config.manualArticleApproval && !ctx.task.articleApprovedAt) {
        return { outcome: 'paused', status: 'AWAITING_ARTICLE_APPROVAL', message: 'Waiting for your article approval.', nextAction: 'Open the Editor tab, review/edit the article, then click “Approve article”.' };
      }
      return { outcome: 'completed', message: ctx.task.articleApprovedAt ? 'Approved by the owner' : 'Automatic approval (manual approval is off)' };
    },
  });
}

/** Final status. COMPLETED only with a verified WordPress draft and no open review reasons. */
export async function finalizeTask(ctx: PipelineContext): Promise<void> {
  const t = await db.articleTask.findUniqueOrThrow({ where: { id: ctx.taskId } });
  const reasons = parseJson<string[]>(t.reviewReasons, []);
  const options = parseJson<Record<string, unknown>>(t.options, {});
  const responses = await db.chatGPTResponse.count({ where: { taskId: t.id, status: { in: ['COMPLETED', 'FAILED', 'SUPERSEDED', 'REJECTED'] } } });
  const metrics = { ...parseJson<Record<string, unknown>>(t.metrics, {}), chatgptInteractions: responses };
  const wpStage = await db.articleStage.findUnique({ where: { taskId_key: { taskId: t.id, key: 'WORDPRESS_DRAFT' } } });
  const finalCheck = await db.articleStage.findUnique({ where: { taskId_key: { taskId: t.id, key: 'VERIFIED_COMPLETE' } } });
  // A draft counts only after the final read-back verification passed.
  const verifiedDraft = Boolean(t.wpPostId && t.wpDraftAt && t.wpVerifiedAt && finalCheck?.status === 'COMPLETED' && parseJson<{ verified?: boolean }>(finalCheck.outputJson, {}).verified === true);
  let status: string;
  let message: string;
  let nextAction: string | null = null;
  if (!verifiedDraft) {
    status = 'NEEDS_REVIEW';
    if (!ctx.config.saveToWordPress) {
      message = 'Article is ready locally. Saving to WordPress was turned off for this task.';
      reasons.push('WordPress draft not created (turned off for this task).');
      nextAction = 'Copy the article from the Editor tab, or enable WordPress saving and Retry from the WordPress draft stage.';
    } else {
      message = wpStage?.status === 'SKIPPED' ? `Article is ready locally. ${wpStage.message ?? 'The WordPress draft step did not run.'}` : 'Article is ready locally, but no verified WordPress draft exists.';
      reasons.push(wpStage?.message ?? 'No verified WordPress draft.');
      nextAction = t.wpPostId ? `Open draft #${t.wpPostId} to check it, then Retry the WordPress steps.` : 'Log in to the website if needed, then Retry to create the WordPress draft.';
    }
  } else if (reasons.length && options.qualityOverride !== true && ctx.config.holdForReview) {
    status = 'NEEDS_REVIEW';
    message = `WordPress draft #${t.wpPostId} saved; ${reasons.length} review reason(s) remain.`;
    nextAction = reasons.every((r) => /^Rank Math is not active/.test(r))
      ? 'Activate Rank Math on this website (or set its Rank Math option to “Use when installed”), then use WordPress → Save again.'
      : 'Review the reasons and the draft. Use “Approve despite review reasons” if acceptable.';
  } else {
    status = 'COMPLETED';
    // Without “Hold articles for review” the reasons are notes on the article page (owner decision).
    const blocked = Array.isArray(options.publishBlocked) && options.publishBlocked.length > 0;
    message = `Verified WordPress draft #${t.wpPostId}.${reasons.length && options.qualityOverride !== true ? ` ${reasons.length} note(s) on the article page.` : ''}${blocked ? ' Not published automatically: a serious problem is noted.' : ''}`;
  }
  const now = new Date();
  await db.articleTask.update({
    where: { id: t.id },
    data: {
      status,
      message,
      nextAction,
      percent: 100,
      reviewReasons: JSON.stringify(Array.from(new Set(reasons))),
      metrics: JSON.stringify(metrics),
      ...(status === 'COMPLETED' && !t.verifiedCompleteAt ? { verifiedCompleteAt: now } : {}),
    },
  });
  // Final quality report: the gate's findings plus what WordPress and Rank Math confirmed (read back, never computed).
  const gate = await latestQualityReport(t.id);
  if (gate) {
    const rm = parseJson<{ mode?: string; active?: boolean | null; score?: number | null; scoreVia?: string | null; fieldsVerified?: boolean | null } | null>((await db.articleStage.findUnique({ where: { taskId_key: { taskId: t.id, key: 'RANKMATH' } } }))?.outputJson, null);
    const known = new Set([...gate.hardStops, ...gate.warnings].map((f) => `${f.message} [${f.source}]`));
    const finalWarnings = Array.from(new Set(reasons)).filter((r) => !known.has(r)).map((r) => ({ code: 'FINAL', message: r, source: 'FINALIZE' }));
    await saveQualityReport(t.id, 'VERIFIED_COMPLETE', {
      hardStops: gate.hardStops,
      warnings: [...gate.warnings, ...finalWarnings],
      overridden: options.qualityOverride === true,
      sections: {
        ...gate.sections,
        rankMath: rm ? { mode: rm.mode ?? 'unknown', active: rm.active ?? null, score: rm.score ?? null, scoreVia: rm.scoreVia ?? null, fieldsVerified: rm.fieldsVerified ?? null } : null,
        wordpress: { postId: t.wpPostId, verified: verifiedDraft, status: t.wpPostStatus },
      },
    });
  }
  if (status === 'COMPLETED' && !t.verifiedCompleteAt) {
    await recordMetric({
      kind: 'ARTICLE_VERIFIED',
      taskId: t.id,
      moduleKey: t.moduleKey,
      websiteId: t.websiteId,
      outcome: 'COMPLETED',
      startedAt: t.startedAt ?? t.createdAt,
      endedAt: now,
      details: { wpPostId: t.wpPostId, wpEditUrl: t.wpEditUrl, chatgptInteractions: responses },
      dedupeKey: `verified:${t.id}`,
    });
  }
}
