import { celebrityManifest } from '@/modules/celebrity-writer/manifest';
import { regenerationPlan } from '@/modules/types';
import { analyzeResearch, parseFaqs, parseQuickBio, parseTitles } from '@/modules/celebrity-writer/parsers';
import { cleanModelMarkdown, markdownToHtml } from '@/lib/content/markdown';
import { wordCount, stripTags } from '@/lib/content/text';
import { TransientError } from '@/lib/pipeline-errors';
import type { PipelineContext, PipelineDefinition, PipelineStage } from '../pipeline/types';
import { articleApproval, assembly, bind, duplicatePrecheck, finalizeTask, precheck, qualityGate, seoCheck, stageFrom, syncTaskVariables, waiting } from './common';
import { categoryStage } from './category';
import { laterStages } from './later-stages';
import { buildLedger } from '@/lib/research/ledger';

const S = (key: string) => stageFrom(celebrityManifest.stages, key);

async function rejectAndRetry(ctx: PipelineContext, responseId: string, reason: string): Promise<never> {
  await ctx.rejectResponse(responseId, reason);
  throw new TransientError(`${reason} A fresh prompt will be sent.`);
}

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
  bind(S('RESEARCH'), {
    run: async (ctx) => {
      const res = await ctx.askChatGPT('RESEARCH');
      if (res.status === 'waiting') return waiting('Waiting for ChatGPT: research notes');
      if (res.text.trim().length < 300) return rejectAndRetry(ctx, res.responseId, 'The research answer was too short to support an article.');
      await ctx.updateTask({ researchNotes: res.text });
      return { outcome: 'completed', prompt: res.prompt, output: res.text, message: `${wordCount(res.text)} words of research notes (kept out of the article)` };
    },
  }),
  bind(S('RESEARCH_EVIDENCE'), {
    run: async (ctx) => {
      const analysis = analyzeResearch(ctx.task.researchNotes ?? '');
      // Claims are checked against the cited sources (fetched SSRF-safe, same person only); see Research Evidence.
      const ledger = await buildLedger(ctx.taskId);
      const warnings = [...ledger.warnings];
      const verified = (ledger.byStatus.VERIFIED ?? 0) + (ledger.byStatus.SINGLE_SOURCE ?? 0);
      return { outcome: 'completed', data: { ...analysis, ledger, warnings }, message: `${ledger.claims} claim(s): ${verified} supported by a source, ${ledger.byStatus.CONTRADICTED ?? 0} contradicted · ${ledger.sources.ok} usable source(s)` };
    },
  }),
  bind(S('LONG_ARTICLE'), {
    run: async (ctx) => {
      const res = await ctx.askChatGPT('LONG_ARTICLE');
      if (res.status === 'waiting') return waiting('Waiting for ChatGPT: long article');
      const words = wordCount(res.text);
      if (words < 500) return rejectAndRetry(ctx, res.responseId, `The long article had only ${words} words.`);
      return { outcome: 'completed', prompt: res.prompt, output: res.text, message: `${words} words` };
    },
  }),
  bind(S('FINAL_ARTICLE'), {
    run: async (ctx) => {
      const res = await ctx.askChatGPT('FINAL_ARTICLE');
      if (res.status === 'waiting') return waiting('Waiting for ChatGPT: final article');
      const md = cleanModelMarkdown(res.text, { title: ctx.task.selectedTitle });
      const html = markdownToHtml(md);
      const words = wordCount(stripTags(html));
      if (words < 300) return rejectAndRetry(ctx, res.responseId, `The final article had only ${words} words.`);
      await ctx.updateTask({ bodyHtml: html });
      const warnings = words > ctx.config.maxWords * 1.1 ? [`Final article has ${words} words (limit ${ctx.config.maxWords}).`] : [];
      return { outcome: 'completed', prompt: res.prompt, output: md, outputHtml: html, data: { words, warnings }, message: `${words} words` };
    },
  }),
  bind(S('FAQS'), {
    run: async (ctx) => {
      const res = await ctx.askChatGPT('FAQS');
      if (res.status === 'waiting') return waiting('Waiting for ChatGPT: FAQs');
      let faqs = parseFaqs(res.text);
      const want = ctx.config.faqCount;
      if (faqs.length < want) return rejectAndRetry(ctx, res.responseId, `Only ${faqs.length} of ${want} FAQs could be parsed.`);
      const warnings = faqs.length > want ? [`ChatGPT returned ${faqs.length} FAQs; the first ${want} were kept.`] : [];
      faqs = faqs.slice(0, want);
      await ctx.updateTask({ faqs: JSON.stringify(faqs) });
      return { outcome: 'completed', prompt: res.prompt, output: res.text, data: { faqs, warnings }, message: `${faqs.length} FAQs` };
    },
  }),
  bind(S('QUICK_BIO'), {
    run: async (ctx) => {
      const res = await ctx.askChatGPT('QUICK_BIO');
      if (res.status === 'waiting') return waiting('Waiting for ChatGPT: Quick Bio');
      const parsed = parseQuickBio(res.text, ctx.task.language, ctx.config.quickBioRows);
      const structural = parsed.problems.filter((p) => /columns|No table rows/.test(p));
      if (parsed.rows.length === 0 || structural.length) return rejectAndRetry(ctx, res.responseId, `The Quick Bio table is malformed (${(structural[0] ?? 'no rows')}).`);
      await ctx.updateTask({ quickBio: JSON.stringify(parsed.rows), quickBioHtml: parsed.html });
      return { outcome: 'completed', prompt: res.prompt, output: res.text, outputHtml: parsed.html, data: { rows: parsed.rows, warnings: parsed.problems }, message: `${parsed.rows.length} rows` };
    },
  }),
  bind(S('CATEGORY'), categoryStage),
  ...laterStages(celebrityManifest.stages),
  assembly(S('ASSEMBLY')),
  seoCheck(S('SEO_CHECK')),
  qualityGate(S('QUALITY_GATE')),
  articleApproval(S('ARTICLE_APPROVAL')),
];


export const celebrityPipeline: PipelineDefinition = {
  moduleKey: 'celebrity-writer',
  manifest: celebrityManifest,
  stages: celebrityManifest.stages.map((m) => {
    const impl = stages.find((s) => s.key === m.key);
    if (!impl) throw new Error(`Celebrity pipeline has no implementation for ${m.key}`);
    return impl;
  }),
  regenerationPlan: (stageKey) => regenerationPlan(celebrityManifest, stageKey),
  variables: (ctx, extra = {}) => ({
    ...syncTaskVariables(ctx),
    final_article: ctx.stageOutput('FINAL_ARTICLE') ?? '',
    ...extra,
  }),
  contextPrimer: async (ctx) => {
    const parts = [
      'Context from earlier steps of THIS article (same subject). Use only these facts; do not add new claims.',
      `Primary keyword: ${ctx.task.keyword}`,
      ctx.task.selectedTitle ? `Approved title: ${ctx.task.selectedTitle}` : '',
      ctx.task.researchNotes ? `Research notes (verbatim excerpt):\n${ctx.task.researchNotes.slice(0, 7000)}` : '',
      ctx.stageOutput('FINAL_ARTICLE') ? `Current final article (verbatim excerpt):\n${(ctx.stageOutput('FINAL_ARTICLE') ?? '').slice(0, 7000)}` : '',
    ].filter(Boolean);
    return parts.join('\n\n');
  },
  finalize: finalizeTask,
};
