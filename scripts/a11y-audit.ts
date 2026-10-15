/**
 * Accessibility audit of the running dashboard (axe-core, WCAG 2.1 A/AA) in
 * light and dark mode. Start the app first (`npm run start:all` or
 * `npm run dev:all`), then: `npm run audit:a11y` (optional base URL argument,
 * loopback only). Exits non-zero when a serious or critical violation is found.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { loadEnv } from '../src/lib/env';
import { browserLaunchBase } from '../src/lib/browser-launch';

loadEnv();
const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/+$/, '');
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
  console.error('Only the local dashboard (http://localhost or http://127.0.0.1) can be audited.');
  process.exit(2);
}

const ROUTES = ['/', '/single-article', '/queue', '/campaigns', '/campaigns/new', '/history', '/writers', '/websites', '/prompts', '/editorial', '/humanizer', '/plagiarism', '/duplicates', '/research-evidence', '/workflow', '/calendar', '/image-templates', '/settings', '/logs', '/diagnostics', '/recovery', '/automation-chrome', '/help'];
const axeSource = fs.readFileSync(path.join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');

interface Violation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[] }[];
}

const browser = await chromium.launch({ ...browserLaunchBase(), headless: true });
let serious = 0;
try {
  const routes = [...ROUTES];
  // Include one article page and one website page when there are some.
  {
    const page = await browser.newPage();
    for (const [list, prefix] of [['/queue', '/articles/'], ['/websites', '/websites/']] as const) {
      await page.goto(`${base}${list}`);
      await page.locator(`a[href^="${prefix}"]`).first().waitFor({ timeout: 5000 }).catch(() => {});
      const hrefs = await page.locator(`a[href^="${prefix}"]`).evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? '')).catch(() => [] as string[]);
      const href = hrefs.map((h) => h.split('?')[0]).find((h) => /^\/(articles|websites)\/[a-z0-9]{20,}$/.test(h));
      if (href) routes.push(href);
    }
    await page.close();
  }
  for (const scheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    for (const route of routes) {
      await page.goto(`${base}${route}`, { waitUntil: 'networkidle' }).catch(() => page.goto(`${base}${route}`));
      await page.addScriptTag({ content: axeSource });
      const result = (await page.evaluate(`axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })`)) as { violations: Violation[] };
      const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      serious += bad.length;
      const label = `${scheme.padEnd(5)} ${route}`;
      if (!result.violations.length) console.log(`ok    ${label}`);
      for (const v of result.violations) console.log(`${(v.impact ?? 'minor').padEnd(8)} ${label}  ${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}${v.nodes.length > 3 ? ` (+${v.nodes.length - 3})` : ''}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(serious ? `\n${serious} serious/critical violation(s).` : '\nNo serious or critical violations.');
process.exit(serious ? 1 : 0);
