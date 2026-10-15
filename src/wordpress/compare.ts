import { load } from 'cheerio';

/**
 * Text-block comparison of the app's article and a WordPress version of the
 * same draft (block comments and markup ignored). Used to show the owner
 * what an overwrite would replace before they decide.
 */
export function textBlocks(html: string): string[] {
  const $ = load(`<body>${html.replace(/<!--[\s\S]*?-->/g, '')}</body>`);
  const out: string[] = [];
  $('h1, h2, h3, h4, h5, h6, p, li, th, td, blockquote, figcaption, pre').each((_, el) => {
    const node = $(el);
    // Only the innermost text-bearing element counts (a <p> inside <li>/<td> is read once).
    if (node.find('p, li, h1, h2, h3, h4, h5, h6, td, th').length) return;
    const text = node.text().replace(/\s+/g, ' ').trim();
    if (text) out.push(text);
  });
  return out;
}

export interface VersionComparison {
  /** Text only in the WordPress version: an overwrite would replace it. */
  onlyInWordPress: string[];
  /** Text only in the app version: an overwrite would add it. */
  onlyInApp: string[];
  unchanged: number;
}

export function compareVersions(appHtml: string, wordpressHtml: string, limit = 60): VersionComparison {
  const app = textBlocks(appHtml);
  const remote = textBlocks(wordpressHtml);
  const counts = new Map<string, number>();
  for (const b of app) counts.set(b, (counts.get(b) ?? 0) + 1);
  const onlyInWordPress: string[] = [];
  let unchanged = 0;
  for (const b of remote) {
    const n = counts.get(b) ?? 0;
    if (n > 0) {
      counts.set(b, n - 1);
      unchanged++;
    } else onlyInWordPress.push(b);
  }
  const onlyInApp: string[] = [];
  for (const b of app) {
    const n = counts.get(b) ?? 0;
    if (n > 0) {
      onlyInApp.push(b);
      counts.set(b, n - 1);
    }
  }
  return { onlyInWordPress: onlyInWordPress.slice(0, limit), onlyInApp: onlyInApp.slice(0, limit), unchanged };
}
