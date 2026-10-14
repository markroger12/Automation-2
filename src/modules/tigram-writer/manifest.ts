import type { ModuleManifest } from '../types';

/**
 * Tigram Article Writer — general topics (software, tools, games, apps,
 * how-to, explainers). Never routed through celebrity biography, fact-field
 * or Quick Bio prompts.
 */
export const tigramManifest: ModuleManifest = {
  key: 'tigram-writer',
  name: 'Tigram Article Writer',
  shortName: 'Tigram',
  description: 'General SEO articles: machine-readable SEO title/meta/slug, hook intro, direct answer, 5–7 H2 sections, steps, comparison table, H3 FAQs and a conclusion.',
  icon: 'Newspaper',
  group: 'writer',
  active: true,
  exampleTitle: 'if-template-variable',
  secondaryKeywordStages: ['ARTICLE'],
  highlights: [
    'Starts with SEO TITLE / META DESCRIPTION / URL SLUG lines',
    'Picks exactly one EXISTING category (never invents one)',
    'Seven H3 FAQs under an H2 FAQ heading by default',
    'Example title used only if the saved ARTICLE template has {{example_title}}',
  ],
  stages: [
    { key: 'PRECHECK', label: 'Pre-check inputs', kind: 'local', runningStatus: 'OPENING_CHATGPT', progress: 1, dependsOn: [], checkpoint: 'PRECHECK', description: 'Validate website, category, language and writer before any prompt is sent.' },
    { key: 'DUPLICATE_PRECHECK', label: 'Duplicate pre-check', kind: 'local', runningStatus: 'OPENING_CHATGPT', progress: 2, dependsOn: [], checkpoint: 'DUPLICATE_PRECHECK', description: 'Compare the keyword with existing articles on this and other websites.' },
    { key: 'ARTICLE', label: 'Article', kind: 'chatgpt', runningStatus: 'WRITING_ARTICLE', progress: 10, dependsOn: [], prompt: { moduleKey: 'tigram-writer', stageKey: 'ARTICLE' }, checkpoint: 'EXISTING_WRITER_STAGES', regenerable: true, description: 'Full article with SEO TITLE / META DESCRIPTION / URL SLUG lines first.' },
    { key: 'CATEGORY', label: 'Category', kind: 'chatgpt', runningStatus: 'OPTIMIZING', progress: 40, dependsOn: ['ARTICLE'], prompt: { moduleKey: 'tigram-writer', stageKey: 'CATEGORY' }, regenerable: true, description: 'Exactly one existing synchronized category (skipped when you chose one).' },
    { key: 'EXTERNAL_LINKS', label: 'External links', kind: 'chatgpt', runningStatus: 'LINKING', progress: 55, dependsOn: ['ARTICLE'], prompt: { moduleKey: 'shared', stageKey: 'EXTERNAL_LINKS' }, regenerable: true, description: 'Candidate links, each verified before insertion.' },
    { key: 'INTERNAL_LINKS', label: 'Internal links', kind: 'local', runningStatus: 'LINKING', progress: 60, dependsOn: ['ARTICLE'], checkpoint: 'INTERNAL_LINKS', regenerable: true, description: 'Relevant existing posts and the final “Also read” line.' },
    { key: 'IMAGES', label: 'Images', kind: 'local', runningStatus: 'PROCESSING_IMAGES', progress: 66, dependsOn: ['ARTICLE'], checkpoint: 'IMAGE_STUDIO', regenerable: true, description: 'Image plan, featured + two body images; degrades safely.' },
    { key: 'HUMANIZE', label: 'Editorial humanizer', kind: 'chatgpt', runningStatus: 'HUMANIZING', progress: 74, dependsOn: ['EXTERNAL_LINKS'], prompt: { moduleKey: 'shared', stageKey: 'HUMANIZE' }, regenerable: true, description: 'Paragraph-level polish with fact locks.' },
    { key: 'ASSEMBLY', label: 'Assembly', kind: 'local', runningStatus: 'ASSEMBLING', progress: 82, dependsOn: ['HUMANIZE', 'CATEGORY', 'INTERNAL_LINKS', 'IMAGES'], regenerable: true, description: 'Sanitized HTML with tables, FAQ section, conclusion and one internal-link line.' },
    { key: 'SEO_CHECK', label: 'SEO check', kind: 'local', runningStatus: 'SEO_CHECKING', progress: 86, dependsOn: ['ASSEMBLY'], description: 'Transparent weighted on-page checks; template deviations recorded.' },
    { key: 'QUALITY_GATE', label: 'Quality gate', kind: 'gate', runningStatus: 'QUALITY_CHECKING', progress: 88, dependsOn: ['SEO_CHECK'], checkpoint: 'QUALITY_GATE', description: 'Hard stops pause before WordPress; soft issues become review reasons.' },
    { key: 'ARTICLE_APPROVAL', label: 'Article approval', kind: 'gate', runningStatus: 'AWAITING_ARTICLE_APPROVAL', progress: 90, dependsOn: ['QUALITY_GATE'], description: 'Optional manual approval before the WordPress draft.' },
    { key: 'WORDPRESS_DRAFT', label: 'WordPress draft', kind: 'wordpress', runningStatus: 'CREATING_DRAFT', progress: 93, dependsOn: ['ARTICLE_APPROVAL'], checkpoint: 'WORDPRESS_DRAFT', description: 'Create or reopen exactly one draft and verify it.' },
    { key: 'RANKMATH', label: 'Rank Math', kind: 'wordpress', runningStatus: 'RUNNING_RANKMATH', progress: 97, dependsOn: ['WORDPRESS_DRAFT'], checkpoint: 'RANKMATH', description: 'Verify Rank Math fields and read the real score.' },
    { key: 'VERIFIED_COMPLETE', label: 'Verified complete', kind: 'local', runningStatus: 'QUALITY_CHECKING', progress: 99, dependsOn: ['RANKMATH'], checkpoint: 'VERIFIED_COMPLETE', description: 'Count the article only with a verified draft and passed validations.' },
  ],
};
