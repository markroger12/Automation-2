import type { ArticleStage, ArticleTask, Website } from '@prisma/client';
import type { TaskStatus } from '@/lib/domain';
import type { EffectiveTaskConfig } from '@/lib/settings-schema';
import type { TemplateVars } from '@/lib/prompts/template';
import type { ModuleManifest, StageManifest } from '@/modules/types';

export type StageResult =
  | { outcome: 'completed'; prompt?: string; output?: string; outputHtml?: string; data?: unknown; message?: string }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'paused'; status: TaskStatus; message: string; nextAction?: string }
  | { outcome: 'waiting'; message: string; wakeAt?: Date };

export interface ChatGPTAttachment {
  mediaAssetId: string;
  name: string;
  mime: string;
}

export interface AskOptions {
  /** Start a fresh ChatGPT conversation (e.g. unrelated image work). */
  newChat?: boolean;
  /** Force a new prompt even if a valid earlier response exists. */
  fresh?: boolean;
  attachments?: ChatGPTAttachment[];
  expectImages?: boolean;
  /** Image search: the extension also saves the picture gallery ChatGPT shows with its answer. */
  expectGallery?: boolean;
  /** Distinguishes several prompts within one stage (e.g. humanizer batches). */
  part?: string;
}

export type ChatGPTOutcome =
  | {
      status: 'completed';
      responseId: string;
      text: string;
      html: string | null;
      conversationUrl: string | null;
      prompt: string;
      reused: boolean;
      images: { mediaAssetId: string }[];
      /** Gallery pictures the extension could not download itself (image search). */
      imageLinks: { url: string; width?: number; height?: number }[];
    }
  | { status: 'waiting'; prompt: string };

export interface PipelineContext {
  readonly taskId: string;
  task: ArticleTask;
  website: Website;
  config: EffectiveTaskConfig;
  stage: ArticleStage;
  manifest: StageManifest;
  workerId: string;
  signal: AbortSignal;
  /** Completed/skipped stage rows by key (outputs of earlier stages). */
  stages: Map<string, ArticleStage>;
  log(message: string, level?: 'debug' | 'info' | 'warn' | 'error', details?: unknown): Promise<void>;
  progress(message: string, percent?: number): Promise<void>;
  checkCancelled(): Promise<void>;
  /** Update task fields with optimistic version increment. */
  updateTask(data: Partial<Omit<ArticleTask, 'id' | 'version'>>): Promise<ArticleTask>;
  setPrivateState(state: Record<string, unknown>): Promise<void>;
  privateState<T extends Record<string, unknown>>(): T;
  stageOutput(key: string): string | null;
  stageJson<T>(key: string): T | null;
  askChatGPT(promptStageKey: string, extra?: TemplateVars, options?: AskOptions): Promise<ChatGPTOutcome>;
  /** Mark a ChatGPT response as unusable so a retry sends a fresh prompt. */
  rejectResponse(responseId: string, reason: string): Promise<void>;
}

export interface PipelineStage extends StageManifest {
  /** Optional: return false to SKIP without running (e.g. images disabled). */
  shouldRun?(ctx: PipelineContext): boolean | Promise<boolean>;
  run(ctx: PipelineContext): Promise<StageResult>;
}

export interface PipelineDefinition {
  moduleKey: string;
  manifest: ModuleManifest;
  stages: PipelineStage[];
  regenerationPlan(stageKey: string, task: ArticleTask): string[];
  /** Template variables for prompts of this module. */
  variables(ctx: PipelineContext, extra?: TemplateVars): TemplateVars;
  /** Source-faithful primer used when a conversation must be replaced. */
  contextPrimer?(ctx: PipelineContext, stageKey: string): Promise<string | null>;
  /** Called after every stage completed/skipped; decides the final status. */
  finalize(ctx: PipelineContext): Promise<void>;
  afterRegeneration?(ctx: PipelineContext, stageKey: string): Promise<void>;
}
