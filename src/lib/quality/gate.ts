import { load } from 'cheerio';
import { detectLanguage, stripTags, wordCount } from '../content/text';
import type { SeoReport } from '../seo/checks';
import { isCelebrityModule } from '../domain';
import { matchMetaLine } from '../content/meta-lines';
import { customFaqRule, keepsAnswerOrder, profileTableFor } from '../writers/rules';

export interface QualityInput {
  html: string;
  moduleKey: string;
  language: string;
  keyword: string;
  seo: SeoReport;
  reviewThreshold: number;
  densityCeilingPct: number;
  expectedFaqCount: number;
  categoryValid: boolean;
  assemblyWarnings: string[];
  imagesRequired: boolean;
  imagesPresent: number;
  extraWarnings?: string[];
  extraHardStops?: string[];
}

export interface QualityFinding {
  code: string;
  message: string;
  /** Where to look (stage key or section). */
  source: string;
}

export interface QualityResult {
  hardStops: QualityFinding[];
  warnings: QualityFinding[];
  passed: boolean;
}

const CHATBOT_REMNANTS = [
  /\bas an ai(?: language model)?\b/i,
  /\bi (?:cannot|can't|am unable to) (?:browse|access|verify)\b/i,
  /\bhere(?:'s| is) (?:the|your) (?:revised|final|updated) article\b/i,
  /\bword count\s*:/i,
  /\{\{\s*[a-z_#/]+/i,
  /⟦[a-z_]+:/i,
  /\bals ki(?:-sprachmodell)?\b/i,
];

/**
 * Hard stops (pause BEFORE WordPress): broken structure or unpublishable
 * content. Warnings (draft still created, task ends in NEEDS_REVIEW): soft
 * quality issues. Never adds or changes facts to make a check pass.
 */
export function evaluateQuality(input: QualityInput): QualityResult {
  const hardStops: QualityFinding[] = [];
  const warnings: QualityFinding[] = [];
  const text = stripTags(input.html);
  const words = wordCount(text);
  const m = input.seo.metrics;

  if (words < 300) hardStops.push({ code: 'BODY_TOO_SHORT', message: `The article has only ${words} words.`, source: 'ASSEMBLY' });
  for (const re of CHATBOT_REMNANTS) {
    const hit = text.match(re);
    if (hit) hardStops.push({ code: 'UNPUBLISHABLE_TEXT', message: `Unpublishable model/template text found: “${hit[0]}”.`, source: 'ASSEMBLY' });
  }
  const lang = detectLanguage(text);
  if (lang.language !== 'unknown' && lang.language !== input.language && lang.confidence > 0.7) {
    hardStops.push({ code: 'WRONG_LANGUAGE', message: `The article reads as ${lang.language === 'de' ? 'German' : 'English'} but the task language is ${input.language === 'de' ? 'German' : 'English'}.`, source: 'FINAL_ARTICLE' });
  }
  // Celebrity 2 and the owner's writers write their FAQs and their facts table in the ARTICLE answer.
  const oneAnswer = keepsAnswerOrder(input.moduleKey);
  const faqRule = customFaqRule(input.moduleKey);
  const exactFaqs = faqRule ? faqRule.exact : isCelebrityModule(input.moduleKey);
  if (input.expectedFaqCount > 0 && m.faqCount === 0) hardStops.push({ code: 'FAQ_MISSING', message: 'The FAQ section is missing.', source: input.moduleKey === 'celebrity-writer' ? 'FAQS' : 'ARTICLE' });
  else if (input.expectedFaqCount > 0 && (exactFaqs ? m.faqCount !== input.expectedFaqCount : Math.abs(m.faqCount - input.expectedFaqCount) > 2) && (exactFaqs || faqRule)) {
    warnings.push({ code: 'FAQ_COUNT', message: `${m.faqCount} FAQs instead of ${exactFaqs ? 'exactly' : 'about'} ${input.expectedFaqCount}.`, source: oneAnswer ? 'ARTICLE' : 'FAQS' });
  }
  // The person's facts table: Quick Bio (Celebrity), Family Profile (Celebrity 2), the owner's person writers' table.
  const profile = input.moduleKey === 'celebrity-writer' ? { required: true, heading: 'Quick Bio' } : profileTableFor(input.moduleKey, input.language);
  if (profile) {
    if (m.quickBioRows === null) {
      if (profile.required) hardStops.push({ code: 'BIO_MISSING', message: `The ${profile.heading} table is missing.`, source: oneAnswer ? 'ARTICLE' : 'QUICK_BIO' });
    } else if (m.quickBioColumnsOk === false) hardStops.push({ code: 'BIO_MALFORMED', message: `The ${profile.heading} table does not have exactly two columns.`, source: oneAnswer ? 'ARTICLE' : 'QUICK_BIO' });
  }
  if (m.densityPct > input.densityCeilingPct * 1.4) hardStops.push({ code: 'KEYWORD_STUFFING', message: `Keyword density ${m.densityPct}% is far above the ${input.densityCeilingPct}% ceiling (keyword stuffing).`, source: 'FINAL_ARTICLE' });
  else if (m.densityPct > input.densityCeilingPct) warnings.push({ code: 'KEYWORD_DENSITY', message: `Keyword density ${m.densityPct}% is above the ${input.densityCeilingPct}% ceiling.`, source: 'FINAL_ARTICLE' });
  if (!input.categoryValid) hardStops.push({ code: 'CATEGORY_INVALID', message: 'The category is not one of the website’s synchronized categories.', source: 'PRECHECK' });
  const $ = load(`<body>${input.html}</body>`);
  if ($('script, iframe, style').length) hardStops.push({ code: 'UNSAFE_HTML', message: 'Executable or embedded markup survived assembly.', source: 'ASSEMBLY' });
  // Owner report (“Ricardo Joel Gomez”): the answer's “SEO Title: …” lines reached the WordPress article. Assembly
  // takes them out of the introduction; one left anywhere in a person article stops it before WordPress.
  if (isCelebrityModule(input.moduleKey)) {
    const left = $('p, li')
      .toArray()
      .map((el) => $(el).text().replace(/\s+/g, ' ').trim())
      .find((t) => matchMetaLine(t));
    if (left) hardStops.push({ code: 'SEO_LINES_IN_TEXT', message: `The article text contains an SEO line that belongs in the SEO fields: “${left.slice(0, 80)}”.`, source: 'ARTICLE' });
  }

  if (input.seo.score < input.reviewThreshold) {
    const failed = input.seo.checks.filter((c) => !c.passed && c.severity === 'error').map((c) => c.label);
    warnings.push({ code: 'SEO_BELOW_THRESHOLD', message: `SEO readiness ${input.seo.score} is below ${input.reviewThreshold}. Failed: ${failed.join('; ') || 'see SEO tab'}.`, source: 'SEO_CHECK' });
  }
  // Counted outside tables: in the Quick Bio table it is the intended fallback for an unknown row (owner report).
  const prose = load(`<body>${input.html}</body>`);
  prose('table').remove();
  const notConfirmed = (prose('body').text().match(/not publicly confirmed|nicht öffentlich bestätigt/gi) ?? []).length;
  if (notConfirmed > 4) warnings.push({ code: 'REPEATED_UNCERTAINTY', message: `“Not publicly confirmed” appears ${notConfirmed} times — use it only as a fallback.`, source: 'FINAL_ARTICLE' });
  if (input.imagesRequired && input.imagesPresent === 0) warnings.push({ code: 'IMAGES_MISSING', message: 'Images are required for this site but none could be added.', source: 'IMAGES' });
  for (const w of input.assemblyWarnings) warnings.push({ code: 'ASSEMBLY', message: w, source: 'ASSEMBLY' });
  for (const w of input.extraWarnings ?? []) warnings.push({ code: 'STAGE', message: w, source: 'PIPELINE' });
  for (const h of input.extraHardStops ?? []) hardStops.push({ code: 'STAGE', message: h, source: 'PIPELINE' });
  return { hardStops, warnings, passed: hardStops.length === 0 };
}
