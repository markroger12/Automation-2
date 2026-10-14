import type { EffectiveTaskConfig } from '../settings-schema';
import type { TemplateVars } from './template';
import { languageName, wikipediaSite } from '../chatgpt/language';

export interface VariableInput {
  moduleKey: string;
  keyword: string;
  secondaryKeywords: string[];
  exampleTitle: string | null;
  language: string;
  country: string;
  categories: string[];
  config: Pick<
    EffectiveTaskConfig,
    'maxWords' | 'faqCount' | 'quickBioRows' | 'tigramWordRange' | 'tigramFaqCount' | 'minKeywordOccurrences' | 'maxKeywordOccurrences' | 'maxExternalLinks'
  >;
  selectedTitle?: string | null;
}

/** Variables known from the task inputs and its configuration snapshot. */
export function baseVariables(input: VariableInput): TemplateVars {
  const rows = input.config.quickBioRows;
  return {
    keyword: input.keyword,
    secondary_keywords: input.secondaryKeywords,
    example_title: input.exampleTitle ?? '',
    language: languageName(input.language),
    country: input.country,
    selected_title: input.selectedTitle ?? '',
    max_words: input.config.maxWords,
    faq_count: input.moduleKey === 'tigram-writer' ? input.config.tigramFaqCount : input.config.faqCount,
    bio_rows_range: `${rows - 1}–${rows + 1}`,
    min_keyword_occurrences: input.config.minKeywordOccurrences,
    max_keyword_occurrences: input.config.maxKeywordOccurrences,
    word_range: input.config.tigramWordRange.replace(/\s*[-–]\s*/, '–') + ' words',
    link_count: Math.min(7, Math.max(5, input.config.maxExternalLinks + 2)),
    wikipedia_site: wikipediaSite(input.language),
    categories: input.categories.join('\n'),
  };
}

/** Stage-produced values: shown as "available after …" in previews, never faked. */
export const DOWNSTREAM_PLACEHOLDERS: Record<string, string> = {
  selected_title: 'available after TITLES (and title approval)',
  final_article: 'available after the article stage',
  rankmath_issues: 'available after the WordPress draft is checked by Rank Math',
  image_brief: 'available after IMAGE_PLAN',
  photo_count: 'available when candidate photos are collected',
  problems: 'computed by the humanizer for each batch',
  paragraphs: 'computed by the humanizer for each batch',
};
