import type { ModuleManifest } from '../types';

/**
 * Celebrity 2 Article Writer — owner request (2026-11-04): the owner's own celebrity prompt, which returns the whole
 * article in one answer (SEO title, meta description, URL slug, introduction, a direct answer, the Family Profile
 * table, sections with source links, conclusion and five FAQs). The title step stays as in the Celebrity writer (its
 * TITLES prompt, the example title as guidance); images use the Celebrity writer's photo prompts; the category is
 * always the website's “Celebrity” (German: “Prominente”).
 */
export const celebrity2Manifest: ModuleManifest = {
  key: 'celebrity2-writer',
  name: 'Celebrity 2 Article Writer',
  shortName: 'Celebrity 2',
  description: 'Your own one-prompt celebrity article: SEO title/meta/slug, introduction, direct answer, Family Profile table, sourced sections, conclusion and five FAQs.',
  icon: 'UserPen',
  group: 'writer',
  active: true,
  exampleTitle: 'always',
  secondaryKeywordStages: ['ARTICLE'],
  highlights: [
    'Titles as in the Celebrity writer, then the whole article in one prompt',
    'Family Profile table and source links written by ChatGPT; every link is checked',
    'Exactly five short FAQs after the conclusion',
    'Category always “Celebrity” (German websites: “Prominente”)',
  ],
  stages: [
    { key: 'PRECHECK', label: 'Pre-check inputs', kind: 'local', runningStatus: 'OPENING_CHATGPT', progress: 1, dependsOn: [], checkpoint: 'PRECHECK', description: 'Validate website, the Celebrity category, language and writer before any prompt is sent.' },
    { key: 'DUPLICATE_PRECHECK', label: 'Duplicate pre-check', kind: 'local', runningStatus: 'OPENING_CHATGPT', progress: 2, dependsOn: [], checkpoint: 'DUPLICATE_PRECHECK', description: 'Compare the keyword with existing articles on this and other websites.' },
    { key: 'TITLES', label: 'Titles', kind: 'chatgpt', runningStatus: 'GENERATING_TITLES', progress: 5, dependsOn: [], prompt: { moduleKey: 'celebrity-writer', stageKey: 'TITLES' }, checkpoint: 'EXISTING_WRITER_STAGES', regenerable: true, description: 'The Celebrity writer’s title step: 6–10 title options plus a parseable "Recommended Title:" line.' },
    { key: 'TITLE_APPROVAL', label: 'Title approval', kind: 'gate', runningStatus: 'AWAITING_TITLE_APPROVAL', progress: 10, dependsOn: ['TITLES'], description: 'Optional manual approval/edit of the title. The article prompt gets this title.' },
    { key: 'CATEGORY', label: 'Category', kind: 'local', runningStatus: 'OPENING_CHATGPT', progress: 12, dependsOn: [], description: 'Always the website’s “Celebrity” category (German websites: “Prominente”).' },
    { key: 'ARTICLE', label: 'Article', kind: 'chatgpt', runningStatus: 'WRITING_ARTICLE', progress: 15, dependsOn: ['TITLE_APPROVAL'], prompt: { moduleKey: 'celebrity2-writer', stageKey: 'ARTICLE' }, checkpoint: 'EXISTING_WRITER_STAGES', regenerable: true, description: 'The whole article in one answer: SEO title, meta description, URL slug, Family Profile table, sections, conclusion and five FAQs.' },
    { key: 'EXTERNAL_LINKS', label: 'Link check', kind: 'local', runningStatus: 'LINKING', progress: 55, dependsOn: ['ARTICLE'], regenerable: true, description: 'Every source link of the article is opened and checked (reachable, on-topic, safe); a failing link becomes plain text.' },
    { key: 'INTERNAL_LINKS', label: 'Internal links', kind: 'local', runningStatus: 'LINKING', progress: 60, dependsOn: ['ARTICLE'], checkpoint: 'INTERNAL_LINKS', regenerable: true, description: 'Relevant existing posts of the same site and the final “Also read” line.' },
    { key: 'IMAGES', label: 'Images', kind: 'local', runningStatus: 'PROCESSING_IMAGES', progress: 66, dependsOn: ['TITLE_APPROVAL'], checkpoint: 'IMAGE_STUDIO', regenerable: true, description: 'Celebrity photos as in the Celebrity writer: featured + two body images; degrades safely when unavailable.' },
    { key: 'HUMANIZE', label: 'Editorial humanizer', kind: 'chatgpt', runningStatus: 'HUMANIZING', progress: 74, dependsOn: ['EXTERNAL_LINKS'], prompt: { moduleKey: 'shared', stageKey: 'HUMANIZE' }, regenerable: true, description: 'Paragraph-level polish with fact locks (when switched on for the website).' },
    { key: 'ASSEMBLY', label: 'Assembly', kind: 'local', runningStatus: 'ASSEMBLING', progress: 82, dependsOn: ['HUMANIZE', 'INTERNAL_LINKS', 'IMAGES'], regenerable: true, description: 'The article in ChatGPT’s order (… conclusion, then the FAQs), images placed, one internal-link line; sanitized HTML.' },
    { key: 'SEO_CHECK', label: 'SEO check', kind: 'local', runningStatus: 'SEO_CHECKING', progress: 86, dependsOn: ['ASSEMBLY'], description: 'Transparent weighted on-page checks with fix suggestions.' },
    { key: 'QUALITY_GATE', label: 'Quality gate', kind: 'gate', runningStatus: 'QUALITY_CHECKING', progress: 88, dependsOn: ['SEO_CHECK'], checkpoint: 'QUALITY_GATE', description: 'Hard stops pause before WordPress; soft issues become review reasons.' },
    { key: 'ARTICLE_APPROVAL', label: 'Article approval', kind: 'gate', runningStatus: 'AWAITING_ARTICLE_APPROVAL', progress: 90, dependsOn: ['QUALITY_GATE'], description: 'Optional manual approval before the WordPress draft.' },
    { key: 'WORDPRESS_DRAFT', label: 'WordPress draft', kind: 'wordpress', runningStatus: 'CREATING_DRAFT', progress: 93, dependsOn: ['ARTICLE_APPROVAL'], checkpoint: 'WORDPRESS_DRAFT', description: 'Create or reopen exactly one draft; verify save, category, slug and metadata.' },
    { key: 'RANKMATH', label: 'Rank Math', kind: 'wordpress', runningStatus: 'RUNNING_RANKMATH', progress: 97, dependsOn: ['WORDPRESS_DRAFT'], checkpoint: 'RANKMATH', description: 'Verify Rank Math fields and read the real score; bounded safe corrections.' },
    { key: 'VERIFIED_COMPLETE', label: 'Verified complete', kind: 'local', runningStatus: 'QUALITY_CHECKING', progress: 99, dependsOn: ['RANKMATH'], checkpoint: 'VERIFIED_COMPLETE', description: 'Count the article only with a verified draft and passed validations.' },
  ],
};
