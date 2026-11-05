import type { CustomWriterInfo } from '@/lib/writers/types';
import type { ModuleManifest, StageManifest } from '../types';

/**
 * The steps of a writer the owner built in the app (client-safe). The same steps as Celebrity 2 — the whole article
 * in one answer to the owner's prompt — and the writer's settings decide which of them run (a skipped step shows as
 * skipped): the title step, the link check, photos. Person writers use the celebrity photo steps; general writers the
 * Tigram image steps. Every writer keeps the quality gate, the WordPress draft and Rank Math.
 */
export function customManifest(w: CustomWriterInfo): ModuleManifest {
  const c = w.config;
  const person = w.base === 'person';
  const titlesPrompt = c.titles === 'own' ? { moduleKey: w.key, stageKey: 'TITLES' } : { moduleKey: 'celebrity-writer', stageKey: 'TITLES' };
  const categoryNote =
    c.category.mode === 'celebrity'
      ? 'Always the website’s “Celebrity” category (German websites: “Prominente”).'
      : c.category.mode === 'fixed'
        ? `Always the website’s “${c.category.name}” category${c.category.nameDe ? ` (German websites: “${c.category.nameDe}”)` : ''}.`
        : 'The category you chose; otherwise ChatGPT chooses one of the website’s synced categories.';
  const table = person && c.rules.table !== 'none' ? `${c.rules.table === 'required' ? '' : 'optional '}${c.rules.tableHeading || 'Family Profile'} table, ` : '';
  const stages: StageManifest[] = [
    { key: 'PRECHECK', label: 'Pre-check inputs', kind: 'local', runningStatus: 'OPENING_CHATGPT', progress: 1, dependsOn: [], checkpoint: 'PRECHECK', description: 'Validate website, category, language and writer before any prompt is sent.' },
    { key: 'DUPLICATE_PRECHECK', label: 'Duplicate pre-check', kind: 'local', runningStatus: 'OPENING_CHATGPT', progress: 2, dependsOn: [], checkpoint: 'DUPLICATE_PRECHECK', description: 'Compare the keyword with existing articles on this and other websites.' },
    { key: 'TITLES', label: 'Titles', kind: 'chatgpt', runningStatus: 'GENERATING_TITLES', progress: 5, dependsOn: [], prompt: titlesPrompt, checkpoint: 'EXISTING_WRITER_STAGES', regenerable: true, description: c.titles === 'off' ? 'Off for this writer: the post title is your example title, else the article’s own title.' : c.titles === 'own' ? 'Your title prompt; its answer needs a “Recommended Title:” line.' : 'The app’s title step: 6–10 title options plus a “Recommended Title:” line.' },
    { key: 'TITLE_APPROVAL', label: 'Title approval', kind: 'gate', runningStatus: 'AWAITING_TITLE_APPROVAL', progress: 10, dependsOn: ['TITLES'], description: 'Optional manual approval/edit of the title. The article prompt gets this title.' },
    { key: 'CATEGORY', label: 'Category', kind: c.category.mode === 'chatgpt' ? 'chatgpt' : 'local', runningStatus: 'OPENING_CHATGPT', progress: 12, dependsOn: [], ...(c.category.mode === 'chatgpt' ? { prompt: { moduleKey: 'tigram-writer', stageKey: 'CATEGORY' } } : {}), description: categoryNote },
    { key: 'ARTICLE', label: 'Article', kind: 'chatgpt', runningStatus: 'WRITING_ARTICLE', progress: 15, dependsOn: ['TITLE_APPROVAL'], prompt: { moduleKey: w.key, stageKey: 'ARTICLE' }, checkpoint: 'EXISTING_WRITER_STAGES', regenerable: true, description: `Your prompt; the whole article in one answer: ${c.rules.seoLines ? 'SEO title, meta description, URL slug, ' : ''}${table}sections${c.rules.conclusion ? ', conclusion' : ''}${c.rules.faqCount ? ` and ${c.rules.exactFaqs ? '' : 'about '}${c.rules.faqCount} FAQs` : ''}.` },
    { key: 'EXTERNAL_LINKS', label: 'Link check', kind: 'local', runningStatus: 'LINKING', progress: 55, dependsOn: ['ARTICLE'], regenerable: true, description: c.linkCheck ? 'Every link of the answer is opened and checked (reachable, on-topic, safe); a failing link becomes plain text.' : 'Off for this writer: the answer’s links are kept as written.' },
    { key: 'INTERNAL_LINKS', label: 'Internal links', kind: 'local', runningStatus: 'LINKING', progress: 60, dependsOn: ['ARTICLE'], checkpoint: 'INTERNAL_LINKS', regenerable: true, description: c.internalLinks ? 'Relevant existing posts of the same site and the final “Also read” line.' : 'Off for this writer.' },
    { key: 'IMAGES', label: 'Images', kind: 'local', runningStatus: 'PROCESSING_IMAGES', progress: 66, dependsOn: [person ? 'TITLE_APPROVAL' : 'ARTICLE'], checkpoint: 'IMAGE_STUDIO', regenerable: true, description: c.images === 'off' ? 'Off for this writer.' : person ? 'Photos of the person as in the celebrity writers: featured + two body images; your uploads first.' : 'Images as in the Tigram writer: a featured image and body images.' },
    { key: 'HUMANIZE', label: 'Editorial humanizer', kind: 'chatgpt', runningStatus: 'HUMANIZING', progress: 74, dependsOn: ['EXTERNAL_LINKS'], prompt: { moduleKey: 'shared', stageKey: 'HUMANIZE' }, regenerable: true, description: 'Paragraph-level polish with fact locks (when switched on for the website).' },
    { key: 'ASSEMBLY', label: 'Assembly', kind: 'local', runningStatus: 'ASSEMBLING', progress: 82, dependsOn: ['HUMANIZE', 'INTERNAL_LINKS', 'IMAGES'], regenerable: true, description: 'The article in ChatGPT’s order, images placed, one internal-link line; sanitized HTML.' },
    { key: 'SEO_CHECK', label: 'SEO check', kind: 'local', runningStatus: 'SEO_CHECKING', progress: 86, dependsOn: ['ASSEMBLY'], description: 'Transparent weighted on-page checks with fix suggestions.' },
    { key: 'QUALITY_GATE', label: 'Quality gate', kind: 'gate', runningStatus: 'QUALITY_CHECKING', progress: 88, dependsOn: ['SEO_CHECK'], checkpoint: 'QUALITY_GATE', description: 'Hard stops pause before WordPress; soft issues become review reasons.' },
    { key: 'ARTICLE_APPROVAL', label: 'Article approval', kind: 'gate', runningStatus: 'AWAITING_ARTICLE_APPROVAL', progress: 90, dependsOn: ['QUALITY_GATE'], description: 'Optional manual approval before the WordPress draft.' },
    { key: 'WORDPRESS_DRAFT', label: 'WordPress draft', kind: 'wordpress', runningStatus: 'CREATING_DRAFT', progress: 93, dependsOn: ['ARTICLE_APPROVAL'], checkpoint: 'WORDPRESS_DRAFT', description: 'Create or reopen exactly one draft; verify save, category, slug and metadata.' },
    { key: 'RANKMATH', label: 'Rank Math', kind: 'wordpress', runningStatus: 'RUNNING_RANKMATH', progress: 97, dependsOn: ['WORDPRESS_DRAFT'], checkpoint: 'RANKMATH', description: 'Verify Rank Math fields and read the real score; bounded safe corrections.' },
    { key: 'VERIFIED_COMPLETE', label: 'Verified complete', kind: 'local', runningStatus: 'QUALITY_CHECKING', progress: 99, dependsOn: ['RANKMATH'], checkpoint: 'VERIFIED_COMPLETE', description: 'Count the article only with a verified draft and passed validations.' },
  ];
  return {
    key: w.key,
    name: w.name,
    shortName: w.shortName,
    description: w.description || (person ? 'Your own person writer.' : 'Your own writer.'),
    icon: person ? 'user' : 'pen',
    group: 'writer',
    active: w.status === 'ACTIVE',
    stages,
    exampleTitle: 'always',
    secondaryKeywordStages: ['ARTICLE'],
    highlights: [
      person ? 'About a person: photos of the person, family-claim checks' : 'General topics: generated images',
      c.titles === 'off' ? 'No title step (example title, else the article’s own title)' : c.titles === 'own' ? 'Your own title prompt' : 'The app’s title step',
      `Your article prompt: ${c.rules.wordMin}–${c.rules.wordMax} words${c.rules.faqCount ? `, ${c.rules.exactFaqs ? '' : 'about '}${c.rules.faqCount} FAQs` : ', no FAQs'}`,
      categoryNote,
    ],
  };
}
