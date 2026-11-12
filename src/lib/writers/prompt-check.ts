import { parseTemplate, referencedVariables, TemplateSyntaxError } from '../prompts/template';
import { CUSTOM_PROMPT_VARIABLES, type WriterPromptStage } from './types';

/**
 * Checks of a writer's prompt (client-safe: the writer page shows them while typing; the server repeats them on save).
 */
const EXTRA_VARIABLES = ['max_words', 'bio_rows_range', 'min_keyword_occurrences', 'max_keyword_occurrences', 'link_count', 'wikipedia_site', 'seo_brief'];
const PHOTO_STAGES: WriterPromptStage[] = ['IMAGE_PLAN', 'IMAGE_GENERATION', 'IMAGE_SEARCH'];
/** The variables of the article and title prompts (the photo prompts' own ones are not filled in there). */
export const KNOWN_PROMPT_VARIABLES = new Set([...CUSTOM_PROMPT_VARIABLES.filter((v) => !v.stage || !PHOTO_STAGES.includes(v.stage)).map((v) => v.name), ...EXTRA_VARIABLES]);
/** The variables the app fills in for one photo prompt: the general ones and that prompt's own. */
export const knownVariablesFor = (stage: WriterPromptStage) => new Set([...CUSTOM_PROMPT_VARIABLES.filter((v) => !v.stage || v.stage === stage).map((v) => v.name), ...EXTRA_VARIABLES]);
export const EXTRA_PROMPT_VARIABLES = EXTRA_VARIABLES;

export interface PromptCheck {
  errors: string[];
  warnings: string[];
  used: string[];
}

/** Template syntax, unknown placeholders and the inputs a writer's prompt should use. */
export function checkPrompt(content: string, stage: WriterPromptStage): PromptCheck {
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
  const known = stage === 'ARTICLE' || stage === 'TITLES' ? KNOWN_PROMPT_VARIABLES : knownVariablesFor(stage);
  for (const v of used) if (!known.has(v)) errors.push(`{{${v}}} is not a variable the app fills in${stage === 'ARTICLE' || stage === 'TITLES' ? '' : ' for this prompt'} (use the buttons above the prompt).`);
  if (stage === 'IMAGE_GENERATION') {
    if (!used.includes('image_brief')) errors.push('Put {{image_brief}} in the prompt: it carries each picture’s description from the image plan (without it every picture gets the same prompt).');
    return { errors, warnings, used };
  }
  if (stage === 'IMAGE_SEARCH') {
    if (!used.includes('person_name') && !used.includes('keyword')) errors.push('Use {{person_name}} (or {{keyword}}): ChatGPT must know whose photos to search.');
    if (!/gallery|images?|photos?|pictures?|bilder|fotos?/i.test(content)) warnings.push('Ask ChatGPT to show the photos (for example “show them as an image gallery”): the app saves the pictures ChatGPT shows.');
    return { errors, warnings, used };
  }
  if (stage === 'IMAGE_PLAN') {
    if (!/image\s*1\s*prompt|featured\s*:/i.test(content)) warnings.push('Ask for the answer lines “IMAGE 1 PROMPT: …” and “IMAGE 1 ALT: …” for images 1 to 3 (1 = featured): the app reads the pictures from them; a missing one gets the app’s default description.');
    if (!used.includes('keyword') && !used.includes('image_title') && !used.includes('selected_title')) warnings.push('The prompt uses neither {{keyword}} nor {{image_title}}: ChatGPT will not know what the pictures are about.');
    return { errors, warnings, used };
  }
  if (!used.includes('keyword') && !used.includes('selected_title')) warnings.push('The prompt uses neither {{keyword}} nor {{selected_title}}: ChatGPT will not know what to write about.');
  if (stage === 'ARTICLE' && !used.includes('secondary_keywords')) warnings.push('{{secondary_keywords}} is not used: secondary keywords you add will not reach ChatGPT.');
  if (stage === 'TITLES' && !/recommended title/i.test(content)) warnings.push('Ask for a final line “Recommended Title: …” — the app reads the title from it.');
  return { errors, warnings, used };
}
