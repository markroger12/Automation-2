import { describe, expect, it } from 'vitest';
import { answerBlocks, inlineParts } from '@/lib/assistant/format';

/** The help assistant's answers (Gemini Markdown) as safe blocks; owner report 2026-11-12. */
describe('help assistant answer format', () => {
  it('keeps the numbering after indented sub-points and across blank lines', () => {
    const text = 'To add a website:\n\n1.  Open **Websites**.\n2.  Click **Add website**.\n3.  Fill in:\n    *   **Address** (e.g. `https://example.com`)\n    *   User name and password\n\n4.  Click **Add and log in**.\n\nDone.';
    expect(answerBlocks(text)).toEqual([
      { kind: 'p', text: 'To add a website:' },
      {
        kind: 'list',
        ordered: true,
        start: 1,
        items: [
          { text: 'Open **Websites**.', sub: [] },
          { text: 'Click **Add website**.', sub: [] },
          { text: 'Fill in:', sub: ['**Address** (e.g. `https://example.com`)', 'User name and password'] },
          { text: 'Click **Add and log in**.', sub: [] },
        ],
      },
      { kind: 'p', text: 'Done.' },
    ]);
  });

  it('headings, bullets, code fences, Windows line ends, and anything that is not text', () => {
    expect(answerBlocks('## Steps\r\n* one\r\n- two\r\n```\ncode line\n```\n5) five')).toEqual([
      { kind: 'h', text: 'Steps' },
      { kind: 'list', ordered: false, start: 1, items: [{ text: 'one', sub: [] }, { text: 'two', sub: [] }] },
      { kind: 'p', text: 'code line' },
      { kind: 'list', ordered: true, start: 5, items: [{ text: 'five', sub: [] }] },
    ]);
    expect(answerBlocks(undefined)).toEqual([]);
    expect(answerBlocks(42)).toEqual([{ kind: 'p', text: '42' }]);
    expect(answerBlocks('')).toEqual([]);
  });

  it('bold and code inline; unclosed marks stay plain text', () => {
    expect(inlineParts('Open **Settings** → `Help assistant` now')).toEqual([
      { kind: 'text', text: 'Open ' },
      { kind: 'bold', text: 'Settings' },
      { kind: 'text', text: ' → ' },
      { kind: 'code', text: 'Help assistant' },
      { kind: 'text', text: ' now' },
    ]);
    expect(inlineParts('a **b and `c')).toEqual([{ kind: 'text', text: 'a **b and `c' }]);
    expect(inlineParts('')).toEqual([]);
  });
});
