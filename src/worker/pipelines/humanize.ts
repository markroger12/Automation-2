import { parseJson } from '@/lib/json';
import { getSettings } from '@/lib/settings';
import { TransientError } from '@/lib/pipeline-errors';
import { batchVariables, evaluateBatch, applyResults, planHumanize, skippedResults, summarize, type ParagraphResult } from '@/lib/humanizer/plan';
import type { StageManifest } from '@/modules/types';
import type { PipelineContext, PipelineStage, StageResult } from '../pipeline/types';
import { bind, waiting } from './common';

/**
 * HUMANIZE: editorial polish with fact locks (not a detector bypass).
 * Always starts from the saved pre-humanizer body (never from an earlier
 * humanized version), so regeneration cannot compound edits. Each batch is
 * its own ChatGPT prompt (`part`), so an accepted batch is never re-sent or
 * overwritten when another batch is retried. The batches go to the chat the
 * article was written in (owner request), one after another: a chat answers
 * one prompt at a time.
 */

/** The unedited source: external-link output, else the article body. */
export function humanizerSource(ctx: PipelineContext): string {
  const linked = ctx.stages.get('EXTERNAL_LINKS');
  if (linked?.status === 'COMPLETED' && linked.outputHtml) return linked.outputHtml;
  return ctx.task.bodyHtml ?? '';
}

async function requiredNames(ctx: PipelineContext): Promise<string[]> {
  if (ctx.task.moduleKey !== 'celebrity-writer') return [];
  const { confirmedFullName } = await import('@/modules/celebrity-writer/parsers');
  const full = confirmedFullName(parseJson(ctx.task.quickBio, []));
  return [ctx.task.keyword, full].filter((x): x is string => Boolean(x && /\p{Lu}/u.test(x)));
}

export function humanizeStage(manifest: StageManifest): PipelineStage {
  return bind(manifest, {
    shouldRun: (ctx) => ctx.config.humanizerEnabled,
    run: async (ctx): Promise<StageResult> => {
      const source = humanizerSource(ctx);
      const language = ctx.task.language;
      const plan = planHumanize(source, { language, scope: ctx.config.humanizerScope, batchWords: ctx.config.humanizerBatchWords });
      const lock = { keyword: ctx.task.keyword, language, names: await requiredNames(ctx), tolerancePct: ctx.config.humanizerLengthTolerancePct };
      const results: ParagraphResult[] = [];
      if (plan.batches.length) {
        // On the last retry a batch that still fails keeps its original paragraphs instead of failing the article.
        const lastAttempt = ctx.stage.attempts > (await getSettings()).workflow.retryAttempts;
        const ask = async (index: number) => {
          try {
            return await ctx.askChatGPT('HUMANIZE', batchVariables(plan, index), { part: `b${index + 1}` });
          } catch (error) {
            if (lastAttempt && error instanceof TransientError) return { status: 'failed' as const, error: error.message };
            throw error;
          }
        };
        // One batch at a time in the article's chat: the next one is sent only after the previous one is answered.
        const answers: Awaited<ReturnType<typeof ask>>[] = [];
        for (const b of plan.batches) {
          const answer = await ask(b.index);
          if (answer.status === 'waiting') return waiting(`Waiting for ChatGPT: humanizer batch ${b.index + 1} of ${plan.batches.length}`);
          answers.push(answer);
        }
        answers.forEach((a, i) => results.push(...evaluateBatch(plan, i, a.status === 'completed' ? a.text : { error: a.status === 'failed' ? a.error : 'no answer' }, lock)));
      }
      results.push(...skippedResults(plan));
      results.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
      const html = applyResults(source, plan, results);
      const summary = summarize(plan, results, language);
      const data = { scope: ctx.config.humanizerScope, batches: plan.batches.length, observations: plan.observations, paragraphs: results, summary };
      const message = plan.batches.length ? `${summary.rewritten} paragraph(s) edited, ${summary.kept} kept by fact locks, ${summary.unchanged} unchanged, ${summary.skipped} not sent` : 'No paragraph needed editing';
      return { outcome: 'completed', outputHtml: html, data, message };
    },
  });
}
