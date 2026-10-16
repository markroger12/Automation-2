import type { ArticleStage, ArticleTask, Website } from '@prisma/client';
import { db } from '@/lib/db';
import { log } from '@/lib/log';
import { parseJson } from '@/lib/json';
import { CancelledError, FatalError, TransientError, UncertainSideEffectError } from '@/lib/pipeline-errors';
import { renderTemplate, type TemplateVars } from '@/lib/prompts/template';
import { languageInstruction } from '@/lib/chatgpt/language';
import { createChatGPTRequest } from '@/lib/chatgpt/jobs';
import { loadPromptTemplate, promptModuleFor } from '@/lib/prompts/load';
import { getSettings } from '@/lib/settings';
import { defaultSeoBrief, parseSeoBrief, seoBriefText } from '@/lib/seo/intent';

/** Writing prompts that receive the SEO brief when the template does not place {{seo_brief}} itself. */
const SEO_BRIEF_STAGES = ['LONG_ARTICLE', 'ARTICLE'];
import type { EffectiveTaskConfig } from '@/lib/settings-schema';
import type { AskOptions, ChatGPTOutcome, PipelineContext, PipelineDefinition, PipelineStage } from './types';

export interface ContextDeps {
  definition: PipelineDefinition;
  stage: PipelineStage;
  row: ArticleStage;
  task: ArticleTask;
  website: Website;
  config: EffectiveTaskConfig;
  stages: Map<string, ArticleStage>;
  workerId: string;
  signal: AbortSignal;
}

export function createContext(deps: ContextDeps): PipelineContext {
  let task = deps.task;
  let row = deps.row;

  const ctx: PipelineContext = {
    taskId: deps.task.id,
    get task() {
      return task;
    },
    set task(value: ArticleTask) {
      task = value;
    },
    website: deps.website,
    config: deps.config,
    get stage() {
      return row;
    },
    set stage(value: ArticleStage) {
      row = value;
    },
    manifest: deps.stage,
    workerId: deps.workerId,
    signal: deps.signal,
    stages: deps.stages,

    async log(message, level = 'info', details) {
      await log({ level, category: 'pipeline', taskId: task.id, stage: row.key, message, details });
    },

    async progress(message, percent) {
      if (deps.signal.aborted) return;
      task = await db.articleTask.update({
        where: { id: task.id },
        data: { message: message.slice(0, 500), ...(percent !== undefined ? { percent: Math.max(0, Math.min(100, Math.round(percent))) } : {}) },
      });
      row = await db.articleStage.update({ where: { id: row.id }, data: { message: message.slice(0, 500) } });
    },

    async checkCancelled() {
      if (deps.signal.aborted) throw new CancelledError('Worker lost the job lease; stopping safely.');
      const fresh = await db.articleTask.findUnique({ where: { id: task.id }, select: { cancelRequested: true } });
      if (fresh?.cancelRequested) throw new CancelledError();
    },

    async updateTask(data) {
      task = await db.articleTask.update({ where: { id: task.id }, data: { ...data, version: { increment: 1 } } as never });
      return task;
    },

    async setPrivateState(state) {
      const current = parseJson<Record<string, unknown>>(row.privateState, {});
      row = await db.articleStage.update({ where: { id: row.id }, data: { privateState: JSON.stringify({ ...current, ...state }) } });
    },

    privateState<T extends Record<string, unknown>>() {
      return parseJson<T>(row.privateState, {} as T);
    },

    stageOutput(key) {
      const s = deps.stages.get(key);
      if (!s || (s.status !== 'COMPLETED' && s.status !== 'SKIPPED')) return null;
      return s.output ?? null;
    },

    stageJson<T>(key: string) {
      const s = deps.stages.get(key);
      if (!s || !s.outputJson) return null;
      return parseJson<T | null>(s.outputJson, null);
    },

    async rejectResponse(responseId, reason) {
      await db.chatGPTResponse.update({ where: { id: responseId }, data: { status: 'REJECTED', error: reason.slice(0, 1000) } });
    },

    async askChatGPT(promptStageKey: string, extra: TemplateVars = {}, options: AskOptions = {}): Promise<ChatGPTOutcome> {
      await ctx.checkCancelled();
      const promptModule = deps.stage.prompt?.stageKey === promptStageKey ? deps.stage.prompt.moduleKey : promptModuleFor(deps.definition.moduleKey, promptStageKey);
      const template = await loadPromptTemplate(promptModule, promptStageKey, deps.website);
      // SEO brief (upgrade 04): available as {{seo_brief}}; appended to the writing prompts when the template does not place it.
      const settings = await getSettings();
      const brief = settings.seo.seoBriefInPrompts ? (parseSeoBrief(task.seoBrief) ?? defaultSeoBrief({ keyword: task.keyword, secondary: parseJson<string[]>(task.secondaryKeywords, []), moduleKey: task.moduleKey, language: task.language })) : null;
      const briefText = brief ? seoBriefText(brief, task.language) : '';
      const vars = { seo_brief: briefText, ...deps.definition.variables(ctx, extra) };
      const rendered = renderTemplate(template.content, vars);
      const requiredMissing = rendered.missing.filter((name) => template.variables.find((v) => v.name === name)?.required !== false);
      if (requiredMissing.length) {
        throw new FatalError(
          `Prompt ${promptModule}/${promptStageKey} has unresolved required placeholders: ${requiredMissing.join(', ')}. Nothing was sent to ChatGPT.`,
          'Fix the prompt in Prompt Manager or provide the missing input, then retry.',
        );
      }
      let prompt = rendered.text;
      if (briefText && SEO_BRIEF_STAGES.includes(promptStageKey) && !template.content.includes('{{seo_brief}}')) prompt = `${prompt}\n\n${briefText}`;
      if (template.kind === 'text') prompt = `${prompt}\n\n${languageInstruction(task.language, task.targetCountry)}`;

      const part = options.part ? `:${options.part}` : '';
      const baseOp = `${task.id}:${row.key}${part}:a${row.attempts}`;
      // Reuse a valid completed answer for exactly this prompt (exactly-once; avoid duplicate sends).
      if (!options.fresh) {
        const reusable = await db.chatGPTResponse.findFirst({
          where: { taskId: task.id, stageKey: row.key, status: 'COMPLETED', renderedPrompt: prompt, operationId: { startsWith: `${task.id}:${row.key}${part}:` } },
          orderBy: { completedAt: 'desc' },
        });
        if (reusable && reusable.resultText !== null) {
          return { status: 'completed', responseId: reusable.id, text: reusable.resultText, html: reusable.resultHtml, conversationUrl: reusable.conversationUrl, prompt, reused: reusable.operationId !== baseOp, images: await imagesFor(reusable.id), imageLinks: parseJson(reusable.imageLinks, []) };
        }
      }
      // Find the latest operation of this attempt (switch suffixes :s1, :s2 … after lost conversations).
      const ops = await db.chatGPTResponse.findMany({ where: { taskId: task.id, operationId: { startsWith: baseOp } }, orderBy: { createdAt: 'asc' } });
      const latest = ops[ops.length - 1];
      if (latest) {
        if (latest.status === 'COMPLETED' && latest.resultText !== null) {
          if (latest.renderedPrompt !== prompt && !latest.renderedPrompt.endsWith(prompt)) {
            await ctx.log('Saved answer belongs to a different prompt version; a fresh prompt will be sent.', 'warn');
          } else {
            return { status: 'completed', responseId: latest.id, text: latest.resultText, html: latest.resultHtml, conversationUrl: latest.conversationUrl, prompt, reused: false, images: await imagesFor(latest.id), imageLinks: parseJson(latest.imageLinks, []) };
          }
        }
        if (latest.status === 'PENDING') return { status: 'waiting', prompt };
        if (latest.status === 'FAILED' && (latest.error ?? '').startsWith('UNCERTAIN')) {
          throw new UncertainSideEffectError(`ChatGPT could not prove whether the ${row.key} prompt was answered: ${latest.error}`, { operationId: latest.operationId, conversationUrl: latest.conversationUrl });
        }
        if (latest.status === 'FAILED' && !(latest.error ?? '').startsWith('CONVERSATION_LOST')) {
          throw new TransientError(`ChatGPT could not complete ${row.key}: ${latest.error ?? 'unknown error'}`);
        }
        if (latest.status === 'REJECTED' || latest.status === 'SUPERSEDED') {
          // fall through to send a new operation under a new suffix
        }
      }
      // New conversation required (lost conversation): prepend a source-faithful primer.
      const lost = latest && latest.status === 'FAILED' && (latest.error ?? '').startsWith('CONVERSATION_LOST');
      const suffix = ops.length ? `:s${ops.length}` : '';
      let finalPrompt = prompt;
      if (lost) {
        if (ops.length >= 3) throw new UncertainSideEffectError('ChatGPT conversation was lost repeatedly; manual review needed before sending again.', { operations: ops.map((o) => o.operationId) });
        const primer = deps.definition.contextPrimer ? await deps.definition.contextPrimer(ctx, row.key) : null;
        if (primer) finalPrompt = `${primer}\n\n---\n\n${prompt}`;
        await ctx.log('Previous ChatGPT conversation could not be recovered; opening a new chat with a context primer built from saved research and outputs.', 'warn');
      }
      const newChat = Boolean(options.newChat || lost);
      await createChatGPTRequest({
        task,
        stageKey: row.key,
        attempt: row.attempts,
        operationId: `${baseOp}${suffix}`,
        prompt: finalPrompt,
        newChat,
        attachments: options.attachments,
        expectImages: options.expectImages,
        expectGallery: options.expectGallery,
        // Regenerations, conversation switches and retries after a rejected/superseded answer must never "recover" an
        // older identical answer from the page (it would be the rejected one again).
        // A stage's own new chat (images) must not move the article off its conversation; a lost conversation does.
        sideChat: Boolean(options.newChat) && !lost,
        fresh:
          Boolean(options.fresh) ||
          ops.length > 0 ||
          Boolean(parseJson<Record<string, unknown>>(row.privateState, {}).regenerated) ||
          (await db.chatGPTResponse.count({ where: { taskId: task.id, stageKey: row.key, status: { in: ['REJECTED', 'SUPERSEDED'] }, operationId: { startsWith: `${task.id}:${row.key}${part}:` } } })) > 0,
        timeoutSec: deps.config.generationTimeoutSec,
        conversationSwitch: Boolean(lost),
      });
      await db.articleStage.update({ where: { id: row.id }, data: { prompt: finalPrompt, promptVersion: template.version } });
      return { status: 'waiting', prompt: finalPrompt };
    },
  };
  return ctx;
}

async function imagesFor(responseId: string): Promise<{ mediaAssetId: string }[]> {
  const assets = await db.mediaAsset.findMany({ where: { responseId }, select: { id: true } });
  return assets.map((a) => ({ mediaAssetId: a.id }));
}
