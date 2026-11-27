import { load } from 'cheerio';
import { countNormalized, detectLanguage, normalizeText, stripTags, wordCount } from '@/lib/content/text';
import { textBlocks } from '@/wordpress/compare';
import type { MarkUse } from './editable';

/**
 * The app's checks of an updated post before the owner sees it (owner request 2026-11-27: an update that ranks
 * again and is never penalised by Google). A blocking check stops the update (it can be tried again); the others are
 * shown next to the comparison for the owner's decision.
 */
export interface UpdateCheck {
  id: string;
  label: string;
  passed: boolean;
  blocking: boolean;
  detail: string;
}

export interface CheckInput {
  beforeHtml: string;
  afterHtml: string;
  marks: MarkUse;
  keyword: string;
  language: string;
  densityCeilingPct: number;
  titleBefore: string;
  titleAfter: string;
  metaDescription: string | null;
  changes: string[];
  sources: { url: string; note: string }[];
  now?: Date;
}

const CHATBOT = /\b(as an ai|as a language model|i (?:have|'ve) updated|here is the updated|here's the updated|i (?:can(?:not|'t)|am unable to) (?:browse|access)|my knowledge cutoff|i hope this helps|let me know if)\b/i;

function shape(html: string, keyword: string) {
  const $ = load(`<body>${html}</body>`);
  const text = stripTags(html);
  const words = wordCount(text);
  const headings = $('h2,h3,h4').toArray().map((h) => normalizeText($(h).text())).filter(Boolean);
  const links = $('a[href]').toArray().map((a) => $(a).attr('href')!.trim());
  const occurrences = keyword ? countNormalized(text, keyword) : 0;
  return { text, words, headings, links, densityPct: words ? Math.round((occurrences / words) * 1000) / 10 : 0 };
}

const years = (s: string) => [...s.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));

export function checkUpdate(i: CheckInput): UpdateCheck[] {
  const now = i.now ?? new Date();
  const b = shape(i.beforeHtml, i.keyword);
  const a = shape(i.afterHtml, i.keyword);
  const checks: UpdateCheck[] = [];
  const add = (id: string, label: string, passed: boolean, blocking: boolean, detail: string) => checks.push({ id, label, passed, blocking, detail });

  const lost = [...i.marks.missing.map((k) => `${k.what} left out`), ...i.marks.repeated.map((k) => `${k.what} repeated`), ...i.marks.unknown.map((n) => `unknown part {K${n}}`)];
  add('kept-parts', 'Images, embeds and shortcodes kept', lost.length === 0, true, lost.length ? lost.slice(0, 5).join(' · ') : 'All kept exactly as they were.');

  const ratio = b.words ? a.words / b.words : 1;
  const lengthOk = b.words < 150 || (ratio >= 0.85 && ratio <= 1.6);
  add('length', 'Length close to the original', lengthOk, true, `${b.words} → ${a.words} words (${ratio >= 1 ? '+' : ''}${Math.round((ratio - 1) * 100)} %). Allowed: −15 % to +60 %.`);

  const kept = (h: string) => a.headings.some((x) => x === h || x.includes(h) || h.split(' ').filter((w) => !/^\d{4}$/.test(w)).every((w) => x.split(' ').includes(w)));
  const missingHeadings = b.headings.filter((h) => !kept(h));
  const headingsOk = !b.headings.length || missingHeadings.length <= Math.floor(b.headings.length * 0.3);
  add('headings', 'Structure (headings) kept', headingsOk, true, missingHeadings.length ? `Not found any more: ${missingHeadings.slice(0, 4).join(' · ')}` : `${b.headings.length} → ${a.headings.length} headings.`);

  const lang = detectLanguage(a.text);
  const langOk = !['en', 'de'].includes(i.language) || lang.language === 'unknown' || lang.language === i.language || lang.confidence <= 0.6;
  add('language', 'Same language', langOk, true, langOk ? `Written in ${i.language === 'de' ? 'German' : 'English'}.` : `The answer reads as ${lang.language}.`);

  const stuffed = a.densityPct > i.densityCeilingPct && a.densityPct > b.densityPct;
  add('keyword', 'Main keyword used naturally', !stuffed, true, `“${i.keyword}”: ${b.densityPct} % → ${a.densityPct} % of the words (limit ${i.densityCeilingPct} %).`);

  const chatbot = CHATBOT.exec(a.text);
  add('chatbot', 'No chatbot remarks in the article', !chatbot, true, chatbot ? `Found “${chatbot[0]}”.` : 'None.');

  const lostLinks = b.links.filter((l) => !a.links.includes(l));
  add('links', 'Links kept', lostLinks.length === 0, false, lostLinks.length ? `${lostLinks.length} link(s) removed: ${lostLinks.slice(0, 3).join(' · ')}` : `${b.links.length} kept.`);

  const factual = i.changes.length > 0;
  add('sources', 'Sources for the new facts', !factual || i.sources.length > 0, false, i.sources.length ? `${i.sources.length} source(s) listed.` : factual ? 'ChatGPT listed no sources: check the new facts before approving.' : 'No changes.');

  // Fake freshness: a newer year in the title with (almost) the same text.
  const before = new Set(textBlocks(i.beforeHtml));
  const changedBlocks = textBlocks(i.afterHtml).filter((t) => !before.has(t)).length;
  const newYear = years(i.titleAfter).some((y) => !years(i.titleBefore).includes(y));
  const fakeFresh = newYear && changedBlocks < 3;
  add('freshness', 'Real changes behind a new year in the title', !fakeFresh, false, fakeFresh ? `The title gets a new year, but only ${changedBlocks} paragraph(s) changed: Google may see this as a date-only update.` : `${changedBlocks} paragraph(s) or rows changed.`);

  const future = years(`${i.titleAfter} ${i.metaDescription ?? ''}`).filter((y) => y > now.getFullYear());
  add('future-year', 'No year after this one in the title', future.length === 0, true, future.length ? `Names ${future.join(', ')}.` : 'OK.');

  const metaLen = i.metaDescription?.length ?? 0;
  add('meta', 'Meta description length', !i.metaDescription || (metaLen >= 110 && metaLen <= 170), false, i.metaDescription ? `${metaLen} characters (good: 120–160).` : 'Not changed.');
  return checks;
}

export const blockingFailures = (checks: UpdateCheck[]) => checks.filter((c) => c.blocking && !c.passed);
