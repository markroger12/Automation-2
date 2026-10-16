import { describe, expect, it } from 'vitest';
import { fieldsMatch } from '@/wordpress/rank-math';
import { endAtBoundary } from '@/worker/pipelines/common';
import { evaluateQuality, type QualityInput } from '@/lib/quality/gate';

/** Review reasons from the owner's reports (Dixie Brubaker, Mary Joan Schutz) that were not real problems. */
describe('owner report: review reasons that were not real problems', () => {
  it('Rank Math shows D\'Souza for D’Souza: the same meta description', () => {
    const want = 'Dixie Brubaker is best known as the former wife of Dinesh D’Souza. The couple married in May 1992 — and had a daughter…';
    const shown = "Dixie Brubaker is best known as the former wife of Dinesh D'Souza. The couple married in May 1992 - and had a daughter...";
    expect(fieldsMatch({ focusKeyword: 'dixie brubaker', title: 'T', description: want }, { focusKeyword: 'dixie brubaker', title: 'T', description: shown }).ok).toBe(true);
    expect(fieldsMatch({ focusKeyword: 'dixie brubaker', title: 'T', description: want }, { focusKeyword: 'dixie brubaker', title: 'T', description: 'Other text' }).ok).toBe(false);
  });

  it('a meta description from the intro ends at a sentence or clause, not mid-phrase (“… spent more”)', () => {
    const intro = 'Dixie Brubaker is best known as the former wife of American conservative author and filmmaker Dinesh D’Souza. The couple married in May 1992, spent more than two decades together and had one daughter.';
    const meta = endAtBoundary(intro, 156, 120);
    expect(meta).toBe('Dixie Brubaker is best known as the former wife of American conservative author and filmmaker Dinesh D’Souza. The couple married in May 1992.');
    expect(meta.length).toBeLessThanOrEqual(156);
    expect(endAtBoundary('Short enough.', 156, 120)).toBe('Short enough.');
    const words = 'word '.repeat(60).trim();
    expect(endAtBoundary(words, 156, 120).endsWith('…')).toBe(true);
    expect(endAtBoundary(words, 156, 120).length).toBeLessThanOrEqual(156);
  });

  it('“Not publicly confirmed” in Quick Bio rows is the intended fallback; only prose counts', () => {
    const rows = Array.from({ length: 8 }, (_, i) => `<tr><td>Row ${i}</td><td>Not publicly confirmed</td></tr>`).join('');
    const base = { moduleKey: 'celebrity-writer', language: 'en', keyword: 'x', densityCeilingPct: 2.5, expectedFaqCount: 5, categoryValid: true, reviewThreshold: 0, seo: { score: 100, checks: [], metrics: { faqCount: 5, quickBioRows: 8, quickBioColumnsOk: true, densityPct: 1 } }, imagesRequired: false, imagesPresent: 1, assemblyWarnings: [] } as unknown as QualityInput;
    const inTable = evaluateQuality({ ...base, html: `<p>Intro.</p><table>${rows}</table>` } as QualityInput);
    expect(inTable.warnings.map((w) => w.code)).not.toContain('REPEATED_UNCERTAINTY');
    const inProse = evaluateQuality({ ...base, html: `<p>${'Her age is not publicly confirmed. '.repeat(5)}</p>` } as QualityInput);
    expect(inProse.warnings.map((w) => w.code)).toContain('REPEATED_UNCERTAINTY');
  });
});
