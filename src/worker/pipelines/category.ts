import { db } from '@/lib/db';
import { NeedsReviewError } from '@/lib/pipeline-errors';
import { matchCategory } from '@/modules/tigram-writer/parsers';
import type { PipelineContext, PipelineStage } from '../pipeline/types';
import { waiting } from './common';

/** WordPress's own fallback category (“Uncategorized”; German installs: “Unkategorisiert”/“Ohne Kategorie”). */
export function isUncategorized(c: { name: string; slug: string | null }): boolean {
  return c.slug === 'uncategorized' || /^(uncategori[sz]ed|unkategorisiert|ohne kategorie)$/i.test(c.name.trim());
}

/**
 * The CATEGORY stage of both writers: ChatGPT chooses one of the website's synchronized categories for an article
 * nobody chose a category for (never invents one).
 *
 * Owner report: articles the workflow queued never got a category chosen. A workflow keyword has no category of its
 * own, so the article took the website's default (a category sync sets “Uncategorized”), and that default was taken
 * for the owner's choice. Owner decision: ChatGPT chooses for these articles, “Uncategorized” only when the website
 * has nothing else, and the website's default when ChatGPT names no existing category.
 */
export const categoryStage: Pick<PipelineStage, 'run' | 'shouldRun'> = {
  shouldRun: (ctx: PipelineContext) => {
    // Never once the WordPress draft exists: the saved post keeps its category (the draft checks compare the two).
    if (ctx.task.wpPostId) return false;
    // A category the owner chose (Single Article, a Bulk row) is kept. Workflow articles queued before this fix carry
    // the website's default in its place.
    return !ctx.task.categoryId || ctx.task.source === 'WORKFLOW';
  },
  run: async (ctx: PipelineContext) => {
    const site = await db.website.findUniqueOrThrow({ where: { id: ctx.task.websiteId }, include: { categories: { orderBy: { name: 'asc' } } } });
    const all = site.categories;
    if (all.length === 0) throw new NeedsReviewError(`${site.name} has no synchronized categories.`, ['No categories synced'], 'Sync categories on the website page, then Retry.');
    const real = all.filter((c) => !isUncategorized(c));
    const cats = real.length ? real : all;
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
    const fallback = site.defaultCategoryId ? all.find((c) => c.id === site.defaultCategoryId) : undefined;
    if (fallback) {
      const out = await choose(fallback, `site default — ChatGPT answered “${res.text.slice(0, 60)}”, which is not an existing category`);
      return { ...out, prompt: res.prompt, output: res.text, data: { ...out.data, warnings: [`ChatGPT proposed a category that does not exist; the site default “${fallback.name}” was used.`] } };
    }
    throw new NeedsReviewError(`ChatGPT proposed “${res.text.slice(0, 80)}”, which is not an existing category, and the site has no default.`, ['Category needs your choice'], 'Choose a category for this article (Overview), then Retry.');
  },
};
