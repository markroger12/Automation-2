import { z } from 'zod';
import { ACTIVE_MODULE_KEYS, type ActiveModuleKey } from '../domain';

/**
 * Smart Article Router (client-safe, deterministic). Routes a keyword to the
 * Celebrity Article Writer or the Tigram Article Writer, or returns UNKNOWN
 * when the evidence is weak — UNKNOWN is a safe answer that asks the owner
 * to choose, never a reason to guess. Celebrity Writer 2.0 does not exist
 * here. Every decision records its version, confidence and rationale.
 */

export const ROUTER_VERSION = 'rules-2026.10-1';

export interface RouteDecision {
  writer: ActiveModuleKey | null;
  confidence: number;
  rationale: string;
  version: string;
  source: 'RULE' | 'OVERRIDE' | 'CAMPAIGN' | 'SITE_RULE';
}

const w = (s: string) => s.split(/\s*,\s*/);

/** Intents about a person (EN/DE). */
const PERSON_INTENTS = w(
  'wife, husband, girlfriend, boyfriend, partner, spouse, married, marriage, wedding, divorce, dating, kids, children, child, son, daughter, sons, daughters, parents, father, mother, mom, dad, siblings, brother, sister, family, net worth, age, how old, height, how tall, weight, biography, bio, birthday, born, nationality, religion, ethnicity, ex, affair, baby, pregnant, career, early life, instagram, ' +
    'frau, ehefrau, ehemann, mann, freundin, freund, partnerin, verheiratet, hochzeit, scheidung, kinder, kind, sohn, tochter, eltern, vater, mutter, geschwister, bruder, schwester, familie, vermögen, alter, wie alt, größe, wie groß, gewicht, biografie, geburtstag, geboren, herkunft, nationalität, religion, freundschaft, baby, schwanger, karriere',
);

/** Intents about a thing, task or topic (EN/DE). */
const TOPIC_INTENTS = w(
  'how to, how do, how can, what is, what are, why, guide, tutorial, tips, best, top, vs, versus, review, reviews, comparison, compare, alternative, alternatives, download, install, setup, fix, error, not working, price, prices, cost, cheap, free, deal, apk, app, apps, software, tool, tools, plugin, settings, recipe, meaning, definition, examples, ideas, list, checklist, calculator, near me, login, update, ' +
    'wie, was ist, was sind, warum, anleitung, tipps, beste, besten, test, vergleich, alternative, kostenlos, herunterladen, installieren, einrichten, fehler, funktioniert nicht, preis, kosten, günstig, rezept, bedeutung, beispiele, ideen, liste, rechner',
);

/** Words that make a capitalized phrase a product/brand/place/work, not a person. */
const THING_WORDS = w(
  'iphone, android, windows, mac, macos, linux, wordpress, chrome, google, youtube, tiktok, netflix, spotify, amazon, apple, samsung, microsoft, playstation, xbox, nintendo, vpn, laptop, phone, tv, camera, router, printer, game, games, movie, film, series, season, episode, album, song, lyrics, book, hotel, airport, city, weather, restaurant, bank, card, insurance, car, bmw, tesla, toyota, recipe, stock, crypto, bitcoin, ' +
    'handy, spiel, spiele, serie, staffel, folge, lied, buch, flughafen, stadt, wetter, versicherung, auto, aktie',
);

/** Common first names (EN/DE) — evidence for a person when the keyword is typed in lower case. */
const FIRST_NAMES = new Set(
  w(
    'tom, bill, heidi, taylor, selena, justin, kim, kanye, brad, angelina, jennifer, george, leonardo, johnny, will, jada, kevin, chris, ryan, scarlett, emma, robert, tom, beyonce, rihanna, drake, ariana, billie, harry, meghan, kate, william, elon, mark, jeff, bill, cristiano, lionel, david, victoria, zendaya, sydney, margot, pedro, keanu, dwayne, jason, ed, adele, shakira, miley, lady, nicki, cardi, travis, kylie, kendall, khloe, kourtney, paris, britney, madonna, oprah, ellen, jimmy, conan, sandra, julia, nicole, natalie, anne, michael, jessica, megan, ' +
      'helene, dieter, thomas, michael, sophia, lena, mark, til, matthias, elyas, florian, giovanni, sarah, daniela, sylvie, verona, boris, steffi, toni, manuel, jérôme, mats, joshua, kai, lukas, sebastian, nico, mesut, jan, olaf, angela, markus, christian, robert, alice, sahra, friedrich, ' +
      'anna, maria, laura, julia, lisa, john, james, paul, peter, max, alex, sam, ben, jack, lily, sophie, olivia, mia, noah, liam, ethan, daniel, matthew, andrew, ryan, nick, luke, joe, adam, kelly, amy, rachel, eva, eva',
  ).map((n) => n.trim()),
);

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const has = (text: string, phrase: string) => ` ${text} `.includes(` ${phrase} `);

/** Runs of 2–4 capitalized words (e.g. "Tom Kaulitz", "Heidi Klum"). */
function capitalizedNames(original: string): string[] {
  return [...original.matchAll(/(?<![\p{L}])(\p{Lu}[\p{Ll}'’-]+(?:\s+(?:von|van|de|der|da|di|le|la|del)?\s*\p{Lu}[\p{Ll}'’-]+){1,3})/gu)].map((m) => m[1]);
}

export function classifyKeyword(keyword: string, language = 'en'): RouteDecision {
  const text = norm(keyword);
  const tokens = text.split(' ').filter(Boolean);
  const reasons: string[] = [];
  const person = PERSON_INTENTS.filter((p) => has(text, p));
  const topic = TOPIC_INTENTS.filter((p) => has(text, p));
  const things = THING_WORDS.filter((p) => has(text, p));
  const names = capitalizedNames(keyword).filter((n) => !THING_WORDS.some((t) => has(norm(n), t)));
  const firstNameHits = tokens.filter((t, i) => FIRST_NAMES.has(t) && i + 1 < tokens.length && !FIRST_NAMES.has(tokens[i + 1]) && !PERSON_INTENTS.includes(tokens[i + 1]) && !TOPIC_INTENTS.includes(tokens[i + 1]));
  const nameEvidence = names.length > 0 || firstNameHits.length > 0;
  const decide = (writer: ActiveModuleKey | null, confidence: number): RouteDecision => ({ writer, confidence: Math.round(confidence * 100) / 100, rationale: reasons.join(' '), version: ROUTER_VERSION, source: 'RULE' });

  // "Tokio Hotel", "Apple Martin": a thing word inside a capitalized name could be a band, brand or person.
  const allNames = capitalizedNames(keyword).map(norm);
  if (things.length && !topic.length && !person.length && things.every((t) => allNames.some((n) => has(n, t)))) {
    reasons.push(`“${capitalizedNames(keyword)[0]}” could be a name (band, brand or person) or a thing.`);
    return decide(null, 0.4);
  }
  if (things.length && !(nameEvidence && person.length && !topic.length)) {
    reasons.push(`Product/brand/place/work words (${things.slice(0, 3).join(', ')}) point to a general topic.`);
    return decide('tigram-writer', topic.length ? 0.95 : 0.8);
  }
  if (topic.length && !person.length) {
    reasons.push(`General-topic intent (${topic.slice(0, 3).join(', ')}).`);
    if (nameEvidence) {
      reasons.push(`It also looks like it names someone (${(names[0] ?? firstNameHits[0])}); check the writer.`);
      return decide('tigram-writer', 0.6);
    }
    return decide('tigram-writer', 0.9);
  }
  if (person.length && !topic.length) {
    reasons.push(`Person intent (${person.slice(0, 3).join(', ')}).`);
    if (nameEvidence) {
      reasons.push(`Names a person (${names[0] ?? firstNameHits[0]}).`);
      return decide('celebrity-writer', 0.92);
    }
    // "net worth" or "age" without a recognisable name could be a company or a thing.
    reasons.push('No recognisable person name, so the writer is left for you to choose.');
    return decide(null, 0.4);
  }
  if (person.length && topic.length) {
    reasons.push(`Mixed intent: person (${person[0]}) and general topic (${topic[0]}).`);
    return decide(null, 0.35);
  }
  if (names.length >= 2 || (names.length === 1 && names[0].split(/\s+/).length >= 2)) {
    reasons.push(`Looks like ${names.length >= 2 ? 'people’s names' : 'a person’s full name'} (${names.join(', ')}).`);
    return decide('celebrity-writer', names.length >= 2 ? 0.85 : 0.75);
  }
  if (firstNameHits.length) {
    reasons.push(`Starts like a person’s name (“${firstNameHits[0]} …”).`);
    return decide('celebrity-writer', 0.7);
  }
  reasons.push(language === 'de' ? 'Kein eindeutiges Muster — bitte den Writer wählen.' : 'No clear pattern — please choose the writer.');
  return decide(null, 0.2);
}

/** A routing result for a row: owner override > campaign default > rule (only when confident enough). */
/** A website's own routing rule: keywords containing the phrase (whole words) go to that writer. */
export interface SiteRoutingRule {
  contains: string;
  writer: ActiveModuleKey;
}

export const routingRulesSchema = z
  .array(z.object({ contains: z.string().trim().min(2, 'Each rule needs a phrase of at least 2 characters.').max(80), writer: z.enum(ACTIVE_MODULE_KEYS) }))
  .max(50, 'At most 50 rules per website.');

const words = (s: string) => ` ${s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/** The first rule whose phrase occurs in the keyword as whole words (case-insensitive). */
export function matchSiteRule(keyword: string, rules: SiteRoutingRule[] | null | undefined): SiteRoutingRule | null {
  const kw = words(keyword);
  return (rules ?? []).find((r) => words(r.contains).trim() && kw.includes(words(r.contains))) ?? null;
}

/** Stored rules, ignoring anything invalid (a bad entry never routes). */
export function parseRoutingRules(json: string | null | undefined): SiteRoutingRule[] {
  try {
    const r = routingRulesSchema.safeParse(JSON.parse(json ?? '[]'));
    return r.success ? r.data : [];
  } catch {
    return [];
  }
}

/**
 * Writer for a keyword. Precedence: the row's own choice, the campaign
 * default, the website's routing rules, then the classifier (UNKNOWN when
 * unsure — the owner chooses). Only the two active writers are ever returned.
 */
export function resolveWriter(input: { keyword: string; language?: string | null; override?: string | null; campaignDefault?: string | null; siteRules?: SiteRoutingRule[] | null; minConfidence?: number }): RouteDecision {
  const override = normalizeWriter(input.override);
  if (override) return { writer: override, confidence: 1, rationale: 'Chosen for this row.', version: ROUTER_VERSION, source: 'OVERRIDE' };
  const campaignDefault = normalizeWriter(input.campaignDefault);
  if (campaignDefault) return { writer: campaignDefault, confidence: 1, rationale: 'Campaign default writer.', version: ROUTER_VERSION, source: 'CAMPAIGN' };
  const siteRule = matchSiteRule(input.keyword, input.siteRules);
  if (siteRule) return { writer: siteRule.writer, confidence: 1, rationale: `Website rule: keyword contains “${siteRule.contains}”.`, version: ROUTER_VERSION, source: 'SITE_RULE' };
  const rule = classifyKeyword(input.keyword, input.language ?? 'en');
  if (rule.writer && rule.confidence < (input.minConfidence ?? 0.7)) return { ...rule, writer: null, rationale: `${rule.rationale} Confidence ${Math.round(rule.confidence * 100)} % is below the automatic threshold.` };
  return rule;
}

/** Accept writer names from imports (celebrity/tigram/general…); anything else (incl. 2.0) is not a writer. */
export function normalizeWriter(value: string | null | undefined): ActiveModuleKey | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if ((ACTIVE_MODULE_KEYS as readonly string[]).includes(v)) return v as ActiveModuleKey;
  if (['celebrity', 'celeb', 'person', 'people', 'promi', 'celebrity article writer'].includes(v)) return 'celebrity-writer';
  if (['tigram', 'general', 'topic', 'allgemein', 'tigram article writer'].includes(v)) return 'tigram-writer';
  return null;
}
