import { z } from 'zod';
import { db } from '../db';
import { activeModuleKeySchema, countrySchema, languageSchema } from '../domain';
import { getSettings, parseSiteOverrides } from '../settings';
import { effectiveTaskConfig, taskOptionsSchema } from '../settings-schema';
import { parseSecondaryKeywords } from '../content/text';
import { languageInstruction } from '../chatgpt/language';
import { AppError } from '../errors';
import { getManifest } from '@/modules/registry';
import { loadPromptTemplate, promptModuleFor } from './load';
import { renderTemplate, referencedVariables } from './template';
import { DOWNSTREAM_PLACEHOLDERS, baseVariables } from './variables';

export const previewInputSchema = z.object({
  moduleKey: activeModuleKeySchema,
  keyword: z.string().max(200).default(''),
  secondaryKeywords: z.union([z.string().max(4000), z.array(z.string().max(160))]).optional().nullable(),
  exampleTitle: z.string().max(400).optional().nullable(),
  websiteId: z.string().max(40).optional().nullable(),
  categoryId: z.string().max(40).optional().nullable(),
  language: languageSchema.optional().nullable(),
  targetCountry: countrySchema.optional().nullable().or(z.literal('')),
  options: taskOptionsSchema.prefault({}),
});

export interface PromptPreview {
  stageKey: string;
  promptModule: string;
  name: string;
  version: string;
  customized: boolean;
  kind: string;
  text: string;
  missing: string[];
  unavailable: string[];
  notes: string[];
}

/**
 * Render the CURRENT owner-edited templates with the form values. Values only
 * known after earlier stages are labelled, never invented.
 */
export async function previewPrompts(raw: unknown): Promise<{ previews: PromptPreview[]; notes: string[] }> {
  const input = previewInputSchema.parse(raw);
  const manifest = getManifest(input.moduleKey);
  if (!manifest) throw new AppError(400, 'VALIDATION', 'Unknown writer.');
  const site = input.websiteId ? await db.website.findUnique({ where: { id: input.websiteId }, include: { categories: { orderBy: { name: 'asc' } } } }) : null;
  const settings = await getSettings();
  const config = effectiveTaskConfig(settings, parseSiteOverrides(site?.settingsOverrides), input.options);
  const language = input.language ?? (site?.language as 'en' | 'de' | undefined) ?? settings.content.defaultLanguage;
  const country = input.targetCountry || site?.targetCountry || settings.content.targetCountry;
  const category = site?.categories.find((c) => c.id === (input.categoryId || site.defaultCategoryId));
  const vars = baseVariables({
    moduleKey: input.moduleKey,
    keyword: input.keyword.trim(),
    secondaryKeywords: parseSecondaryKeywords(input.secondaryKeywords ?? []),
    exampleTitle: input.exampleTitle?.trim() || null,
    language,
    country,
    categories: site?.categories.map((c) => c.name) ?? [],
    config,
  });
  const notes: string[] = [];
  if (!site) notes.push('No website selected: site language, categories and overrides are not applied yet.');
  if (!input.keyword.trim()) notes.push('Primary keyword is empty: {{keyword}} is shown as missing.');
  const previews: PromptPreview[] = [];
  for (const stage of manifest.stages) {
    if (!stage.prompt) continue;
    const promptModule = promptModuleFor(input.moduleKey, stage.prompt.stageKey);
    const tpl = await loadPromptTemplate(promptModule, stage.prompt.stageKey, site);
    const unavailable: Record<string, string> = { ...DOWNSTREAM_PLACEHOLDERS };
    if (input.moduleKey === 'tigram-writer' && stage.key === 'CATEGORY' && category) {
      notes.push(`CATEGORY is skipped for this task because you chose “${category.name}”.`);
    }
    if (!site?.categories.length) unavailable.categories = 'sync categories on the Websites page first';
    const rendered = renderTemplate(tpl.content, vars, { unavailable });
    const stageNotes: string[] = [];
    const refs = referencedVariables(tpl.content);
    if (input.exampleTitle?.trim() && !refs.includes('example_title') && stage.key === (input.moduleKey === 'tigram-writer' ? 'ARTICLE' : 'TITLES')) {
      stageNotes.push('The example title is not used: this saved template has no {{example_title}} variable (no prompt is changed silently).');
    }
    const secondary = parseSecondaryKeywords(input.secondaryKeywords ?? []);
    if (secondary.length && manifest.secondaryKeywordStages.includes(stage.key) && !refs.includes('secondary_keywords')) {
      stageNotes.push('Secondary keywords are not used: this saved template has no {{secondary_keywords}} variable.');
    }
    const text = tpl.kind === 'text' ? `${rendered.text}\n\n${languageInstruction(language, country)}` : rendered.text;
    previews.push({
      stageKey: stage.key,
      promptModule,
      name: stage.label,
      version: tpl.version,
      customized: tpl.customized,
      kind: tpl.kind,
      text,
      missing: rendered.missing.filter((m) => !(m in unavailable)),
      unavailable: rendered.unavailable,
      notes: stageNotes,
    });
  }
  return { previews, notes };
}
