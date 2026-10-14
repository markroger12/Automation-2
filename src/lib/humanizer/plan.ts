import { load } from 'cheerio';
import { words } from '@/lib/content/text';
import { describeFlags, diagnose, flagParagraph, isFlagged, observations, type EditorialDiagnostics } from './analyze';
import { plainText, restoreParagraph, tokenizeParagraph, type LinkMark } from './tokens';
import { validateRewrite, type FactLockContext } from './validate';

/**
 * Humanizer planning and application. Paragraphs of the body get stable
 * labels [P1]…; eligible ones are batched (~N words) and sent with the local
 * editor's flags and article-wide observations; answers are validated per
 * paragraph against the fact locks and applied to the ORIGINAL HTML.
 */

export type HumanizerScope = 'all' | 'flagged';

export interface PlannedParagraph {
  id: string;
  /** Position among the body's top-level paragraphs (for applying results). */
  index: number;
  html: string;
  marked: string;
  text: string;
  links: LinkMark[];
  words: number;
  flags: string[];
  /** Why the paragraph is not sent (null = eligible). */
  skip: string | null;
}

export interface HumanizePlan {
  paragraphs: PlannedParagraph[];
  batches: { index: number; ids: string[]; words: number }[];
  observations: string[];
  before: EditorialDiagnostics;
}

export interface PlanOptions {
  language: string;
  scope: HumanizerScope;
  batchWords: number;
}

const MIN_WORDS = 12;

/** Top-level body paragraphs only: never tables, lists, quotes, figures, FAQ answers or the internal-link line. */
function bodyParagraphs(html: string) {
  const $ = load(`<body>${html}</body>`);
  return { $, nodes: $('body > p').toArray() };
}

export function planHumanize(html: string, opts: PlanOptions): HumanizePlan {
  const { $, nodes } = bodyParagraphs(html);
  const paragraphs: PlannedParagraph[] = [];
  let label = 0;
  nodes.forEach((node, index) => {
    const el = $(node);
    const inner = el.html() ?? '';
    const tokens = tokenizeParagraph(inner);
    const text = tokens ? plainText(tokens.text) : el.text().trim();
    const count = words(text).length;
    let skip: string | null = null;
    if (el.attr('data-bas-internal-link') !== undefined) skip = 'internal-link line (added back at assembly)';
    else if (!tokens) skip = 'contains markup that cannot be edited safely';
    else if (count < MIN_WORDS) skip = 'too short to edit';
    const flags = describeFlags(flagParagraph(text, opts.language));
    if (!skip && opts.scope === 'flagged' && !isFlagged(flagParagraph(text, opts.language))) skip = 'no issues flagged (flagged-only mode)';
    if (skip === 'internal-link line (added back at assembly)') return;
    label++;
    paragraphs.push({ id: `P${label}`, index, html: inner, marked: tokens?.text ?? '', text, links: tokens?.links ?? [], words: count, flags, skip });
  });
  const before = diagnose(paragraphs.map((p) => p.text), opts.language);
  const batches: HumanizePlan['batches'] = [];
  let current: { index: number; ids: string[]; words: number } | null = null;
  for (const p of paragraphs.filter((x) => !x.skip)) {
    if (!current || (current.words >= opts.batchWords * 0.6 && current.words + p.words > opts.batchWords)) {
      current = { index: batches.length, ids: [], words: 0 };
      batches.push(current);
    }
    current.ids.push(p.id);
    current.words += p.words;
  }
  return { paragraphs, batches, observations: observations(before), before };
}

/** Prompt variables for one batch: labelled paragraphs and the editor's problem list. */
export function batchVariables(plan: HumanizePlan, batchIndex: number): { paragraphs: string; problems: string } {
  const batch = plan.batches[batchIndex];
  const items = batch.ids.map((id) => plan.paragraphs.find((p) => p.id === id)!);
  const problems = [...items.filter((p) => p.flags.length).map((p) => `[${p.id}] ${p.flags.join('; ')}`), ...plan.observations];
  return {
    paragraphs: items.map((p) => `[${p.id}]\n${p.marked}`).join('\n\n'),
    problems: problems.join('\n'),
  };
}

/** Split an answer into labelled paragraphs. Text after a label up to the next label belongs to it. */
export function parseLabelled(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const cleaned = text.replace(/^```[a-z]*\s*$/gim, '');
  const re = /^\s*(?:\*\*)?\[(P\d+)\](?:\*\*)?[ \t]*(.*)$/gim;
  const marks: { id: string; start: number; rest: string; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) marks.push({ id: m[1].toUpperCase(), start: m.index, rest: m[2], end: re.lastIndex });
  marks.forEach((mk, i) => {
    const until = i + 1 < marks.length ? marks[i + 1].start : cleaned.length;
    const body = `${mk.rest}\n${cleaned.slice(mk.end, until)}`.trim();
    if (!out.has(mk.id)) out.set(mk.id, body);
  });
  return out;
}

export interface ParagraphResult {
  id: string;
  status: 'rewritten' | 'kept' | 'unchanged' | 'skipped';
  original: string;
  /** Plain text of the rewrite (shown even when rejected, so the owner sees what was refused). */
  edited: string | null;
  /** Marked rewrite used to rebuild the HTML (accepted rewrites only). */
  marked: string | null;
  reasons: string[];
  flags: string[];
}

/** Validate one batch answer (or a failure) into per-paragraph results. */
export function evaluateBatch(plan: HumanizePlan, batchIndex: number, answer: string | { error: string }, ctx: FactLockContext): ParagraphResult[] {
  const batch = plan.batches[batchIndex];
  const parsed = typeof answer === 'string' ? parseLabelled(answer) : new Map<string, string>();
  return batch.ids.map((id) => {
    const p = plan.paragraphs.find((x) => x.id === id)!;
    if (typeof answer !== 'string') return { id, status: 'kept', original: p.text, edited: null, marked: null, reasons: [`ChatGPT did not answer this batch: ${answer.error}`], flags: p.flags };
    const rewrite = parsed.get(id);
    if (rewrite === undefined) return { id, status: 'kept', original: p.text, edited: null, marked: null, reasons: ['ChatGPT did not return this paragraph.'], flags: p.flags };
    const normalized = rewrite.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
    if (plainText(normalized) === p.text && normalized === p.marked) return { id, status: 'unchanged', original: p.text, edited: null, marked: null, reasons: [], flags: p.flags };
    const reasons = validateRewrite(p.marked, normalized, ctx);
    if (reasons.length) return { id, status: 'kept', original: p.text, edited: plainText(normalized), marked: null, reasons, flags: p.flags };
    return { id, status: 'rewritten', original: p.text, edited: plainText(normalized), marked: normalized, reasons: [], flags: p.flags };
  });
}

/** Results for paragraphs that were never sent. */
export function skippedResults(plan: HumanizePlan): ParagraphResult[] {
  return plan.paragraphs.filter((p) => p.skip).map((p) => ({ id: p.id, status: 'skipped', original: p.text, edited: null, marked: null, reasons: [p.skip!], flags: p.flags }));
}

/** Apply accepted rewrites to the original HTML (everything else is untouched). */
export function applyResults(html: string, plan: HumanizePlan, results: ParagraphResult[]): string {
  const { $, nodes } = bodyParagraphs(html);
  for (const r of results) {
    if (r.status !== 'rewritten' || !r.marked) continue;
    const p = plan.paragraphs.find((x) => x.id === r.id);
    const node = p ? nodes[p.index] : undefined;
    if (!p || !node) continue;
    $(node).html(restoreParagraph(r.marked, p.links));
  }
  return $('body').html() ?? html;
}

export interface HumanizeSummary {
  rewritten: number;
  kept: number;
  unchanged: number;
  skipped: number;
  before: EditorialDiagnostics;
  after: EditorialDiagnostics;
}

/** Counts plus before/after editorial diagnostics (never an AI-detection score). */
export function summarize(plan: HumanizePlan, results: ParagraphResult[], language: string): HumanizeSummary {
  const count = (s: ParagraphResult['status']) => results.filter((r) => r.status === s).length;
  const afterTexts = plan.paragraphs.map((p) => {
    const r = results.find((x) => x.id === p.id);
    return r?.status === 'rewritten' && r.edited ? r.edited : p.text;
  });
  return { rewritten: count('rewritten'), kept: count('kept'), unchanged: count('unchanged'), skipped: count('skipped'), before: plan.before, after: diagnose(afterTexts, language) };
}
