import { db } from '@/lib/db';
import { tigramManifest } from '@/modules/tigram-writer/manifest';
import { regenerationPlan } from '@/modules/types';
import { matchCategory, parseTigramArticle } from '@/modules/tigram-writer/parsers';
import { cleanModelMarkdown, markdownToHtml } from '@/lib/content/markdown';
import { stripTags, wordCount } from '@/lib/content/text';
import { NeedsReviewError, TransientError } from '@/lib/pipeline-errors';
import type { PipelineContext, PipelineDefinition, PipelineStage } from '../pipeline/types';
import { articleApproval, assembly, bind, duplicatePrecheck, finalizeTask, precheck, qualityGate, seoCheck, stageFrom, syncTaskVariables, waiting } from './common';
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
  bind(S('CATEGORY'), {
    // Skip when the owner already chose a category (no unnecessary prompt).
    shouldRun: (ctx) => !ctx.task.categoryId,
    run: async (ctx) => {
      const site = await db.website.findUniqueOrThrow({ where: { id: ctx.task.websiteId }, include: { categories: { orderBy: { name: 'asc' } } } });
      const cats = site.categories;
      if (cats.length === 0) throw new NeedsReviewError(`${site.name} has no synchronized categories.`, ['No categories synced'], 'Sync categories on the website page, then Retry.');
      const choose = async (c: { id: string; name: string; externalId: number }, how: string) => {
        await ctx.updateTask({ categoryId: c.id, categoryName: c.name, categoryExternalId: c.externalId });
        return { outcome: 'completed' as const, data: { category: c.name, how }, message: `Category: ${c.name} (${how})` };
      };
      if (cats.length === 1) return choose(cats[0], 'only category');
      const res = await ctx.askChatGPT('CATEGORY', { categories: cats.map((c) => c.name).join('\n') });
      if (res.status === 'waiting') return waiting('Waiting for ChatGPT: category');
      const match = matchCategory(res.text, cats);
      if (match) {
        const cat = cats.find((c) => c.id === match.id)!;
        const out = await choose(cat, 'chosen by ChatGPT from the synced list');
        return { ...out, prompt: res.prompt, output: res.text };
      }
      const fallback = site.defaultCategoryId ? cats.find((c) => c.id === site.defaultCategoryId) : undefined;
      if (fallback) {
        const out = await choose(fallback, `site default — ChatGPT answered “${res.text.slice(0, 60)}”, which is not an existing category`);
        return { ...out, prompt: res.prompt, output: res.text, data: { ...out.data, warnings: [`ChatGPT proposed a category that does not exist; the site default “${fallback.name}” was used.`] } };
      }
      throw new NeedsReviewError(`ChatGPT proposed “${res.text.slice(0, 80)}”, which is not an existing category, and the site has no default.`, ['Category needs your choice'], 'Choose a category for this article (Overview), then Retry.');
    },
  }),
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
