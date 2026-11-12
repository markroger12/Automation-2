import { customWriter } from './catalog';

/**
 * What a writer does, in one place (client-safe): the built-in writers' rules, and for the owner's writers their
 * settings (Writers → a writer). Pipelines, assembly, the SEO check and the quality gate ask here instead of comparing
 * writer keys.
 */

export type CategoryRule = { mode: 'celebrity' } | { mode: 'fixed'; name: string; nameDe: string } | { mode: 'chatgpt' };

/** celebrity: always the website's “Celebrity”/“Prominente”; fixed: a named category; chatgpt: chosen, else ChatGPT. */
export function categoryRuleFor(moduleKey: string | null | undefined): CategoryRule {
  if (moduleKey === 'celebrity-writer' || moduleKey === 'celebrity2-writer') return { mode: 'celebrity' };
  const custom = customWriter(moduleKey);
  if (custom) {
    const c = custom.config.category;
    if (c.mode === 'fixed') return { mode: 'fixed', name: c.name, nameDe: c.nameDe };
    return { mode: c.mode };
  }
  return { mode: 'chatgpt' };
}

/** The category never chosen per article (a celebrity or a fixed category). */
export const categoryIsAutomatic = (moduleKey: string | null | undefined) => categoryRuleFor(moduleKey).mode !== 'chatgpt';

/** Which photos: the person's photos (celebrity steps) or generated images (Tigram steps). */
export function imagesKindFor(moduleKey: string | null | undefined): 'person' | 'general' {
  if (moduleKey === 'tigram-writer') return 'general';
  const custom = customWriter(moduleKey);
  if (custom) return custom.base === 'person' ? 'person' : 'general';
  return 'person';
}

/** The writer's own setting turned photos off (the website's image setting still applies to the others). */
export const imagesOffFor = (moduleKey: string | null | undefined) => customWriter(moduleKey)?.config.images === 'off';

/** The whole article in one answer, kept in ChatGPT's order (its FAQs where it put them): Celebrity 2 and the owner's writers. */
export const keepsAnswerOrder = (moduleKey: string | null | undefined) => moduleKey === 'celebrity2-writer' || Boolean(customWriter(moduleKey));

/** The person's facts table under an H2 (Celebrity 2: “Family Profile”; the owner's person writers: their heading). */
export function profileTableFor(moduleKey: string | null | undefined, language: string): { required: boolean; heading: string } | null {
  if (moduleKey === 'celebrity2-writer') return { required: true, heading: language === 'de' ? 'Familienprofil' : 'Family Profile' };
  const custom = customWriter(moduleKey);
  if (!custom || custom.base !== 'person' || custom.config.rules.table === 'none') return null;
  const r = custom.config.rules;
  return { required: r.table === 'required', heading: (language === 'de' ? r.tableHeadingDe : r.tableHeading) || r.tableHeading || 'Family Profile' };
}

/** The prompt is sent as the owner wrote it (no SEO brief added): Celebrity 2, and the owner's writers unless they ask for it. */
export function sendsPromptAsWritten(moduleKey: string | null | undefined): boolean {
  if (moduleKey === 'celebrity2-writer') return true;
  const custom = customWriter(moduleKey);
  return custom ? !custom.config.seoBrief : false;
}

/** FAQs: how many, and whether exactly that many is required (or about, ±2). Null: the built-in rule applies. */
export function customFaqRule(moduleKey: string | null | undefined): { count: number; exact: boolean } | null {
  const custom = customWriter(moduleKey);
  return custom ? { count: custom.config.rules.faqCount, exact: custom.config.rules.exactFaqs } : null;
}

export function customWordRange(moduleKey: string | null | undefined): [number, number] | null {
  const custom = customWriter(moduleKey);
  return custom ? [custom.config.rules.wordMin, custom.config.rules.wordMax] : null;
}
