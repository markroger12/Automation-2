import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Owner report 2026-11-12 (3.3.34, found by the owner's QA agent): the help assistant crashed on every answer with
 * “TypeError: u is not a function”. Its effect was `useEffect(() => ref.current?.scrollIntoView(...), [...])`, and in
 * the app's Chromium 152 scrollIntoView() returns a Promise, which React then called as the effect's cleanup. An effect
 * must return nothing or a cleanup function, so the dashboard writes effects with a block body (or `() => () => …`).
 */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name.startsWith('.') ? [] : sources(p);
    return /\.(tsx?|jsx?)$/.test(e.name) ? [p] : [];
  });
}

describe('React effects', () => {
  it('never return the value of an expression (only nothing or a cleanup function)', () => {
    const root = path.resolve(__dirname, '..', '..');
    const offenders: string[] = [];
    for (const file of [...sources(path.join(root, 'app')), ...sources(path.join(root, 'src'))]) {
      const text = fs.readFileSync(file, 'utf8');
      const re = /use(?:Layout|Insertion)?Effect\(\s*(?:async\s*)?\(\s*\)\s*=>\s*(?![\s{]|\(\s*\)\s*=>)/g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const line = text.slice(0, m.index).split('\n').length;
        offenders.push(`${path.relative(root, file)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
