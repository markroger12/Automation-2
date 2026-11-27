/**
 * Owner decision (2026-11-04): an article of a celebrity writer (Celebrity and Celebrity 2) always goes into the
 * website's celebrity category — “Celebrity” on English websites, “Prominente” on German ones. Nobody chooses it, and
 * ChatGPT is not asked. Client-safe (used by the forms too).
 */
const NAMES: Record<'en' | 'de', string[]> = {
  en: ['celebrity', 'celebrities', 'celebs'],
  de: ['prominente', 'promis', 'promi'],
};

export const CELEBRITY_CATEGORY_LABEL: Record<'en' | 'de', string> = { en: 'Celebrity', de: 'Prominente' };

const norm = (s: string | null | undefined) => (s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The website's celebrity category: its own language's name first (“Celebrity”, “Celebrities” / “Prominente”,
 * “Promis”), then the other language's, matched by name or slug, ignoring case. Null when the website has none.
 */
export function findCelebrityCategory<C extends { name: string; slug?: string | null }>(categories: readonly C[], language: string): C | null {
  const own = language === 'de' ? NAMES.de : NAMES.en;
  const other = language === 'de' ? NAMES.en : NAMES.de;
  for (const names of [own, other]) {
    for (const name of names) {
      const hit = categories.find((c) => norm(c.name) === name || norm(c.slug) === name);
      if (hit) return hit;
    }
  }
  return null;
}

/** What to tell the owner when a website has no celebrity category yet. */
export function missingCelebrityCategoryMessage(siteName: string, language: string): string {
  const name = CELEBRITY_CATEGORY_LABEL[language === 'de' ? 'de' : 'en'];
  return `${siteName} has no “${name}” category. Celebrity articles always go into “${name}” (English websites: “Celebrity”, German websites: “Prominente”). Create it in WordPress, then Websites → ${siteName} → Sync categories.`;
}

/**
 * The category a writer always uses, for writers whose category is never chosen per article: the celebrity category,
 * or (the owner's writers) a fixed category by name — the German name on German websites when one is set — matched by
 * name or slug, ignoring case. `undefined`: the writer's category is chosen per article (or by ChatGPT).
 */
export function findRuleCategory<C extends { name: string; slug?: string | null }>(
  categories: readonly C[],
  rule: { mode: 'celebrity' } | { mode: 'fixed'; name: string; nameDe: string } | { mode: 'chatgpt' },
  language: string,
): C | null | undefined {
  if (rule.mode === 'celebrity') return findCelebrityCategory(categories, language);
  if (rule.mode !== 'fixed') return undefined;
  const names = (language === 'de' && rule.nameDe ? [rule.nameDe, rule.name] : [rule.name, rule.nameDe]).map(norm).filter(Boolean);
  for (const name of names) {
    const hit = categories.find((c) => norm(c.name) === name || norm(c.slug) === name || norm(c.slug) === name.replace(/ /g, '-'));
    if (hit) return hit;
  }
  return null;
}

/** What to tell the owner when a website lacks the category a writer always uses. */
export function missingRuleCategoryMessage(siteName: string, rule: { mode: 'celebrity' } | { mode: 'fixed'; name: string; nameDe: string } | { mode: 'chatgpt' }, language: string, writerName?: string): string {
  if (rule.mode !== 'fixed') return missingCelebrityCategoryMessage(siteName, language);
  const name = language === 'de' && rule.nameDe ? rule.nameDe : rule.name;
  return `${siteName} has no “${name}” category. ${writerName ? `The writer “${writerName}”` : 'This writer'} always puts its articles there. Create it in WordPress, then Websites → ${siteName} → Sync categories.`;
}
