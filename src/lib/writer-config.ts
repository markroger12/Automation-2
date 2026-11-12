import type { EffectiveTaskConfig } from './settings-schema';
import { customFaqRule, customWordRange } from './writers/rules';

/**
 * Per-writer numbers used by the prompts, the SEO check and the quality gate. Celebrity 2's prompt asks for exactly
 * five FAQs and a 1,200–1,300-word main body; with the direct answer, the Family Profile table and the FAQs the whole
 * article is about 1,350–1,650 words (the owner's Andrea Soros example: see tests/unit/celebrity2-writer.test.ts).
 */
export const CELEBRITY2_FAQ_COUNT = 5;
export const CELEBRITY2_WORD_RANGE: [number, number] = [1300, 1600];

export function expectedFaqCount(moduleKey: string, config: Pick<EffectiveTaskConfig, 'faqCount' | 'tigramFaqCount'>): number {
  if (moduleKey === 'tigram-writer') return config.tigramFaqCount;
  if (moduleKey === 'celebrity2-writer') return CELEBRITY2_FAQ_COUNT;
  const custom = customFaqRule(moduleKey);
  if (custom) return custom.count;
  return config.faqCount;
}

/** Word range checked by the SEO check, or null (the Celebrity writer: at most `maxWords`). */
export function wordRangeFor(moduleKey: string, config: Pick<EffectiveTaskConfig, 'tigramWordRange'>): [number, number] | null {
  if (moduleKey === 'celebrity2-writer') return CELEBRITY2_WORD_RANGE;
  const custom = customWordRange(moduleKey);
  if (custom) return custom;
  if (moduleKey !== 'tigram-writer') return null;
  const range = config.tigramWordRange.split(/\s*[-–]\s*/).map(Number);
  return range.length === 2 && range.every(Number.isFinite) ? [range[0], range[1]] : null;
}
