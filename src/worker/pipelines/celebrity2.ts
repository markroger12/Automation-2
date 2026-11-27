import { celebrity2Manifest } from '@/modules/celebrity2-writer/manifest';
import { regenerationPlan } from '@/modules/types';
import { parseTitles } from '@/modules/celebrity-writer/parsers';
import { parseCelebrity2Article } from '@/modules/celebrity2-writer/parsers';
import { sameTitle } from '@/lib/content/markdown';
import { TransientError } from '@/lib/pipeline-errors';
import type { PipelineContext, PipelineDefinition, PipelineStage } from '../pipeline/types';
import { articleApproval, assembly, bind, duplicatePrecheck, finalizeTask, precheck, qualityGate, seoCheck, stageFrom, syncTaskVariables, waiting } from './common';
import { categoryStage } from './category';
import { articleLinkCheck, internalLinks } from './links';
import { imagesStage } from './images';
import { humanizeStage } from './humanize';
import { rankMath, verifiedComplete, wordpressDraft } from './wordpress';

const S = (key: string) => stageFrom(celebrity2Manifest.stages, key);

async function rejectAndRetry(ctx: PipelineContext, responseId: string, reason: string): Promise<never> {
  await ctx.rejectResponse(responseId, reason);
  throw new TransientError(`${reason} A fresh prompt will be sent.`);
}

/**
 * Celebrity 2 (owner request, 2026-11-04). The title step is the Celebrity writer's (owner: “title ka step rakhna
 * ha”: with or without a title from the owner, a title is generated; the owner's title is the example). The approved
 * title goes into the owner's article prompt, and the post keeps that title. One answer then gives the whole article.
 */
const stages: PipelineStage[] = [
  precheck(S('PRECHECK')),
  duplicatePrecheck(S('DUPLICATE_PRECHECK')),
  bind(S('TITLES'), {
    run: async (ctx) => {
      const res = await ctx.askChatGPT('TITLES');
      if (res.status === 'waiting') return waiting('Waiting for ChatGPT: title ideas');
      const parsed = parseTitles(res.text);
      if (!parsed.recommended || parsed.options.length < 2) return rejectAndRetry(ctx, res.responseId, 'The TITLES answer had no parseable “Recommended Title:” line.');
      const auto = !ctx.config.manualTitleApproval;
      await ctx.updateTask({
        titleOptions: JSON.stringify(parsed.options),
        recommendedTitle: parsed.recommended,
        ...(auto && !ctx.task.titleApprovedAt ? { selectedTitle: parsed.recommended, titleApprovedAt: new Date() } : {}),
      });
      return { outcome: 'completed', prompt: res.prompt, output: res.text, data: parsed, message: `${parsed.options.length} titles; recommended “${parsed.recommended}”` };
    },
  }),
  bind(S('TITLE_APPROVAL'), {
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
      const res = await ctx.askChatGPT('ARTICLE');
      if (res.status === 'waiting') return waiting('Waiting for ChatGPT: article');
      const title = ctx.task.selectedTitle ?? ctx.task.recommendedTitle;
      const parsed = parseCelebrity2Article(res.text, ctx.task.language, title);
      if (parsed.problems.length) return rejectAndRetry(ctx, res.responseId, `The ARTICLE answer is not in the required format (${parsed.problems.join(' ')}).`);
      const warnings = [...parsed.warnings];
      if (parsed.h1 && title && !sameTitle(parsed.h1, title)) warnings.push(`ChatGPT's heading was “${parsed.h1}”; the post keeps the approved title “${title}”.`);
      await ctx.updateTask({
        bodyHtml: parsed.html,
        seoTitle: parsed.seoTitle,
        metaDescription: parsed.metaDescription,
        slug: parsed.slug,
        quickBio: JSON.stringify(parsed.bioRows),
        quickBioHtml: parsed.bioHtml,
        faqs: JSON.stringify(parsed.faqs),
        focusKeyword: ctx.task.keyword,
      });
      return {
        outcome: 'completed',
        prompt: res.prompt,
        output: parsed.markdown,
        outputHtml: parsed.html,
        data: { seoTitle: parsed.seoTitle, metaDescription: parsed.metaDescription, slug: parsed.slug, words: parsed.words, bioRows: parsed.bioRows.length, faqs: parsed.faqs.length, warnings },
        message: `${parsed.words} words · Family Profile ${parsed.bioRows.length} rows · ${parsed.faqs.length} FAQs`,
      };
    },
  }),
  articleLinkCheck(S('EXTERNAL_LINKS')),
  internalLinks(S('INTERNAL_LINKS')),
  imagesStage(S('IMAGES')),
  humanizeStage(S('HUMANIZE')),
  assembly(S('ASSEMBLY')),
  seoCheck(S('SEO_CHECK')),
  qualityGate(S('QUALITY_GATE')),
  articleApproval(S('ARTICLE_APPROVAL')),
  wordpressDraft(S('WORDPRESS_DRAFT')),
  rankMath(S('RANKMATH')),
  verifiedComplete(S('VERIFIED_COMPLETE')),
];

export const celebrity2Pipeline: PipelineDefinition = {
  moduleKey: 'celebrity2-writer',
  manifest: celebrity2Manifest,
  stages: celebrity2Manifest.stages.map((m) => {
    const impl = stages.find((s) => s.key === m.key);
    if (!impl) throw new Error(`Celebrity 2 pipeline has no implementation for ${m.key}`);
    return impl;
  }),
  regenerationPlan: (stageKey) => regenerationPlan(celebrity2Manifest, stageKey),
  variables: (ctx, extra = {}) => ({ ...syncTaskVariables(ctx), final_article: ctx.stageOutput('ARTICLE') ?? '', ...extra }),
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
