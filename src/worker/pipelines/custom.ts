import { regenerationPlan, validateManifest } from '@/modules/types';
import { customManifest } from '@/modules/custom/manifest';
import { parseCustomArticle } from '@/modules/custom/parsers';
import { parseTitles } from '@/modules/celebrity-writer/parsers';
import { sameTitle } from '@/lib/content/markdown';
import { FatalError, TransientError } from '@/lib/pipeline-errors';
import { allCustomWriters, customWriter, customWritersVersion } from '@/lib/writers/catalog';
import type { CustomWriterInfo } from '@/lib/writers/types';
import type { PipelineContext, PipelineDefinition, PipelineStage } from '../pipeline/types';
import { getPipeline, registerPipeline } from '../pipeline/registry';
import { articleApproval, assembly, bind, duplicatePrecheck, finalizeTask, precheck, qualityGate, seoCheck, stageFrom, syncTaskVariables, waiting } from './common';
import { categoryStage } from './category';
import { articleLinkCheck, internalLinks } from './links';
import { imagesStage } from './images';
import { humanizeStage } from './humanize';
import { rankMath, verifiedComplete, wordpressDraft } from './wordpress';

/**
 * A writer the owner built in the app (Writers → a writer). Its steps are those of Celebrity 2 — the whole article in
 * one answer to the owner's prompt — and its settings, read when each step runs, decide which of them run and what the
 * answer must contain (src/lib/writers/types.ts).
 */

function settingsOf(ctx: PipelineContext): CustomWriterInfo {
  const w = customWriter(ctx.task.moduleKey);
  if (!w) throw new FatalError(`The writer “${ctx.task.moduleKey}” no longer exists.`, 'Start the article again with another writer.');
  return w;
}

async function rejectAndRetry(ctx: PipelineContext, responseId: string, reason: string): Promise<never> {
  await ctx.rejectResponse(responseId, reason);
  throw new TransientError(`${reason} A fresh prompt will be sent.`);
}

/** The stage, run only when `when` allows it (and its own condition, if it has one). */
function onlyIf(stage: PipelineStage, when: (ctx: PipelineContext) => boolean): PipelineStage {
  return { ...stage, shouldRun: async (ctx) => when(ctx) && (stage.shouldRun ? await stage.shouldRun(ctx) : true) };
}

/** The title the article is written for: the approved one, else (no title step) the example title or the keyword. */
const workingTitle = (ctx: PipelineContext) => ctx.task.selectedTitle ?? ctx.task.recommendedTitle ?? (ctx.task.exampleTitle?.trim() || ctx.task.keyword);

export function customPipeline(info: CustomWriterInfo): PipelineDefinition {
  const manifest = customManifest(info);
  const S = (key: string) => stageFrom(manifest.stages, key);
  const stages: PipelineStage[] = [
    precheck(S('PRECHECK')),
    duplicatePrecheck(S('DUPLICATE_PRECHECK')),
    bind(S('TITLES'), {
      shouldRun: (ctx) => settingsOf(ctx).config.titles !== 'off',
      run: async (ctx) => {
        const res = await ctx.askChatGPT('TITLES');
        if (res.status === 'waiting') return waiting('Waiting for ChatGPT: title ideas');
        const parsed = parseTitles(res.text);
        if (!parsed.recommended || parsed.options.length < 1) return rejectAndRetry(ctx, res.responseId, 'The TITLES answer had no parseable “Recommended Title:” line.');
        const auto = !ctx.config.manualTitleApproval;
        await ctx.updateTask({
          titleOptions: JSON.stringify(parsed.options.length ? parsed.options : [parsed.recommended]),
          recommendedTitle: parsed.recommended,
          ...(auto && !ctx.task.titleApprovedAt ? { selectedTitle: parsed.recommended, titleApprovedAt: new Date() } : {}),
        });
        return { outcome: 'completed', prompt: res.prompt, output: res.text, data: parsed, message: `${parsed.options.length} titles; recommended “${parsed.recommended}”` };
      },
    }),
    bind(S('TITLE_APPROVAL'), {
      shouldRun: (ctx) => settingsOf(ctx).config.titles !== 'off',
      run: async (ctx) => {
        if (ctx.config.manualTitleApproval && !ctx.task.titleApprovedAt) {
          return { outcome: 'paused', status: 'AWAITING_TITLE_APPROVAL', message: 'Waiting for your title approval.', nextAction: 'Open the Titles tab, choose or edit a title, then approve it.' };
        }
        if (!ctx.task.selectedTitle) await ctx.updateTask({ selectedTitle: ctx.task.recommendedTitle, titleApprovedAt: ctx.task.titleApprovedAt ?? new Date() });
        return { outcome: 'completed', message: `Title: “${ctx.task.selectedTitle ?? ctx.task.recommendedTitle}”` };
      },
    }),
    bind(S('CATEGORY'), categoryStage),
    bind(S('ARTICLE'), {
      run: async (ctx) => {
        const w = settingsOf(ctx);
        const res = await ctx.askChatGPT('ARTICLE');
        if (res.status === 'waiting') return waiting('Waiting for ChatGPT: article');
        const approved = ctx.task.selectedTitle ?? ctx.task.recommendedTitle;
        const parsed = parseCustomArticle(res.text, ctx.task.language, approved, { base: w.base, rules: w.config.rules });
        if (parsed.problems.length) return rejectAndRetry(ctx, res.responseId, `The ARTICLE answer is not in the writer's format (${parsed.problems.join(' ')}).`);
        const warnings = [...parsed.warnings];
        if (parsed.h1 && approved && !sameTitle(parsed.h1, approved)) warnings.push(`ChatGPT's heading was “${parsed.h1}”; the post keeps the approved title “${approved}”.`);
        // No title step: the post title is the example title, else the article's own title, else its SEO title.
        const title = approved ?? (ctx.task.exampleTitle?.trim() || parsed.h1 || parsed.seoTitle || ctx.task.keyword);
        await ctx.updateTask({
          bodyHtml: parsed.html,
          seoTitle: parsed.seoTitle,
          metaDescription: parsed.metaDescription,
          slug: parsed.slug,
          ...(w.base === 'person' ? { quickBio: JSON.stringify(parsed.bioRows), quickBioHtml: parsed.bioHtml } : {}),
          faqs: JSON.stringify(parsed.faqs),
          focusKeyword: ctx.task.keyword,
          ...(approved ? {} : { selectedTitle: title, recommendedTitle: title, titleApprovedAt: new Date() }),
        });
        return {
          outcome: 'completed',
          prompt: res.prompt,
          output: parsed.markdown,
          outputHtml: parsed.html,
          data: { seoTitle: parsed.seoTitle, metaDescription: parsed.metaDescription, slug: parsed.slug, words: parsed.words, tableRows: parsed.bioRows.length, faqs: parsed.faqs.length, h2: parsed.h2, warnings },
          message: [`${parsed.words} words`, parsed.bioRows.length ? `${parsed.bioRows.length} table rows` : '', `${parsed.faqs.length} FAQs`].filter(Boolean).join(' · '),
        };
      },
    }),
    onlyIf(articleLinkCheck(S('EXTERNAL_LINKS')), (ctx) => settingsOf(ctx).config.linkCheck),
    onlyIf(internalLinks(S('INTERNAL_LINKS')), (ctx) => settingsOf(ctx).config.internalLinks),
    onlyIf(imagesStage(S('IMAGES')), (ctx) => settingsOf(ctx).config.images !== 'off'),
    humanizeStage(S('HUMANIZE')),
    assembly(S('ASSEMBLY')),
    seoCheck(S('SEO_CHECK')),
    qualityGate(S('QUALITY_GATE')),
    articleApproval(S('ARTICLE_APPROVAL')),
    wordpressDraft(S('WORDPRESS_DRAFT')),
    rankMath(S('RANKMATH')),
    verifiedComplete(S('VERIFIED_COMPLETE')),
  ];
  return {
    moduleKey: info.key,
    manifest,
    stages: manifest.stages.map((m) => {
      const impl = stages.find((s) => s.key === m.key);
      if (!impl) throw new Error(`The writer ${info.key} has no step ${m.key}`);
      return impl;
    }),
    regenerationPlan: (stageKey) => regenerationPlan(manifest, stageKey),
    variables: (ctx, extra = {}) => ({ ...syncTaskVariables(ctx), selected_title: workingTitle(ctx), final_article: ctx.stageOutput('ARTICLE') ?? '', ...extra }),
    contextPrimer: async (ctx) =>
      [
        'Context from earlier steps of THIS article (same subject). Use only these facts; do not add new claims.',
        `Primary keyword: ${ctx.task.keyword}`,
        ctx.task.selectedTitle ? `Approved title: ${ctx.task.selectedTitle}` : '',
        ctx.stageOutput('ARTICLE') ? `Current article (verbatim excerpt):\n${(ctx.stageOutput('ARTICLE') ?? '').slice(0, 8000)}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    finalize: finalizeTask,
  };
}

let registeredVersion = -1;

/** (Re)register the owner's writers' pipelines when the catalog changed (worker start, refresh loop, an unknown writer). */
export function registerCustomPipelines(): number {
  if (registeredVersion === customWritersVersion()) return 0;
  let n = 0;
  for (const w of allCustomWriters()) {
    const def = customPipeline(w);
    const problems = validateManifest(def.manifest);
    if (problems.length) {
      console.error(`Writer ${w.key} not registered: ${problems.join('; ')}`);
      continue;
    }
    registerPipeline(def);
    n++;
  }
  registeredVersion = customWritersVersion();
  return n;
}

/** Tests only. */
export const customPipelineRegistered = (key: string) => Boolean(getPipeline(key));
