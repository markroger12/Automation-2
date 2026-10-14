import type { ModuleManifest } from '../types';

/**
 * Celebrity Article Writer — the original Celebrity Writer 1.0 pipeline
 * (internal key "celebrity-writer" preserved) with the 3.0 checkpoints.
 * Six original writing prompts in order: TITLES, RESEARCH, LONG_ARTICLE,
 * FINAL_ARTICLE, FAQS, QUICK_BIO — never replaced by one composite prompt.
 */
export const celebrityManifest: ModuleManifest = {
  key: 'celebrity-writer',
  name: 'Celebrity Article Writer',
  shortName: 'Celebrity',
  description: 'Research-led biographies of public figures: titles, research, long draft, polished final article, FAQs and a two-column Quick Bio.',
  icon: 'UserRound',
  group: 'writer',
  active: true,
  exampleTitle: 'always',
  secondaryKeywordStages: ['LONG_ARTICLE'],
  highlights: [
    'Original 1.0 six-prompt workflow in one ChatGPT conversation',
    'Example title used as guidance in TITLES only',
    'Exactly N FAQs (default 5) and an 11–13 row two-column Quick Bio',
    'Never invents birth dates, partners, children, height or net worth',
  ],
  stages: [
    { key: 'PRECHECK', label: 'Pre-check inputs', kind: 'local', runningStatus: 'OPENING_CHATGPT', progress: 1, dependsOn: [], checkpoint: 'PRECHECK', description: 'Validate website, category, language and writer before any prompt is sent.' },
    { key: 'DUPLICATE_PRECHECK', label: 'Duplicate pre-check', kind: 'local', runningStatus: 'OPENING_CHATGPT', progress: 2, dependsOn: [], checkpoint: 'DUPLICATE_PRECHECK', description: 'Compare the keyword with existing articles on this and other websites.' },
    { key: 'TITLES', label: 'Titles', kind: 'chatgpt', runningStatus: 'GENERATING_TITLES', progress: 5, dependsOn: [], prompt: { moduleKey: 'celebrity-writer', stageKey: 'TITLES' }, checkpoint: 'EXISTING_WRITER_STAGES', regenerable: true, description: '6–10 title options plus a parseable "Recommended Title:" line.' },
    { key: 'TITLE_APPROVAL', label: 'Title approval', kind: 'gate', runningStatus: 'AWAITING_TITLE_APPROVAL', progress: 10, dependsOn: ['TITLES'], description: 'Optional manual approval/edit of the title.' },
    { key: 'RESEARCH', label: 'Research', kind: 'chatgpt', runningStatus: 'RESEARCHING', progress: 15, dependsOn: ['TITLE_APPROVAL'], prompt: { moduleKey: 'celebrity-writer', stageKey: 'RESEARCH' }, checkpoint: 'EXISTING_WRITER_STAGES', regenerable: true, description: 'Organized, source-aware research notes, stored separately from the article.' },
    { key: 'RESEARCH_EVIDENCE', label: 'Research evidence', kind: 'local', runningStatus: 'RESEARCHING', progress: 22, dependsOn: ['RESEARCH'], checkpoint: 'RESEARCH_EVIDENCE', description: 'Record cited sources, uncertainty and estimates in the evidence ledger.' },
    { key: 'LONG_ARTICLE', label: 'Long article', kind: 'chatgpt', runningStatus: 'WRITING_ARTICLE', progress: 28, dependsOn: ['RESEARCH'], prompt: { moduleKey: 'celebrity-writer', stageKey: 'LONG_ARTICLE' }, checkpoint: 'EXISTING_WRITER_STAGES', regenerable: true, description: '1,500–2,000 word draft with H2/H3 headings; secondary keywords where natural.' },
    { key: 'FINAL_ARTICLE', label: 'Final article', kind: 'chatgpt', runningStatus: 'OPTIMIZING', progress: 40, dependsOn: ['LONG_ARTICLE'], prompt: { moduleKey: 'celebrity-writer', stageKey: 'FINAL_ARTICLE' }, checkpoint: 'EXISTING_WRITER_STAGES', regenerable: true, description: 'Polished article within the configured maximum (default 1,300 words).' },
    { key: 'FAQS', label: 'FAQs', kind: 'chatgpt', runningStatus: 'GENERATING_FAQS', progress: 50, dependsOn: ['FINAL_ARTICLE'], prompt: { moduleKey: 'celebrity-writer', stageKey: 'FAQS' }, checkpoint: 'EXISTING_WRITER_STAGES', regenerable: true, description: 'Exactly the configured number of QUESTION/ANSWER pairs.' },
    { key: 'QUICK_BIO', label: 'Quick Bio', kind: 'chatgpt', runningStatus: 'GENERATING_BIO_TABLE', progress: 56, dependsOn: ['RESEARCH'], prompt: { moduleKey: 'celebrity-writer', stageKey: 'QUICK_BIO' }, checkpoint: 'EXISTING_WRITER_STAGES', regenerable: true, description: 'Two-column Attribute | Details HTML table (~11–13 rows).' },
    { key: 'EXTERNAL_LINKS', label: 'External links', kind: 'chatgpt', runningStatus: 'LINKING', progress: 62, dependsOn: ['FINAL_ARTICLE'], prompt: { moduleKey: 'shared', stageKey: 'EXTERNAL_LINKS' }, regenerable: true, description: 'Candidate links, each verified (reachable, on-topic, SSRF-safe) before insertion.' },
    { key: 'INTERNAL_LINKS', label: 'Internal links', kind: 'local', runningStatus: 'LINKING', progress: 66, dependsOn: ['FINAL_ARTICLE'], checkpoint: 'INTERNAL_LINKS', regenerable: true, description: 'Relevant existing posts of the same site and the final “Also read” line.' },
    { key: 'IMAGES', label: 'Images', kind: 'local', runningStatus: 'PROCESSING_IMAGES', progress: 70, dependsOn: ['TITLE_APPROVAL'], checkpoint: 'IMAGE_STUDIO', regenerable: true, description: 'Optional featured + two body images; degrades safely when unavailable.' },
    { key: 'HUMANIZE', label: 'Editorial humanizer', kind: 'chatgpt', runningStatus: 'HUMANIZING', progress: 76, dependsOn: ['EXTERNAL_LINKS'], prompt: { moduleKey: 'shared', stageKey: 'HUMANIZE' }, regenerable: true, description: 'Paragraph-level polish with fact locks; rejected rewrites keep the original.' },
    { key: 'ASSEMBLY', label: 'Assembly', kind: 'local', runningStatus: 'ASSEMBLING', progress: 82, dependsOn: ['HUMANIZE', 'FAQS', 'QUICK_BIO', 'INTERNAL_LINKS', 'IMAGES'], regenerable: true, description: 'Intro → Quick Bio → body → FAQs → conclusion → one internal-link line; sanitized HTML.' },
    { key: 'SEO_CHECK', label: 'SEO check', kind: 'local', runningStatus: 'SEO_CHECKING', progress: 86, dependsOn: ['ASSEMBLY'], description: 'Transparent weighted on-page checks with fix suggestions.' },
    { key: 'QUALITY_GATE', label: 'Quality gate', kind: 'gate', runningStatus: 'QUALITY_CHECKING', progress: 88, dependsOn: ['SEO_CHECK'], checkpoint: 'QUALITY_GATE', description: 'Hard stops pause before WordPress; soft issues become review reasons.' },
    { key: 'ARTICLE_APPROVAL', label: 'Article approval', kind: 'gate', runningStatus: 'AWAITING_ARTICLE_APPROVAL', progress: 90, dependsOn: ['QUALITY_GATE'], description: 'Optional manual approval before the WordPress draft.' },
    { key: 'WORDPRESS_DRAFT', label: 'WordPress draft', kind: 'wordpress', runningStatus: 'CREATING_DRAFT', progress: 93, dependsOn: ['ARTICLE_APPROVAL'], checkpoint: 'WORDPRESS_DRAFT', description: 'Create or reopen exactly one draft; verify save, category, slug and metadata.' },
    { key: 'RANKMATH', label: 'Rank Math', kind: 'wordpress', runningStatus: 'RUNNING_RANKMATH', progress: 97, dependsOn: ['WORDPRESS_DRAFT'], checkpoint: 'RANKMATH', description: 'Verify Rank Math fields and read the real score; bounded safe corrections.' },
    { key: 'VERIFIED_COMPLETE', label: 'Verified complete', kind: 'local', runningStatus: 'QUALITY_CHECKING', progress: 99, dependsOn: ['RANKMATH'], checkpoint: 'VERIFIED_COMPLETE', description: 'Count the article only with a verified draft and passed validations.' },
  ],
};
