import { z } from 'zod';
import { load } from 'cheerio';
import { normalizeText } from '../content/text';

/**
 * Search intent and the editable SEO brief (upgrade 04). Deterministic
 * English/German rules — no model call — classify what the searcher wants;
 * the brief turns that into sections to cover, title/meta guidance and the
 * keyword-use guideline. The brief guides writing; it is never a reason to
 * insert facts or unnatural keyword repetitions.
 */

import { INTENTS, INTENT_LABEL, type SearchIntent } from './intent-labels';

export { INTENTS, INTENT_LABEL };
export type { SearchIntent };

const RULES: { intent: SearchIntent; re: RegExp; why: string }[] = [
  { intent: 'NET_WORTH', re: /\b(net\s*worth|vermögen|wie reich|how rich|salary|gehalt|income|einkommen|earnings|verdienst)\b/i, why: 'money words' },
  { intent: 'COMPARISON', re: /\s(vs\.?|versus|gegen|oder|or)\s|\b(compare[ds]?|comparison|vergleich|unterschied|difference|better than|besser als)\b/i, why: 'comparison words' },
  { intent: 'HOW_TO', re: /^(how\s+(to|do|can|does)|wie\s+(man|kann|funktioniert|geht))\b|\b(anleitung|step[- ]by[- ]step|schritt für schritt|tutorial|guide)\b/i, why: 'how-to phrasing' },
  {
    intent: 'FAMILY_RELATIONSHIP',
    re: /\b(wife|husband|girlfriend|boyfriend|married|marriage|wedding|spouse|partner|dating|divorce|children|kids|son|daughter|parents|mother|father|siblings?|brother|sister|ehefrau|ehemann|freundin|freund|verheiratet|hochzeit|scheidung|kinder|sohn|tochter|eltern|mutter|vater|bruder|schwester|beziehung|liebe)\b/i,
    why: 'family or relationship words',
  },
  { intent: 'EXPLAINER', re: /^(what|why|when|where|was ist|was sind|warum|wieso|wann|wo)\b|\b(explained|erklärt|meaning|bedeutung|definition)\b/i, why: 'question or explainer phrasing' },
];

export interface IntentResult {
  intent: SearchIntent;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

/** Two capitalised names in a celebrity keyword (“Tom Kaulitz Heidi Klum”) usually ask about the couple. */
function looksLikeTwoPeople(keyword: string): boolean {
  const caps = keyword.trim().split(/\s+/).filter((w) => /^\p{Lu}[\p{Ll}'-]+$/u.test(w));
  return caps.length >= 4;
}

export function classifyIntent(keyword: string, opts: { secondary?: string[]; moduleKey: string }): IntentResult {
  const kw = keyword.trim();
  for (const r of RULES) if (r.re.test(kw)) return { intent: r.intent, confidence: 'high', reason: `the keyword contains ${r.why}` };
  const secondary = (opts.secondary ?? []).join(' ');
  for (const r of RULES) if (secondary && r.re.test(secondary)) return { intent: r.intent, confidence: 'medium', reason: `a secondary keyword contains ${r.why}` };
  if (opts.moduleKey === 'celebrity-writer') {
    if (looksLikeTwoPeople(kw)) return { intent: 'FAMILY_RELATIONSHIP', confidence: 'medium', reason: 'the keyword names two people' };
    return { intent: 'BIOGRAPHY', confidence: 'medium', reason: 'a person keyword without a narrower question' };
  }
  return { intent: 'EXPLAINER', confidence: 'low', reason: 'no narrower intent words; a general topic' };
}

export const seoBriefSchema = z.object({
  intent: z.enum(INTENTS),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  reason: z.string().max(300).default(''),
  /** Sections the article should cover (headings are written by the writer, in the article language). */
  sections: z.array(z.string().trim().min(2).max(140)).max(15),
  titleGuidance: z.string().max(400),
  metaGuidance: z.string().max(400),
  faqFocus: z.string().max(400),
  keywordGuideline: z.string().max(400),
  notes: z.string().max(1000).default(''),
  editedByOwner: z.boolean().default(false),
});
export type SeoBrief = z.output<typeof seoBriefSchema>;

const SECTIONS: Record<SearchIntent, { en: string[]; de: string[] }> = {
  BIOGRAPHY: { en: ['Early life and background', 'Career and breakthrough', 'Personal life', 'Recent work and public image'], de: ['Frühes Leben und Herkunft', 'Karriere und Durchbruch', 'Privatleben', 'Aktuelle Projekte und öffentliches Bild'] },
  FAMILY_RELATIONSHIP: { en: ['How and when they met', 'Relationship timeline (only dated, sourced events)', 'Family and children (only what is public)', 'Life together today'], de: ['Wie und wann sie sich kennenlernten', 'Zeitleiste der Beziehung (nur belegte Ereignisse mit Datum)', 'Familie und Kinder (nur Öffentliches)', 'Das gemeinsame Leben heute'] },
  NET_WORTH: { en: ['Estimated net worth and its sources (marked as an estimate)', 'Main income sources', 'Career milestones that built it', 'Assets and investments (only reported ones)'], de: ['Geschätztes Vermögen und Quellen (als Schätzung gekennzeichnet)', 'Haupteinnahmequellen', 'Karriereschritte, die es aufgebaut haben', 'Besitz und Investitionen (nur berichtete)'] },
  EXPLAINER: { en: ['A short, direct answer', 'Background and context', 'Key details explained', 'What it means for the reader'], de: ['Kurze, direkte Antwort', 'Hintergrund und Zusammenhang', 'Wichtige Details erklärt', 'Was es für Leser bedeutet'] },
  COMPARISON: { en: ['Quick verdict', 'Side-by-side comparison table', 'Differences that matter', 'Which to choose when'], de: ['Kurzes Fazit', 'Vergleichstabelle', 'Die wichtigen Unterschiede', 'Was wann die bessere Wahl ist'] },
  HOW_TO: { en: ['What you need before starting', 'Step-by-step instructions (numbered)', 'Common mistakes and fixes', 'Next steps'], de: ['Was Sie vorher brauchen', 'Schritt-für-Schritt-Anleitung (nummeriert)', 'Häufige Fehler und Lösungen', 'Nächste Schritte'] },
};

export function defaultSeoBrief(input: { keyword: string; secondary?: string[]; moduleKey: string; language: string; densityCeilingPct?: number }): SeoBrief {
  const r = classifyIntent(input.keyword, { secondary: input.secondary, moduleKey: input.moduleKey });
  const de = input.language === 'de';
  const kw = input.keyword.trim();
  return {
    intent: r.intent,
    confidence: r.confidence,
    reason: r.reason,
    sections: SECTIONS[r.intent][de ? 'de' : 'en'],
    titleGuidance: de ? `50–60 Zeichen, beginnt möglichst mit „${kw}“, beantwortet die Suchabsicht (${INTENT_LABEL[r.intent]}).` : `50–60 characters, ideally starting with “${kw}”, answering the search intent (${INTENT_LABEL[r.intent]}).`,
    metaGuidance: de ? `140–160 Zeichen mit „${kw}“ und dem wichtigsten belegten Punkt.` : `140–160 characters with “${kw}” and the single most important sourced point.`,
    faqFocus: de ? 'Fragen, die Suchende zu genau dieser Absicht stellen; Antworten nur aus den Recherchequellen.' : 'Questions searchers ask about exactly this intent; answers only from the research sources.',
    keywordGuideline: de
      ? `„${kw}“ im Titel, in der Einleitung, in einer passenden Zwischenüberschrift und im Slug; Dichte als Richtwert bis ${input.densityCeilingPct ?? 2.5} % — nie unnatürlich wiederholen.`
      : `“${kw}” in the title, the intro, one fitting heading and the slug; density is a guideline up to ${input.densityCeilingPct ?? 2.5} % — never repeat it unnaturally.`,
    notes: r.intent === 'NET_WORTH' ? (de ? 'Vermögenszahlen immer als Schätzung mit Quelle angeben.' : 'Always present net worth figures as estimates with their source.') : '',
    editedByOwner: false,
  };
}

export function parseSeoBrief(raw: string | null | undefined): SeoBrief | null {
  if (!raw) return null;
  try {
    const parsed = seoBriefSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The brief as a short prompt block (appended to writing prompts that do not place {{seo_brief}} themselves). */
export function seoBriefText(b: SeoBrief, language: string): string {
  const de = language === 'de';
  const lines = [
    de ? `SEO-Briefing (Suchabsicht: ${INTENT_LABEL[b.intent]}):` : `SEO brief (search intent: ${INTENT_LABEL[b.intent]}):`,
    `${de ? 'Abschnitte, die abgedeckt werden sollen' : 'Sections to cover'}: ${b.sections.join('; ')}.`,
    b.keywordGuideline,
    b.notes,
    de ? 'Nur Fakten aus der Recherche verwenden; fehlt etwas, den Abschnitt kürzer halten statt etwas zu erfinden.' : 'Use only facts from the research; if something is missing, keep that section short instead of inventing it.',
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * Coverage of the brief's sections in the written article (informational;
 * a section counts when a heading shares a content word with it). Never
 * used to force text into the article.
 */
export function briefCoverage(html: string, b: SeoBrief): { covered: string[]; missing: string[] } {
  const $ = load(`<body>${html}</body>`);
  const headings = $('h2, h3')
    .toArray()
    .map((h) => normalizeText($(h).text()));
  const stop = new Set(['and', 'the', 'its', 'with', 'what', 'only', 'und', 'die', 'der', 'das', 'mit', 'nur', 'was', 'wie', 'when', 'how', 'for', 'für', 'sie']);
  const covered: string[] = [];
  const missing: string[] = [];
  for (const s of b.sections) {
    const words = normalizeText(s.replace(/\(.*?\)/g, ''))
      .split(' ')
      .filter((w) => w.length > 3 && !stop.has(w));
    const hit = headings.some((h) => words.some((w) => h.includes(w.slice(0, Math.max(4, w.length - 2)))));
    (hit ? covered : missing).push(s);
  }
  return { covered, missing };
}
