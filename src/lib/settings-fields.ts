/** UI metadata for the Settings page (client-safe). Keys mirror settingsSchema. */
export type SettingFieldType = 'boolean' | 'number' | 'text' | 'select' | 'list' | 'json';

export interface SettingField {
  key: string;
  label: string;
  type: SettingFieldType;
  help?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  warnAbove?: { value: number; message: string };
}

export interface SettingGroup {
  id: 'browser' | 'workflow' | 'content' | 'seo' | 'advanced';
  title: string;
  description: string;
  fields: SettingField[];
}

export const SETTING_GROUPS: SettingGroup[] = [
  {
    id: 'workflow',
    title: 'Workflow & throughput',
    description: 'Approvals, WordPress draft behaviour and article concurrency. Changes never rewrite tasks that already started (each task stores a configuration snapshot).',
    fields: [
      { key: 'highThroughputMode', label: 'High-Throughput Production Mode', type: 'boolean', help: 'Starts with 3 article slots and adapts between 1 and 5. Turn off for Quality/Conservative mode (1 slot).' },
      { key: 'throughputProfile', label: 'Profile', type: 'select', options: [{ value: 'throughput-first', label: 'Throughput-first' }, { value: 'quality-first', label: 'Quality-first' }], help: 'Both profiles must pass the same minimum quality gate.' },
      { key: 'taskConcurrency', label: 'Starting article slots', type: 'number', min: 1, max: 5, warnAbove: { value: 3, message: 'Higher concurrency can trigger account-wide ChatGPT rate limiting.' } },
      { key: 'adaptiveConcurrency', label: 'Adaptive concurrency', type: 'boolean', help: 'Automatically reduce slots on 429/usage limits and recover slowly when healthy.' },
      { key: 'maxTaskConcurrency', label: 'Maximum article slots', type: 'number', min: 1, max: 5, warnAbove: { value: 3, message: 'Above 3 slots ChatGPT may rate-limit the whole account.' } },
      { key: 'targetArticlesPerHour', label: 'Target verified drafts per hour', type: 'number', min: 1, max: 60, help: 'Measured objective, not a guarantee.' },
      { key: 'manualTitleApproval', label: 'Manual title approval', type: 'boolean', help: 'Pause after TITLES so you can pick or edit the title.' },
      { key: 'manualArticleApproval', label: 'Manual article approval', type: 'boolean', help: 'Pause before the WordPress draft is created.' },
      { key: 'autoSendToWordPress', label: 'Create WordPress drafts automatically', type: 'boolean', help: 'Always as drafts. Publishing requires the per-site switch and the scheduler.' },
      { key: 'createMissingCategory', label: 'Allow creating missing categories', type: 'boolean' },
      { key: 'createMissingTags', label: 'Create missing WordPress tags', type: 'boolean', help: 'Off: tags that do not exist yet are skipped with a note.' },
      { key: 'retryAttempts', label: 'Automatic retries per stage', type: 'number', min: 0, max: 10 },
      { key: 'retryBaseDelaySec', label: 'Retry base delay (s)', type: 'number', min: 1, max: 3600 },
      { key: 'retryMaxDelaySec', label: 'Retry max delay (s)', type: 'number', min: 10, max: 86400 },
      { key: 'wordpressConcurrency', label: 'Parallel WordPress sessions', type: 'number', min: 1, max: 3 },
      { key: 'imageConcurrency', label: 'Parallel image renders', type: 'number', min: 1, max: 4 },
      { key: 'uploadConcurrency', label: 'Parallel media uploads', type: 'number', min: 1, max: 3 },
    ],
  },
  {
    id: 'content',
    title: 'Content',
    description: 'Defaults for article length, FAQs, Quick Bio and language.',
    fields: [
      { key: 'maxArticleWordCount', label: 'Celebrity final article max words', type: 'number', min: 300, max: 5000 },
      { key: 'tigramWordRange', label: 'Tigram word range', type: 'text', help: 'For example 1500-2200.' },
      { key: 'faqCount', label: 'Celebrity FAQ count', type: 'number', min: 1, max: 15 },
      { key: 'tigramFaqCount', label: 'Tigram FAQ count', type: 'number', min: 3, max: 12 },
      { key: 'quickBioRows', label: 'Quick Bio rows', type: 'number', min: 6, max: 20 },
      { key: 'minKeywordOccurrences', label: 'Keyword occurrences — advisory minimum', type: 'number', min: 0, max: 100 },
      { key: 'maxKeywordOccurrences', label: 'Keyword occurrences — advisory maximum', type: 'number', min: 0, max: 100 },
      { key: 'keywordDensityCeilingPct', label: 'Keyword density warning ceiling (%)', type: 'number', min: 0.5, max: 10, step: 0.1 },
      { key: 'defaultLanguage', label: 'Default language', type: 'select', options: [{ value: 'en', label: 'English' }, { value: 'de', label: 'German' }] },
      { key: 'targetCountry', label: 'Default target country', type: 'text' },
      { key: 'humanizerEnabled', label: 'Editorial humanizer stage', type: 'boolean' },
      { key: 'humanizerBatchWords', label: 'Humanizer batch size (words)', type: 'number', min: 300, max: 3000 },
      { key: 'humanizerLengthTolerancePct', label: 'Humanizer paragraph length tolerance (±%)', type: 'number', min: 5, max: 50 },
      { key: 'humanizerScope', label: 'Humanizer paragraphs', type: 'select', options: [{ value: 'all', label: 'All eligible paragraphs' }, { value: 'flagged', label: 'Only paragraphs the local editor flagged' }] },
    ],
  },
  {
    id: 'seo',
    title: 'SEO, links & images',
    description: 'Review thresholds, Rank Math targets, link limits and image options. Image rights checks are intentionally not part of this product.',
    fields: [
      { key: 'reviewThreshold', label: 'Internal SEO review threshold', type: 'number', min: 0, max: 100 },
      { key: 'rankMathTargetScore', label: 'Rank Math target score', type: 'number', min: 0, max: 100 },
      { key: 'maxRankMathAttempts', label: 'Rank Math correction rounds', type: 'number', min: 0, max: 3 },
      {
        key: 'rankMathMode',
        label: 'Rank Math',
        type: 'select',
        options: [
          { value: 'required', label: 'Required — missing Rank Math means review' },
          { value: 'if-installed', label: 'Use when installed' },
          { value: 'off', label: 'Off — never touch Rank Math' },
        ],
      },
      { key: 'rankMathContentCorrection', label: 'Rank Math content corrections via ChatGPT', type: 'boolean', help: 'Uses the SEO_CORRECTION prompt; rewrites that add >15 % or remove >30 % words, or lose headings/links, are rejected.' },
      { key: 'externalLinks', label: 'External links', type: 'boolean' },
      { key: 'maxExternalLinks', label: 'Max external links', type: 'number', min: 0, max: 10 },
      { key: 'internalLinks', label: 'Internal links', type: 'boolean' },
      { key: 'maxContextualInternalLinks', label: 'Max contextual internal links', type: 'number', min: 0, max: 5 },
      { key: 'internalLinkIndexHours', label: 'Refresh internal link index every (hours)', type: 'number', min: 0.25, max: 168, step: 0.25 },
      { key: 'articleImages', label: 'Article images', type: 'boolean' },
      { key: 'imagesRequired', label: 'Missing images → Needs review', type: 'boolean', help: 'Off: finish a text-only draft with a review note.' },
      { key: 'imageOutputSize', label: 'Image output size', type: 'select', options: [{ value: '1200x675', label: '1200 × 675' }, { value: '1920x1080', label: '1920 × 1080' }] },
      { key: 'imageMaxBytes', label: 'Image file-size budget (bytes)', type: 'number', min: 50000, max: 5000000 },
      { key: 'enhanceCelebrityImages', label: 'Celebrity image enhancement', type: 'boolean', help: 'Requires a locally installed enhancement tool.' },
      { key: 'celebrityPhotoReview', label: 'Celebrity photo check (watermark/collage)', type: 'boolean' },
      { key: 'duplicateSimilarityReview', label: 'Duplicate similarity review threshold', type: 'number', min: 0.2, max: 1, step: 0.05 },
      { key: 'seoBriefInPrompts', label: 'Add the SEO brief to writing prompts', type: 'boolean', help: 'The article’s search intent, sections to cover and keyword guideline (SEO tab) are added to the LONG_ARTICLE / ARTICLE prompt, unless the prompt places {{seo_brief}} itself.' },
    ],
  },
  {
    id: 'browser',
    title: 'Browser',
    description: 'WordPress automation browser and ChatGPT timing. ChatGPT always runs in your visible Automation Chrome profile.',
    fields: [
      { key: 'mode', label: 'WordPress browser mode', type: 'select', options: [{ value: 'headless', label: 'Headless' }, { value: 'headed', label: 'Visible' }] },
      { key: 'navigationTimeoutSec', label: 'Navigation timeout (s)', type: 'number', min: 10, max: 300 },
      { key: 'generationTimeoutSec', label: 'ChatGPT generation timeout (s)', type: 'number', min: 60, max: 3600 },
      { key: 'screenshots', label: 'Failure screenshots', type: 'boolean' },
      { key: 'chatgptUrl', label: 'ChatGPT URL', type: 'text' },
      { key: 'chatgptTabs', label: 'ChatGPT tabs', type: 'number', min: 1, max: 5, warnAbove: { value: 3, message: 'More tabs can cause account-wide rate limiting.' } },
    ],
  },
  {
    id: 'advanced',
    title: 'Advanced',
    description: 'Leases, backoff and selector overrides.',
    fields: [
      { key: 'operationLeaseSeconds', label: 'Worker operation lease (s)', type: 'number', min: 30, max: 3600 },
      { key: 'chatgptClaimLeaseSeconds', label: 'Extension claim lease (s)', type: 'number', min: 60, max: 3600 },
      { key: 'backoffScheduleSec', label: '429 backoff schedule (s)', type: 'list', help: 'Comma-separated, e.g. 4, 30, 60, 120, 240, 300' },
      { key: 'humanCheckPauseMinutes', label: 'Login/human-check pause (min)', type: 'number', min: 0.1, max: 60, step: 0.1 },
      { key: 'composerReadyTimeoutSec', label: 'ChatGPT composer ready timeout (s)', type: 'number', min: 5, max: 300 },
      { key: 'extensionIdlePollSec', label: 'Extension idle poll (s)', type: 'number', min: 5, max: 120 },
      { key: 'extensionBusyPollSec', label: 'Extension busy poll (s)', type: 'number', min: 1, max: 30 },
      { key: 'linkCheckTimeoutSec', label: 'Link check timeout per URL (s)', type: 'number', min: 3, max: 60 },
      { key: 'diagnosticsRetentionDays', label: 'Diagnostics retention (days)', type: 'number', min: 1, max: 365 },
      { key: 'selectorOverrides', label: 'Selector overrides (JSON)', type: 'json', help: 'Map of selector key → list of CSS selectors tried first.' },
    ],
  },
];
