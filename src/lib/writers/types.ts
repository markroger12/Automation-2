import { z } from 'zod';

/**
 * Writers the owner builds in the app (owner request, 2026-11-05: “jab chaon module add krlon” — add a writer without
 * asking for code). Client-safe. A custom writer runs the same steps as the built-in writers (pre-checks, title step,
 * category, the article from the owner's prompt, link check, internal links, photos, humanizer, assembly, SEO check,
 * quality gate, WordPress draft, Rank Math); these settings say which steps it uses and what its answer must contain.
 * The safety rules stay the same for every writer: drafts only unless the website allows publishing, ChatGPT only
 * through the extension, the quality gate before WordPress.
 */

export const CUSTOM_KEY_PREFIX = 'custom-';
export const CUSTOM_KEY_RE = /^custom-[a-z0-9][a-z0-9-]{0,47}$/;
export const isCustomKey = (key: string | null | undefined): boolean => Boolean(key && CUSTOM_KEY_RE.test(key));

export const WRITER_BASES = ['person', 'general'] as const;
export type WriterBase = (typeof WRITER_BASES)[number];
export const WRITER_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type WriterStatus = (typeof WRITER_STATUSES)[number];

const phrase = z.string().trim().min(2, 'At least 2 characters.').max(80, 'At most 80 characters.');

export const customWriterConfigSchema = z
  .object({
    /** app: the app's title step (6–10 options + “Recommended Title:”); own: the writer's own title prompt; off: no title step. */
    titles: z.enum(['app', 'own', 'off']).default('app'),
    rules: z
      .object({
        wordMin: z.number().int().min(200).max(10000).default(1200),
        wordMax: z.number().int().min(300).max(15000).default(1800),
        /** 0: the answer has no FAQ section. */
        faqCount: z.number().int().min(0).max(15).default(5),
        /** Exactly that many (person writers' rule) or about that many (±2). */
        exactFaqs: z.boolean().default(true),
        /** Person writers: the two-column facts table about the person. */
        table: z.enum(['required', 'optional', 'none']).default('required'),
        tableHeading: z.string().trim().max(60).default('Family Profile'),
        tableHeadingDe: z.string().trim().max(60).default('Familienprofil'),
        conclusion: z.boolean().default(true),
        /** The answer starts with “SEO Title / Meta Description / URL Slug” lines (missing ones are filled by the app). */
        seoLines: z.boolean().default(true),
        /** No bullet or numbered lists in the narrative (a warning when there are). */
        noLists: z.boolean().default(false),
      })
      .prefault({})
      .refine((r) => r.wordMax > r.wordMin, { message: 'The highest word count must be above the lowest.', path: ['wordMax'] }),
    category: z
      .object({
        /** celebrity: always the website's “Celebrity”/“Prominente” category; fixed: a category by name; chatgpt: the
         * chosen one, else ChatGPT chooses one of the website's synced categories. */
        mode: z.enum(['celebrity', 'fixed', 'chatgpt']).default('chatgpt'),
        name: z.string().trim().max(80).default(''),
        nameDe: z.string().trim().max(80).default(''),
      })
      .prefault({})
      .refine((c) => c.mode !== 'fixed' || c.name.length >= 2, { message: 'Type the category name.', path: ['name'] }),
    /** Photos: person photos (the celebrity photo steps) for person writers, generated images for general writers. */
    images: z.enum(['on', 'off']).default('on'),
    /** Open every link of the answer and unlink the ones that fail (as Celebrity 2). */
    linkCheck: z.boolean().default(true),
    internalLinks: z.boolean().default(true),
    /** Add the app's SEO brief under the prompt (off: the prompt is sent as written, like Celebrity 2). */
    seoBrief: z.boolean().default(false),
    routing: z
      .object({
        /** Keywords containing one of these phrases (whole words) are given this writer. */
        contains: z.array(phrase).max(30).default([]),
        /** Person writers: offered for person keywords in Workflow and Bulk (with Celebrity and Celebrity 2). */
        personKeywords: z.boolean().default(true),
      })
      .prefault({}),
  })
  .prefault({});

export type CustomWriterConfig = z.output<typeof customWriterConfigSchema>;
export type CustomWriterConfigInput = z.input<typeof customWriterConfigSchema>;

export const defaultConfig = (base: WriterBase): CustomWriterConfig =>
  customWriterConfigSchema.parse(
    base === 'person'
      ? { category: { mode: 'celebrity' }, rules: { faqCount: 5, exactFaqs: true, table: 'required', wordMin: 1300, wordMax: 1600 } }
      : { category: { mode: 'chatgpt' }, rules: { faqCount: 6, exactFaqs: false, table: 'none', wordMin: 1200, wordMax: 1800 } },
  );

/** What every part of the app knows about a custom writer (no prompt text). */
export interface CustomWriterInfo {
  key: string;
  name: string;
  shortName: string;
  description: string;
  base: WriterBase;
  status: WriterStatus;
  startedFrom: string | null;
  config: CustomWriterConfig;
}

/** Template variables a custom writer's prompts can use (Writers → the prompt editor shows them as buttons). */
export const CUSTOM_PROMPT_VARIABLES: { name: string; label: string; example: string; stage?: 'TITLES' | 'ARTICLE' }[] = [
  { name: 'keyword', label: 'Primary keyword', example: 'Andrea Soros' },
  { name: 'selected_title', label: 'Approved title (from the title step)', example: 'Who Is Andrea Soros? All About George Soros’ Daughter', stage: 'ARTICLE' },
  { name: 'secondary_keywords', label: 'Secondary keywords (comma-separated)', example: 'andrea soros husband, andrea soros children' },
  { name: 'example_title', label: 'Example title you typed (optional)', example: 'Andrea Soros: Family and Philanthropy' },
  { name: 'language', label: 'Language (English / German)', example: 'English' },
  { name: 'language_variant', label: 'Language variant (US English / German)', example: 'US English' },
  { name: 'country', label: 'Target country', example: 'United States' },
  { name: 'word_range', label: 'Word range (e.g. 1300–1600 words)', example: '1300–1600 words', stage: 'ARTICLE' },
  { name: 'faq_count', label: 'Number of FAQs', example: '5', stage: 'ARTICLE' },
  { name: 'table_heading', label: 'Table heading (Family Profile)', example: 'Family Profile', stage: 'ARTICLE' },
];

/** A readable key from a name: “Tech Reviews” → custom-tech-reviews. */
export function keyFromName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `${CUSTOM_KEY_PREFIX}${slug || 'writer'}`;
}
