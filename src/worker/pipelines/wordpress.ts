import type { BrowserContext } from 'playwright';
import type { Website } from '@prisma/client';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { parseJson, stringArray } from '@/lib/json';
import { LoginRequiredError, NeedsReviewError } from '@/lib/pipeline-errors';
import { cleanModelMarkdown, markdownToHtml } from '@/lib/content/markdown';
import { htmlToMarkdown } from '@/lib/content/html-to-markdown';
import { makeSlug, normalizeText, wordCount, stripTags } from '@/lib/content/text';
import { evaluateCorrection, markRichText, MARKS_NOTE, restoreRichText, type MarkedLink } from '@/lib/seo/correction';
import { evaluateQuality } from '@/lib/quality/gate';
import type { StageManifest } from '@/modules/types';
import { firstPage, withSiteContext, withWordPressSlot } from '@/wordpress/browser';
import { siteRef } from '@/wordpress/session';
import { WpApiError, WpClient } from '@/wordpress/client';
import { contentHash, editorContent, mapApiError, NO_PERMISSION_REASON, RemoteEditedError, saveDraft, sameArticle, type DraftInput, type EditorKind } from '@/wordpress/drafts';
import { inspectInEditor, type EditorInspection } from '@/wordpress/editor';
import { prepareArticleMedia, uploadAssetWithRetry, type UploadHow } from '@/wordpress/media';
import { observe } from '@/lib/site-health';
import { fieldsMatch, LOCAL_FIXABLE, type LocalFixId, type RankMathRecommendation } from '@/wordpress/rank-math';
import type { PipelineContext, PipelineStage, StageResult } from '../pipeline/types';
import { articleHtml, assembleForTask, bind, bodyForAssembly, metaFromIntro, seoReportFor, waiting } from './common';

/**
 * WORDPRESS_DRAFT → RANKMATH → VERIFIED_COMPLETE. Each stage reopens the same
 * draft (stored post ID); none of them can publish (see publish-guard.ts).
 */

async function withWordPress<T>(site: Website, purpose: string, fn: (context: BrowserContext) => Promise<T>): Promise<T> {
  const settings = await getSettings();
  // Known logged-out profile: pause without opening a browser. The task resumes when the owner logs in.
  const profile = site.wordpressProfileId ? await db.browserProfile.findUnique({ where: { id: site.wordpressProfileId } }) : null;
  if (!profile || profile.sessionState === 'LOGIN_REQUIRED') {
    throw new LoginRequiredError('wordpress', `${site.name}: not logged in to WordPress. Use “Log in” on the website page.`, site.id);
  }
  try {
    return await withWordPressSlot(settings.workflow.wordpressConcurrency, () =>
      withSiteContext(siteRef(site), { headed: settings.browser.mode === 'headed', purpose }, fn),
    );
  } catch (error) {
    if (error instanceof LoginRequiredError && site.wordpressProfileId) {
      await db.browserProfile.update({ where: { id: site.wordpressProfileId }, data: { sessionState: 'LOGIN_REQUIRED', lastCheckedAt: new Date() } }).catch(() => {});
    }
    throw error;
  }
}

async function freshSite(ctx: PipelineContext): Promise<Website> {
  return db.website.findUniqueOrThrow({ where: { id: ctx.task.websiteId } });
}

function knownEditor(site: Website): EditorKind {
  if (site.editorType === 'CLASSIC' || site.editorType === 'GUTENBERG') return site.editorType;
  return site.detectedEditor === 'CLASSIC' ? 'CLASSIC' : 'GUTENBERG';
}

function postTitle(ctx: PipelineContext): string {
  const t = ctx.task;
  return (t.selectedTitle ?? t.seoTitle ?? t.recommendedTitle ?? t.keyword).trim();
}

type WpOptions = { wpOverwriteRemoteEdits?: boolean; wpAdoptPostId?: number; wpRecreate?: boolean };

function draftInput(ctx: PipelineContext, site: Website, html: string, editor: EditorKind, featuredMediaId: number | null): DraftInput {
  const t = ctx.task;
  const options = parseJson<WpOptions>(t.options, {});
  return {
    title: postTitle(ctx),
    html,
    slug: t.slug,
    categoryExternalId: t.categoryExternalId,
    tagNames: stringArray(t.tags),
    featuredMediaId,
    editor,
    existing: { wpPostId: t.wpPostId, wpCreateMarker: t.wpCreateMarker, wpModifiedGmt: t.wpModifiedGmt, wpContentHash: t.wpContentHash },
    options: {
      createMissingTags: ctx.config.createMissingTags,
      overwriteRemoteEdits: options.wpOverwriteRemoteEdits === true,
      adoptPostId: options.wpAdoptPostId ?? null,
      recreate: options.wpRecreate === true,
    },
  };
}

/** Featured image (from the image stage, M8): uploaded once per site, reused on retries, never uploaded twice. */
async function featuredMedia(client: WpClient, ctx: PipelineContext): Promise<{ id: number; how: UploadHow } | null> {
  const asset = await db.mediaAsset.findFirst({ where: { taskId: ctx.taskId, role: 'FEATURED', status: { in: ['READY', 'UPLOADED'] } }, orderBy: { createdAt: 'desc' } });
  if (!asset) return null;
  const r = await uploadAssetWithRetry(client, asset, { altText: asset.altText, title: ctx.task.selectedTitle });
  return { id: r.id, how: r.how };
}

/** Keep the WordPress version of a draft edited there, for the owner's comparison (WordPress tab). */
async function rememberRemoteEdit(ctx: PipelineContext, error: unknown) {
  if (error instanceof RemoteEditedError) await ctx.setPrivateState({ remoteEdit: { ...error.remote, capturedAt: new Date().toISOString() } });
}

async function clearWpOptions(ctx: PipelineContext) {
  const options = parseJson<Record<string, unknown>>(ctx.task.options, {});
  if (!('wpOverwriteRemoteEdits' in options || 'wpAdoptPostId' in options || 'wpRecreate' in options)) return;
  delete options.wpOverwriteRemoteEdits;
  delete options.wpAdoptPostId;
  delete options.wpRecreate;
  await ctx.updateTask({ options: JSON.stringify(options) });
}

// ------------------------------------------------------------- WORDPRESS_DRAFT

export function wordpressDraft(manifest: StageManifest): PipelineStage {
  return bind(manifest, {
    shouldRun: (ctx) => ctx.config.saveToWordPress,
    run: async (ctx) => {
      const site = await freshSite(ctx);
      const html = articleHtml(ctx);
      if (!html.trim()) throw new NeedsReviewError('There is no assembled article to save.', ['Article missing'], 'Regenerate from Assembly, then Retry.');
      const settings = await getSettings();
      const timeoutMs = settings.browser.navigationTimeoutSec * 1000;
      await ctx.progress(ctx.task.wpPostId ? `Reopening WordPress draft #${ctx.task.wpPostId}…` : 'Saving the WordPress draft…');
      let mediaWarnings: string[] = [];
      const started = Date.now();
      let mediaCounts = { uploaded: 0, reused: 0, adopted: 0, failed: 0 };
      let outcome: Awaited<ReturnType<typeof saveDraft>>;
      try {
        outcome = await withWordPress(site, 'draft', async (context) => {
          const client = await WpClient.connect(context, siteRef(site), { timeoutMs, taskId: ctx.taskId });
          const media = await prepareArticleMedia(client, html, ctx.taskId);
          mediaWarnings = media.warnings;
          mediaCounts = { uploaded: media.uploaded, reused: media.reused, adopted: media.adopted, failed: media.failed };
          let featured: Awaited<ReturnType<typeof featuredMedia>> = null;
          try {
            featured = await featuredMedia(client, ctx);
            if (featured) mediaCounts[featured.how]++;
          } catch (error) {
            if (error instanceof LoginRequiredError) throw error;
            // Like body images: the draft is saved without it (the owner sees why).
            mediaCounts.failed++;
            mediaWarnings.push(`The featured image could not be uploaded (${(error as Error).message}); the draft was saved without it.`);
          }
          const input = draftInput(ctx, site, media.html, knownEditor(site), featured?.id ?? null);
          input.options.timeoutMs = Math.max(timeoutMs, 90_000);
          return saveDraft(client, input, async (data) => {
            await ctx.updateTask(data);
          });
        });
      } catch (error) {
        await rememberRemoteEdit(ctx, error);
        const message = (error as Error).message;
        await observe(site.id, 'DRAFT_SAVE', 'FAIL', message, { durationMs: Date.now() - started, taskId: ctx.taskId });
        if (error instanceof LoginRequiredError) await observe(site.id, 'SESSION', 'FAIL', `Session expired during a draft save: ${message}`, { taskId: ctx.taskId });
        const noPermission =
          (error instanceof WpApiError && (error.status === 403 || error.code === 'rest_cannot_create' || error.code === 'rest_cannot_edit')) || (error instanceof NeedsReviewError && error.reasons.includes(NO_PERMISSION_REASON));
        if (noPermission) {
          await observe(site.id, 'PERMISSIONS', 'FAIL', 'WordPress refused the signed-in account: it may not create or edit posts.', { taskId: ctx.taskId });
          if (error instanceof WpApiError) throw mapApiError(error);
        }
        throw error;
      }
      const touched = mediaCounts.uploaded + mediaCounts.adopted + mediaCounts.failed;
      if (touched) {
        await observe(site.id, 'MEDIA_UPLOAD', mediaCounts.failed ? 'FAIL' : 'OK', `${mediaCounts.uploaded} uploaded, ${mediaCounts.adopted} found from an interrupted upload, ${mediaCounts.reused} reused, ${mediaCounts.failed} failed`, { taskId: ctx.taskId, details: mediaCounts });
      }
      if (ctx.privateState<{ remoteEdit?: unknown }>().remoteEdit) await ctx.setPrivateState({ remoteEdit: null });
      await observe(site.id, 'DRAFT_SAVE', 'OK', `Draft #${outcome.postId} ${outcome.action}`, { durationMs: Date.now() - started, taskId: ctx.taskId, details: { postId: outcome.postId, action: outcome.action } });
      await clearWpOptions(ctx);
      await ctx.log(`WordPress draft #${outcome.postId} ${outcome.action}; verified status “${outcome.status}”.`, 'info', { warnings: outcome.warnings });
      return {
        outcome: 'completed',
        data: { ...outcome, editor: knownEditor(site), media: mediaCounts, warnings: [...outcome.warnings, ...mediaWarnings] },
        message: `Draft #${outcome.postId} ${outcome.action === 'unchanged' ? 'already up to date' : outcome.action}`,
      };
    },
  });
}

// ------------------------------------------------------------------- RANKMATH

export interface RankMathRound {
  round: number;
  kind: 'local' | 'content';
  scoreBefore: number | null;
  scoreAfter?: number | null;
  changes: string[];
  accepted: boolean;
  reasons?: string[];
  before?: string;
  after?: string;
}

export interface RankMathReport {
  mode: string;
  active: boolean;
  target: number;
  score: number | null;
  scoreText: string | null;
  scoreVia: string | null;
  fields: { focusKeyword: string | null; title: string | null; description: string | null } | null;
  fieldsVerified: boolean;
  fieldProblems: string[];
  recommendations: RankMathRecommendation[];
  rounds: RankMathRound[];
  editor: string | null;
  invalidBlocksFixed: number;
  editorSave: string | null;
  notes: string[];
  checkedAt: string;
}

interface RankMathState extends Record<string, unknown> {
  rounds?: RankMathRound[];
  correction?: { round: number; scoreBefore: number | null; vars: Record<string, string>; bodyHash: string; links?: MarkedLink[] } | null;
  contentStopped?: string | null;
}

const CONTENT_FIXABLE = /(beginning of (your )?content|anfang (deines|des|ihres) (inhalts|textes)|subheading|zwischenüberschrift|keyword density|keyword-?dichte|content is \d+ words|word count|paragraph|absatz|absätze)/i;

function localFixes(ctx: PipelineContext, recs: RankMathRecommendation[]): { id: LocalFixId; change: Record<string, string>; note: string }[] {
  const t = ctx.task;
  const kw = (t.focusKeyword ?? t.keyword).trim();
  const lcKw = normalizeText(kw);
  const failing = recs.filter((r) => r.state === 'fail' || r.state === 'warning' || r.state === 'unknown');
  const wanted = new Set<LocalFixId>();
  for (const r of failing) {
    const hit = LOCAL_FIXABLE.find((f) => f.re.test(r.text));
    if (hit) wanted.add(hit.id);
  }
  const fixes: { id: LocalFixId; change: Record<string, string>; note: string }[] = [];
  const seoTitle = t.seoTitle ?? postTitle(ctx);
  if ((wanted.has('title-start') || wanted.has('title-keyword')) && !normalizeText(seoTitle).startsWith(lcKw)) {
    const candidates = [postTitle(ctx), `${kw}: ${seoTitle}`].filter((c) => normalizeText(c).startsWith(lcKw) && c.length <= 60);
    if (candidates[0] && candidates[0] !== seoTitle) fixes.push({ id: 'title-start', change: { seoTitle: candidates[0] }, note: `SEO title now starts with the focus keyword: “${candidates[0]}”` });
  }
  if (wanted.has('meta-keyword') && !normalizeText(t.metaDescription ?? '').includes(lcKw)) {
    const meta = metaFromIntro(articleHtml(ctx), kw, t.language);
    if (normalizeText(meta).includes(lcKw) && meta !== t.metaDescription) fixes.push({ id: 'meta-keyword', change: { metaDescription: meta }, note: 'Meta description now uses an intro sentence that contains the focus keyword.' });
  }
  if (wanted.has('slug-keyword')) {
    const slug = makeSlug(kw, t.language);
    if (slug && slug !== t.slug) fixes.push({ id: 'slug-keyword', change: { slug }, note: `Slug changed to “${slug}”.` });
  }
  return fixes;
}

function contentIssues(ctx: PipelineContext, recs: RankMathRecommendation[]): string[] {
  const fromRankMath = recs.filter((r) => r.state !== 'ok' && CONTENT_FIXABLE.test(r.text)).map((r) => `Rank Math: ${r.text}`);
  const local = seoReportFor(ctx, articleHtml(ctx))
    .checks.filter((c) => !c.passed && ['keyword-in-intro', 'keyword-in-heading', 'keyword-in-conclusion', 'paragraph-length'].includes(c.id))
    .map((c) => `Local check: ${c.label} — ${c.detail}`);
  return [...fromRankMath, ...local];
}

async function setRankMathFields(client: WpClient, ctx: PipelineContext) {
  const t = ctx.task;
  await client.rankMathUpdateMeta(t.wpPostId!, {
    rank_math_focus_keyword: (t.focusKeyword ?? t.keyword).trim(),
    rank_math_title: (t.seoTitle ?? postTitle(ctx)).trim(),
    rank_math_description: (t.metaDescription ?? '').trim(),
  });
}

/** Push the task's current article to the existing draft (conflict-checked and verified). */
async function pushContent(client: WpClient, ctx: PipelineContext, site: Website, editor: EditorKind) {
  const media = await prepareArticleMedia(client, articleHtml(ctx), ctx.taskId);
  try {
    const outcome = await saveDraft(client, draftInput(ctx, site, media.html, editor, null), async (data) => {
      await ctx.updateTask(data);
    });
    if (ctx.privateState<{ remoteEdit?: unknown }>().remoteEdit) await ctx.setPrivateState({ remoteEdit: null });
    return outcome;
  } catch (error) {
    await rememberRemoteEdit(ctx, error);
    throw error;
  }
}

export function rankMath(manifest: StageManifest): PipelineStage {
  return bind(manifest, { shouldRun: (ctx) => ctx.config.saveToWordPress, run: runRankMath });
}

async function runRankMath(ctx: PipelineContext): Promise<StageResult> {
  if (!ctx.task.wpPostId || !ctx.task.wpDraftAt) return { outcome: 'skipped', reason: 'No verified WordPress draft.' };
  const state = ctx.privateState<RankMathState>();
  const rounds: RankMathRound[] = state.rounds ?? [];
  const target = ctx.config.rankMathTargetScore;
  const maxRounds = ctx.config.maxRankMathAttempts;
  const notes: string[] = [];
  let contentChanged = false;

  // A. A content correction prompt is in flight (stage re-entered after waiting).
  if (state.correction) {
    const c = state.correction;
    const res = await ctx.askChatGPT('SEO_CORRECTION', c.vars, { part: `r${c.round}` });
    if (res.status === 'waiting') return waiting(`Waiting for ChatGPT: SEO correction round ${c.round}`);
    const before = bodyForAssembly(ctx);
    // Prompts since this change carry links as marks (c.links); restore them. Older prompts carried markdown links.
    const after = c.links ? restoreRichText(markdownToHtml(cleanModelMarkdown(res.text)), c.links) : markdownToHtml(cleanModelMarkdown(res.text));
    const check = evaluateCorrection(before, after, { keyword: ctx.task.focusKeyword ?? ctx.task.keyword, language: ctx.task.language, densityCeilingPct: ctx.config.keywordDensityCeilingPct });
    const round: RankMathRound = { round: c.round, kind: 'content', scoreBefore: c.scoreBefore, changes: [], accepted: false, reasons: check.reasons, before: before.slice(0, 20_000), after: after.slice(0, 20_000) };
    if (contentHash(before) !== c.bodyHash) {
      round.reasons = ['the article changed while the correction was pending'];
    } else if (check.accepted) {
      const assembled = await assembleForTask(ctx, after);
      const seo = seoReportFor(ctx, assembled.html);
      const quality = evaluateQuality({
        html: assembled.html,
        moduleKey: ctx.task.moduleKey,
        language: ctx.task.language,
        keyword: ctx.task.keyword,
        seo,
        reviewThreshold: ctx.config.reviewThreshold,
        densityCeilingPct: ctx.config.keywordDensityCeilingPct,
        expectedFaqCount: ctx.task.moduleKey === 'tigram-writer' ? ctx.config.tigramFaqCount : ctx.config.faqCount,
        categoryValid: true,
        assemblyWarnings: assembled.warnings,
        imagesRequired: false,
        imagesPresent: seo.metrics.images,
        extraWarnings: [],
      });
      if (quality.hardStops.length) {
        round.reasons = quality.hardStops.map((h) => `quality gate: ${h.message}`);
      } else {
        await ctx.updateTask({ bodyHtml: after, assembledHtml: assembled.html, seoScore: seo.score });
        round.accepted = true;
        round.changes = [`Article revised (${check.before.words} → ${check.after.words} words); headings, links and images preserved.`];
        contentChanged = true;
      }
    }
    rounds.push(round);
    await ctx.setPrivateState({ rounds, correction: null, contentStopped: round.accepted ? null : `Correction round ${c.round} rejected: ${(round.reasons ?? []).join('; ')}` });
  }

  const site = await freshSite(ctx);
  const settings = await getSettings();
  const timeoutMs = settings.browser.navigationTimeoutSec * 1000;
  const mode = ctx.config.rankMathMode;
  await ctx.progress('Checking the draft in the WordPress editor…');

  const result = await withWordPress(site, 'rank-math', async (context) => {
    const client = await WpClient.connect(context, siteRef(site), { timeoutMs, taskId: ctx.taskId });
    let editor = knownEditor(site);
    if (contentChanged) await pushContent(client, ctx, site, editor);
    const active = mode !== 'off' && client.hasRankMath;
    if (mode === 'required' && !client.hasRankMath) notes.push(`Rank Math is not active on ${site.name} (its REST API rankmath/v1 is not available) — SEO title, description and focus keyword were not set.`);
    if (mode === 'if-installed' && !client.hasRankMath) notes.push('Rank Math is not installed on this site; skipped.');
    if (active) await setRankMathFields(client, ctx);
    const page = await firstPage(context);
    const inspect = (save: boolean) =>
      inspectInEditor(page, siteRef(site), ctx.task.wpPostId!, { rankMath: active, save, timeoutMs, selectorOverrides: settings.advanced.selectorOverrides, screenshots: settings.browser.screenshots, taskId: ctx.taskId });
    let insp: EditorInspection = await inspect(active);
    let invalidBlocksFixed = 0;
    // The site really uses the Classic editor although blocks were saved → resave as plain HTML.
    if (insp.editor !== 'UNKNOWN' && insp.editor !== editor) {
      await db.website.update({ where: { id: site.id }, data: { detectedEditor: insp.editor } });
      editor = insp.editor;
      site.detectedEditor = insp.editor;
      await pushContent(client, ctx, site, editor);
      notes.push(`The site uses the ${editor === 'CLASSIC' ? 'Classic' : 'block'} editor; the draft was re-saved in that format.`);
      insp = await inspect(false);
    }
    if (insp.invalidBlocks.length) {
      invalidBlocksFixed = insp.invalidBlocks.length;
      await pushContent(client, ctx, site, 'CLASSIC');
      notes.push(`${insp.invalidBlocks.length} block(s) were invalid in this site's editor (${insp.invalidBlocks.slice(0, 3).map((b) => b.name).join(', ')}); the draft was re-saved as plain HTML.`);
      insp = await inspect(false);
    }
    if (insp.editor === 'UNKNOWN') notes.push('The editor did not load, so the draft could not be checked in the editor.');
    // Local metadata corrections (bounded).
    while (active && insp.rankMath?.score != null && insp.rankMath.score < target && rounds.length < maxRounds) {
      const fixes = localFixes(ctx, insp.rankMath.recommendations);
      if (!fixes.length) break;
      const change = Object.assign({}, ...fixes.map((f) => f.change)) as Record<string, string>;
      await ctx.updateTask(change);
      await setRankMathFields(client, ctx);
      if (change.slug) await client.updatePost(ctx.task.wpPostId!, { slug: change.slug });
      const scoreBefore = insp.rankMath.score;
      insp = await inspect(true);
      rounds.push({ round: rounds.length + 1, kind: 'local', scoreBefore, scoreAfter: insp.rankMath?.score ?? null, changes: fixes.map((f) => f.note), accepted: true });
    }
    // Editor saves change modified time (and may re-serialize): record what WordPress now holds.
    const saved = await client.getPost(ctx.task.wpPostId!);
    if (saved) {
      await ctx.updateTask({ wpModifiedGmt: saved.modified_gmt, wpContentHash: contentHash(saved.content.raw ?? ''), wpPostStatus: saved.status, wpSlug: saved.slug });
      if (!sameArticle(editorContent(articleHtml(ctx), editor), saved.content.raw ?? '')) notes.push('After the editor save, the stored content no longer matches the article exactly; check the draft.');
    }
    return { insp, active, invalidBlocksFixed, editor };
  });

  const { insp, active } = result;
  const rm = insp.rankMath;
  const expected = { focusKeyword: (ctx.task.focusKeyword ?? ctx.task.keyword).trim(), title: (ctx.task.seoTitle ?? postTitle(ctx)).trim(), description: (ctx.task.metaDescription ?? '').trim() };
  const fieldCheck = active && rm && rm.fieldsVia ? fieldsMatch(expected, rm.fields) : { ok: false, problems: active ? ['Rank Math fields could not be read back from the editor.'] : [] };
  const score = active ? (rm?.score ?? null) : null;

  // B. Ask for a guarded content correction when local fixes were not enough.
  if (active && score !== null && score < target && rounds.length < maxRounds && ctx.config.rankMathContentCorrection && !ctx.task.editedHtml && !ctx.privateState<RankMathState>().contentStopped) {
    const issues = contentIssues(ctx, rm?.recommendations ?? []);
    if (issues.length) {
      const body = bodyForAssembly(ctx);
      const marked = markRichText(body);
      const correction = {
        round: rounds.length + 1,
        scoreBefore: score,
        bodyHash: contentHash(body),
        links: marked.links,
        // Numbered issues and marked links: text ChatGPT's composer keeps exactly as typed (see markRichText).
        vars: { rankmath_issues: `${issues.map((i, k) => `${k + 1}. ${i}`).join('\n')}\n\n${MARKS_NOTE}`, final_article: htmlToMarkdown(marked.html), max_words: String(Math.round(wordCount(stripTags(body)) * 1.15)) },
      };
      await ctx.setPrivateState({ rounds, correction });
      const res = await ctx.askChatGPT('SEO_CORRECTION', correction.vars, { part: `r${correction.round}` });
      if (res.status === 'waiting') return waiting(`Waiting for ChatGPT: SEO correction round ${correction.round}`);
      // An earlier identical answer was reused: apply it right away.
      return runRankMath(ctx);
    }
  }

  // C. Report — the score is only what Rank Math showed; never computed here.
  const reasons: string[] = [];
  if (active && !fieldCheck.ok) reasons.push(...fieldCheck.problems.map((p) => `Rank Math field check: ${p}`));
  if (active && score === null) {
    reasons.push(
      rm?.zeroOnly
        ? 'Rank Math showed 0 / 100 for the whole check: it had not analysed the content in the editor, so no score is verified. Open the draft in WordPress to see the real score.'
        : 'Rank Math score could not be read from the editor (not verified).',
    );
  }
  if (active && score !== null && score < target) {
    const open = (rm?.recommendations ?? []).filter((r) => r.state === 'fail').map((r) => r.text);
    reasons.push(`Rank Math score ${score} is below the target ${target} after ${rounds.length} correction round(s).${open.length ? ` Open: ${open.slice(0, 5).join(' · ')}` : ''}`);
  }
  if (mode === 'required' && !active) reasons.push(notes[0] ?? 'Rank Math is not active on this site.');
  if (insp.editor === 'UNKNOWN') reasons.push('The draft could not be opened in the WordPress editor for checking.');
  if (insp.save.attempted && !insp.save.ok) notes.push(`Editor save: ${insp.save.detail}`);
  const contentStopped = ctx.privateState<RankMathState>().contentStopped;
  if (contentStopped) notes.push(contentStopped);

  const report: RankMathReport = {
    mode,
    active,
    target,
    score,
    scoreText: rm?.scoreText ?? null,
    scoreVia: rm?.scoreVia ?? null,
    fields: rm?.fields ?? null,
    fieldsVerified: fieldCheck.ok,
    fieldProblems: fieldCheck.problems,
    recommendations: rm?.recommendations ?? [],
    rounds,
    editor: insp.editor,
    invalidBlocksFixed: result.invalidBlocksFixed,
    editorSave: insp.save.attempted ? insp.save.detail : null,
    notes,
    checkedAt: new Date().toISOString(),
  };
  const existing = parseJson<string[]>(ctx.task.reviewReasons, []).filter((r) => !/^Rank Math|^The draft could not be opened/.test(r));
  await ctx.updateTask({
    rankMathScore: score,
    rankMathVerifiedAt: score !== null ? new Date() : null,
    rankMathReport: JSON.stringify(report),
    reviewReasons: JSON.stringify(Array.from(new Set([...existing, ...reasons]))),
  });
  if (mode === 'if-installed' && !active && insp.editor !== 'UNKNOWN') return { outcome: 'completed', data: report, message: 'Rank Math not installed; editor check passed' };
  return {
    outcome: 'completed',
    data: report,
    message: !active ? 'Rank Math not active' : score === null ? 'Rank Math score not readable' : `Rank Math ${score}/100${score >= target ? '' : ` (target ${target})`}`,
  };
}

// ---------------------------------------------------------- VERIFIED_COMPLETE

export function verifiedComplete(manifest: StageManifest): PipelineStage {
  return bind(manifest, {
    shouldRun: (ctx) => ctx.config.saveToWordPress,
    run: async (ctx) => {
      const t = ctx.task;
      if (!t.wpPostId || !t.wpDraftAt) return { outcome: 'skipped', reason: 'No verified WordPress draft to check.' };
      const site = await freshSite(ctx);
      const settings = await getSettings();
      const post = await withWordPress(site, 'verify', async (context) => {
        const client = await WpClient.connect(context, siteRef(site), { timeoutMs: settings.browser.navigationTimeoutSec * 1000, taskId: ctx.taskId });
        return client.getPost(t.wpPostId!);
      });
      if (!post || post.status === 'trash') {
        throw new NeedsReviewError(`WordPress draft #${t.wpPostId} ${post ? 'is in the trash' : 'no longer exists'}.`, [`Draft #${t.wpPostId} missing in WordPress.`], 'Restore it, or use “Create a new draft”.');
      }
      const problems: string[] = [];
      const notes: string[] = [];
      if (!['draft', 'pending'].includes(post.status)) problems.push(`post status is “${post.status}”, not a draft`);
      const cats = [...post.categories].sort((a, b) => a - b);
      if (cats.length !== 1 || cats[0] !== t.categoryExternalId) problems.push(`categories are [${cats.join(', ')}], expected [${t.categoryExternalId}]`);
      if ((post.title.raw ?? '').trim() !== postTitle(ctx)) problems.push('title differs from the approved title');
      if (t.wpContentHash && contentHash(post.content.raw ?? '') !== t.wpContentHash) notes.push(`Draft was edited in WordPress since the app saved it (modified ${post.modified_gmt} UTC).`);
      if (!post.content.raw || wordCount(stripTags(post.content.raw)) < 100) problems.push('draft body is (almost) empty');
      await ctx.updateTask({ wpPostStatus: post.status, wpVerifiedAt: new Date() });
      if (problems.length) {
        throw new NeedsReviewError(`Draft #${post.id} failed final verification: ${problems.join('; ')}.`, problems.map((p) => `Final check: ${p}`), 'Open the draft in WordPress, fix it, then Retry.');
      }
      return { outcome: 'completed', data: { verified: true, postId: post.id, status: post.status, modified: post.modified_gmt, notes }, message: `Draft #${post.id} verified (${post.status})` };
    },
  });
}
