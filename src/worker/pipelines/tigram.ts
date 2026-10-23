import { tigramManifest } from '@/modules/tigram-writer/manifest';
import { regenerationPlan } from '@/modules/types';
import { parseTigramArticle } from '@/modules/tigram-writer/parsers';
import { cleanModelMarkdown, markdownToHtml } from '@/lib/content/markdown';
import { stripTags, wordCount } from '@/lib/content/text';
import { TransientError } from '@/lib/pipeline-errors';
import type { PipelineContext, PipelineDefinition, PipelineStage } from '../pipeline/types';
import { articleApproval, assembly, bind, duplicatePrecheck, finalizeTask, precheck, qualityGate, seoCheck, stageFrom, syncTaskVariables, waiting } from './common';
import { categoryStage } from './category';
import { laterStages } from './later-stages';

const S = (key: string) => stageFrom(tigramManifest.stages, key);

async function rejectAndRetry(ctx: PipelineContext, responseId: string, reason: string): Promise<never> {
  await ctx.rejectResponse(responseId, reason);
  throw new TransientError(`${reason} A fresh prompt will be sent.`);
}

const stages: PipelineStage[] = [
  precheck(S('PRECHECK')),
  duplicatePrecheck(S('DUPLICATE_PRECHECK')),
  bind(S('ARTICLE'), {
    run: async (ctx) => {
      const res = await ctx.askChatGPT('ARTICLE');
      if (res.status === 'waiting') return waiting('Waiting for ChatGPT: article');
      const parsed = parseTigramArticle(res.text, ctx.task.language);
      if (parsed.problems.length) return rejectAndRetry(ctx, res.responseId, `The ARTICLE answer is not in the required format (${parsed.problems.join(' ')}).`);
      const md = cleanModelMarkdown(parsed.body, { title: parsed.seoTitle });
      const html = markdownToHtml(md);
      const words = wordCount(stripTags(html));
      if (words < 400) return rejectAndRetry(ctx, res.responseId, `The article had only ${words} words.`);
      await ctx.updateTask({
        bodyHtml: html,
        seoTitle: parsed.seoTitle,
        metaDescription: parsed.metaDescription,
        slug: parsed.slug,
        selectedTitle: ctx.task.selectedTitle ?? parsed.seoTitle,
        focusKeyword: ctx.task.keyword,
      });
      return { outcome: 'completed', prompt: res.prompt, output: md, outputHtml: html, data: { seoTitle: parsed.seoTitle, metaDescription: parsed.metaDescription, slug: parsed.slug, words, warnings: parsed.warnings }, message: `${words} words` };
    },
  }),
  bind(S('CATEGORY'), categoryStage),
  ...laterStages(tigramManifest.stages),
  assembly(S('ASSEMBLY')),
  seoCheck(S('SEO_CHECK')),
  qualityGate(S('QUALITY_GATE')),
  articleApproval(S('ARTICLE_APPROVAL')),
];

export const tigramPipeline: PipelineDefinition = {
  moduleKey: 'tigram-writer',
  manifest: tigramManifest,
  stages: tigramManifest.stages.map((m) => {
    const impl = stages.find((s) => s.key === m.key);
    if (!impl) throw new Error(`Tigram pipeline has no implementation for ${m.key}`);
    return impl;
  }),
  regenerationPlan: (stageKey) => regenerationPlan(tigramManifest, stageKey),
  variables: (ctx, extra = {}) => ({ ...syncTaskVariables(ctx), final_article: ctx.stageOutput('ARTICLE') ?? '', ...extra }),
  contextPrimer: async (ctx) =>
    [
      'Context from earlier steps of THIS article. Use only these facts; do not add new claims.',
      `Primary keyword: ${ctx.task.keyword}`,
      ctx.stageOutput('ARTICLE') ? `Current article (verbatim excerpt):\n${(ctx.stageOutput('ARTICLE') ?? '').slice(0, 8000)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  finalize: finalizeTask,
};
