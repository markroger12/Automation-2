import { z } from 'zod';

/**
 * The single shared settings schema (client-safe). Server code persists the
 * parsed value in Setting("global"); site overrides are partial copies of the
 * content/seo/workflow groups stored on Website.settingsOverrides.
 */

export const SETTINGS_SCHEMA_VERSION = 1;

export const browserSettingsSchema = z.object({
  mode: z.enum(['headless', 'headed']).default('headless'),
  navigationTimeoutSec: z.number().int().min(10).max(300).default(60),
  generationTimeoutSec: z.number().int().min(60).max(3600).default(600),
  screenshots: z.boolean().default(true),
  chatgptUrl: z.url().default('https://chatgpt.com/'),
  chatgptChromeMode: z.enum(['separate']).default('separate'),
  chatgptTabs: z.number().int().min(1).max(5).default(3),
  /** Open Automation Chrome by itself when ChatGPT work is queued and the extension is not connected (owner request). */
  autoLaunchChatGPTChrome: z.boolean().default(true),
  /** Close the Automation Chrome the worker opened by itself once no article work is left (2 minutes idle). */
  autoCloseChatGPTChrome: z.boolean().default(true),
});

export const workflowSettingsSchema = z.object({
  manualTitleApproval: z.boolean().default(false),
  manualArticleApproval: z.boolean().default(false),
  /**
   * Off (owner decision): review reasons never hold an article. They are kept as notes, the draft is saved and the
   * article completes. A draft with a hard stop is still saved but never published automatically by a workflow.
   */
  holdForReview: z.boolean().default(false),
  autoSendToWordPress: z.boolean().default(true),
  createMissingCategory: z.boolean().default(false),
  createMissingTags: z.boolean().default(true),
  taskConcurrency: z.number().int().min(1).max(5).default(3),
  adaptiveConcurrency: z.boolean().default(true),
  maxTaskConcurrency: z.number().int().min(1).max(5).default(5),
  targetArticlesPerHour: z.number().min(1).max(60).default(6),
  highThroughputMode: z.boolean().default(true),
  throughputProfile: z.enum(['throughput-first', 'quality-first']).default('throughput-first'),
  retryAttempts: z.number().int().min(0).max(10).default(2),
  retryBaseDelaySec: z.number().int().min(1).max(3600).default(30),
  retryMaxDelaySec: z.number().int().min(10).max(86400).default(900),
  workflowCelebrityWriter: z.enum(['1.0']).default('1.0'),
  wordpressConcurrency: z.number().int().min(1).max(3).default(1),
  imageConcurrency: z.number().int().min(1).max(4).default(2),
  uploadConcurrency: z.number().int().min(1).max(3).default(1),
});

export const contentSettingsSchema = z.object({
  maxArticleWordCount: z.number().int().min(300).max(5000).default(1300),
  minKeywordOccurrences: z.number().int().min(0).max(100).default(15),
  maxKeywordOccurrences: z.number().int().min(0).max(100).default(18),
  keywordDensityCeilingPct: z.number().min(0.5).max(10).default(2.5),
  faqCount: z.number().int().min(1).max(15).default(5),
  quickBioRows: z.number().int().min(6).max(20).default(12),
  defaultLanguage: z.enum(['en', 'de']).default('en'),
  targetCountry: z.string().min(2).max(56).default('United States'),
  tigramWordRange: z.string().regex(/^\d{3,4}\s*[-–]\s*\d{3,4}$/).default('1500-2200'),
  tigramFaqCount: z.number().int().min(3).max(12).default(7),
  /** Off by default (owner decision, 2026-10-21); a website can switch it on (website settings → Humanizer). */
  humanizerEnabled: z.boolean().default(false),
  humanizerBatchWords: z.number().int().min(300).max(3000).default(1200),
  humanizerLengthTolerancePct: z.number().int().min(5).max(50).default(20),
  /** all = every eligible paragraph (spec default); flagged = only paragraphs the local editor flagged (fewer ChatGPT prompts). */
  humanizerScope: z.enum(['all', 'flagged']).default('all'),
  /** Show every link in the article in bold (owner request): the link text is wrapped in <strong>. */
  boldLinks: z.boolean().default(true),
});

export const seoSettingsSchema = z.object({
  reviewThreshold: z.number().int().min(0).max(100).default(70),
  rankMathTargetScore: z.number().int().min(0).max(100).default(75),
  maxRankMathAttempts: z.number().int().min(0).max(3).default(3),
  /** required: a site without Rank Math ends in review; if-installed: skipped when absent; off: never touched. */
  rankMathMode: z.enum(['required', 'if-installed', 'off']).default('required'),
  /** Allow the editable SEO_CORRECTION prompt (fact-preserving, guarded) when local fixes are not enough. */
  rankMathContentCorrection: z.boolean().default(true),
  externalLinks: z.boolean().default(true),
  maxExternalLinks: z.number().int().min(0).max(10).default(5),
  internalLinks: z.boolean().default(true),
  maxContextualInternalLinks: z.number().int().min(0).max(5).default(2),
  /** Re-read published posts for internal linking at most this often (hours). */
  internalLinkIndexHours: z.number().min(0.25).max(168).default(6),
  /**
   * The article's last-line internal link ("Das könnte Ihnen gefallen: …"): the previous article this app wrote for
   * the same website (as in the owner's earlier tool), or the site's most related published post.
   */
  internalLinkLineTarget: z.enum(['previous-article', 'most-related']).default('previous-article'),
  articleImages: z.boolean().default(true),
  imagesRequired: z.boolean().default(false),
  imageOutputSize: z.enum(['1200x675', '1920x1080']).default('1200x675'),
  imageMaxBytes: z.number().int().min(50_000).max(5_000_000).default(350_000),
  enhanceCelebrityImages: z.boolean().default(true),
  celebrityPhotoReview: z.boolean().default(false),
  /**
   * Where celebrity photos come from (after the owner's own uploads): ChatGPT's image-search gallery through the
   * extension (as in the owner's earlier tool), Wikimedia Commons, or the gallery first with Commons as a fallback.
   */
  celebrityPhotoSource: z.enum(['chatgpt', 'commons', 'chatgpt-then-commons']).default('chatgpt'),
  duplicateSimilarityReview: z.number().min(0.2).max(1).default(0.45),
  /** Add the article's SEO brief (search intent, sections, keyword guideline) to the writing prompt. */
  seoBriefInPrompts: z.boolean().default(true),
});

export const advancedSettingsSchema = z.object({
  selectorOverrides: z.record(z.string(), z.array(z.string().max(500)).max(10)).default({}),
  diagnosticsRetentionDays: z.number().int().min(1).max(365).default(30),
  operationLeaseSeconds: z.number().int().min(30).max(3600).default(120),
  chatgptClaimLeaseSeconds: z.number().int().min(60).max(3600).default(180),
  backoffScheduleSec: z.array(z.number().int().min(1).max(3600)).min(1).max(12).default([4, 30, 60, 120, 240, 300]),
  humanCheckPauseMinutes: z.number().min(0.1).max(60).default(10),
  composerReadyTimeoutSec: z.number().int().min(5).max(300).default(60),
  extensionIdlePollSec: z.number().int().min(5).max(120).default(30),
  extensionBusyPollSec: z.number().int().min(1).max(30).default(3),
  linkCheckTimeoutSec: z.number().int().min(3).max(60).default(10),
});

export const settingsSchema = z.object({
  browser: browserSettingsSchema.prefault({}),
  workflow: workflowSettingsSchema.prefault({}),
  content: contentSettingsSchema.prefault({}),
  seo: seoSettingsSchema.prefault({}),
  advanced: advancedSettingsSchema.prefault({}),
});

export type Settings = z.output<typeof settingsSchema>;
export type SettingsInput = z.input<typeof settingsSchema>;

export const defaultSettings = (): Settings => settingsSchema.parse({});

type Undefault<T> = T extends z.ZodDefault<infer I> ? I : T;

/**
 * Optional copies of the given fields WITHOUT their defaults: an unset site
 * value must stay unset so the global setting applies (Zod 4 applies a
 * field's default even inside .partial(), which silently pinned every site to
 * the shipped defaults).
 */
function overridable<S extends z.ZodRawShape, K extends keyof S & string>(shape: S, keys: readonly K[]) {
  const out = {} as { [P in K]: z.ZodOptional<Undefault<S[P]>> };
  for (const k of keys) {
    const field = shape[k] as unknown as z.ZodType;
    (out as Record<string, z.ZodType>)[k] = (field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : field).optional();
  }
  return z.object(out);
}

export const SITE_OVERRIDE_KEYS = {
  content: ['maxArticleWordCount', 'faqCount', 'quickBioRows', 'tigramWordRange', 'humanizerEnabled'],
  seo: ['reviewThreshold', 'rankMathTargetScore', 'rankMathMode', 'externalLinks', 'maxExternalLinks', 'internalLinks', 'articleImages', 'imagesRequired', 'imageOutputSize'],
  workflow: ['manualTitleApproval', 'manualArticleApproval', 'holdForReview', 'autoSendToWordPress', 'createMissingCategory'],
} as const;

/** Per-site overrides: only content/seo/workflow keys that make sense per site. Unset = use the global setting. */
export const siteOverridesSchema = z.object({
  content: overridable(contentSettingsSchema.shape, SITE_OVERRIDE_KEYS.content).prefault({}),
  seo: overridable(seoSettingsSchema.shape, SITE_OVERRIDE_KEYS.seo).prefault({}),
  workflow: overridable(workflowSettingsSchema.shape, SITE_OVERRIDE_KEYS.workflow).prefault({}),
});
export type SiteOverrides = z.output<typeof siteOverridesSchema>;

/** Advanced Single Article / bulk task options; undefined means "inherit". */
export const taskOptionsSchema = z.object({
  maxWords: z.number().int().min(300).max(5000).optional(),
  faqCount: z.number().int().min(1).max(15).optional(),
  quickBioRows: z.number().int().min(6).max(20).optional(),
  images: z.enum(['site', 'on', 'off']).default('site'),
  manualTitleApproval: z.boolean().optional(),
  manualArticleApproval: z.boolean().optional(),
  holdForReview: z.boolean().optional(),
  reviewThreshold: z.number().int().min(0).max(100).optional(),
  rankMathTargetScore: z.number().int().min(0).max(100).optional(),
  externalLinks: z.boolean().optional(),
  internalLinks: z.boolean().optional(),
  saveToWordPress: z.boolean().default(true),
});
export type TaskOptions = z.output<typeof taskOptionsSchema>;

/** Effective configuration frozen into ArticleTask.configSnapshot at start. */
export interface EffectiveTaskConfig {
  maxWords: number;
  faqCount: number;
  quickBioRows: number;
  tigramWordRange: string;
  tigramFaqCount: number;
  minKeywordOccurrences: number;
  maxKeywordOccurrences: number;
  keywordDensityCeilingPct: number;
  images: boolean;
  imagesRequired: boolean;
  imageOutputSize: '1200x675' | '1920x1080';
  imageMaxBytes: number;
  celebrityPhotoReview: boolean;
  celebrityPhotoSource: 'chatgpt' | 'commons' | 'chatgpt-then-commons';
  internalLinkLineTarget: 'previous-article' | 'most-related';
  manualTitleApproval: boolean;
  manualArticleApproval: boolean;
  holdForReview: boolean;
  reviewThreshold: number;
  rankMathTargetScore: number;
  maxRankMathAttempts: number;
  rankMathMode: 'required' | 'if-installed' | 'off';
  rankMathContentCorrection: boolean;
  externalLinks: boolean;
  maxExternalLinks: number;
  internalLinks: boolean;
  maxContextualInternalLinks: number;
  saveToWordPress: boolean;
  humanizerEnabled: boolean;
  humanizerBatchWords: number;
  humanizerLengthTolerancePct: number;
  humanizerScope: 'all' | 'flagged';
  createMissingCategory: boolean;
  createMissingTags: boolean;
  duplicateSimilarityReview: number;
  retryAttempts: number;
  generationTimeoutSec: number;
}

export function effectiveTaskConfig(global: Settings, site: SiteOverrides, options: TaskOptions): EffectiveTaskConfig {
  const pick = <T,>(...values: (T | undefined)[]): T => values.find((v) => v !== undefined) as T;
  const siteImages = pick(site.seo.articleImages, global.seo.articleImages);
  return {
    maxWords: pick(options.maxWords, site.content.maxArticleWordCount, global.content.maxArticleWordCount),
    faqCount: pick(options.faqCount, site.content.faqCount, global.content.faqCount),
    quickBioRows: pick(options.quickBioRows, site.content.quickBioRows, global.content.quickBioRows),
    tigramWordRange: pick(site.content.tigramWordRange, global.content.tigramWordRange),
    tigramFaqCount: global.content.tigramFaqCount,
    minKeywordOccurrences: global.content.minKeywordOccurrences,
    maxKeywordOccurrences: global.content.maxKeywordOccurrences,
    keywordDensityCeilingPct: global.content.keywordDensityCeilingPct,
    images: options.images === 'site' ? siteImages : options.images === 'on',
    imagesRequired: pick(site.seo.imagesRequired, global.seo.imagesRequired),
    imageOutputSize: pick(site.seo.imageOutputSize, global.seo.imageOutputSize),
    imageMaxBytes: global.seo.imageMaxBytes,
    celebrityPhotoReview: global.seo.celebrityPhotoReview,
    celebrityPhotoSource: global.seo.celebrityPhotoSource,
    internalLinkLineTarget: global.seo.internalLinkLineTarget,
    manualTitleApproval: pick(options.manualTitleApproval, site.workflow.manualTitleApproval, global.workflow.manualTitleApproval),
    manualArticleApproval: pick(options.manualArticleApproval, site.workflow.manualArticleApproval, global.workflow.manualArticleApproval),
    holdForReview: pick(options.holdForReview, site.workflow.holdForReview, global.workflow.holdForReview),
    reviewThreshold: pick(options.reviewThreshold, site.seo.reviewThreshold, global.seo.reviewThreshold),
    rankMathTargetScore: pick(options.rankMathTargetScore, site.seo.rankMathTargetScore, global.seo.rankMathTargetScore),
    maxRankMathAttempts: global.seo.maxRankMathAttempts,
    rankMathMode: pick(site.seo.rankMathMode, global.seo.rankMathMode),
    rankMathContentCorrection: global.seo.rankMathContentCorrection,
    externalLinks: pick(options.externalLinks, site.seo.externalLinks, global.seo.externalLinks),
    maxExternalLinks: pick(site.seo.maxExternalLinks, global.seo.maxExternalLinks),
    internalLinks: pick(options.internalLinks, site.seo.internalLinks, global.seo.internalLinks),
    maxContextualInternalLinks: global.seo.maxContextualInternalLinks,
    saveToWordPress: options.saveToWordPress && pick(site.workflow.autoSendToWordPress, global.workflow.autoSendToWordPress),
    humanizerEnabled: pick(site.content.humanizerEnabled, global.content.humanizerEnabled),
    humanizerBatchWords: global.content.humanizerBatchWords,
    humanizerLengthTolerancePct: global.content.humanizerLengthTolerancePct,
    humanizerScope: global.content.humanizerScope,
    createMissingCategory: pick(site.workflow.createMissingCategory, global.workflow.createMissingCategory),
    createMissingTags: global.workflow.createMissingTags,
    duplicateSimilarityReview: global.seo.duplicateSimilarityReview,
    retryAttempts: global.workflow.retryAttempts,
    generationTimeoutSec: global.browser.generationTimeoutSec,
  };
}
