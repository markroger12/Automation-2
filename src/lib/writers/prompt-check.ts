import { parseTemplate, referencedVariables, TemplateSyntaxError } from '../prompts/template';
import { CUSTOM_PROMPT_VARIABLES } from './types';

/**
 * Checks of a writer's prompt (client-safe: the writer page shows them while typing; the server repeats them on save).
 */
const EXTRA_VARIABLES = ['max_words', 'bio_rows_range', 'min_keyword_occurrences', 'max_keyword_occurrences', 'link_count', 'wikipedia_site', 'seo_brief'];
export const KNOWN_PROMPT_VARIABLES = new Set([...CUSTOM_PROMPT_VARIABLES.map((v) => v.name), ...EXTRA_VARIABLES]);
export const EXTRA_PROMPT_VARIABLES = EXTRA_VARIABLES;

export interface PromptCheck {
  errors: string[];
  warnings: string[];
  used: string[];
}

/** Template syntax, unknown placeholders and the inputs a writer's prompt should use. */
export function checkPrompt(content: string, stage: 'ARTICLE' | 'TITLES'): PromptCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!content.trim()) errors.push('The prompt is empty.');
  try {
    parseTemplate(content);
  } catch (e) {
    if (e instanceof TemplateSyntaxError) errors.push(`Template: ${e.message}`);
    else throw e;
  }
  if (errors.length) return { errors, warnings, used: [] };
  const used = referencedVariables(content);
  for (const v of used) if (!KNOWN_PROMPT_VARIABLES.has(v)) errors.push(`{{${v}}} is not a variable the app fills in (use the buttons above the prompt).`);
  if (!used.includes('keyword') && !used.includes('selected_title')) warnings.push('The prompt uses neither {{keyword}} nor {{selected_title}}: ChatGPT will not know what to write about.');
  if (stage === 'ARTICLE' && !used.includes('secondary_keywords')) warnings.push('{{secondary_keywords}} is not used: secondary keywords you add will not reach ChatGPT.');
  if (stage === 'TITLES' && !/recommended title/i.test(content)) warnings.push('Ask for a final line “Recommended Title: …” — the app reads the title from it.');
  return { errors, warnings, used };
}
