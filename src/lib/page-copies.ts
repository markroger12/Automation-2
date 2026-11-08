import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { dataPaths, safeJoin } from './paths';

/**
 * Page structure copies (owner request: “save the page's structure when photos are missing, so the real page can be
 * fixed instead of guessed”). The extension sends an outline of ChatGPT's gallery and viewer, or of Search Console's
 * dialog — elements, button names, sizes, never the page's text (extension/outline.js) — and it is kept in
 * data/page-copies for the owner to send to the developer (Logs / Diagnostics → Page structure copies).
 */
export const PAGE_COPY_KINDS = ['chatgpt-gallery', 'search-console'] as const;
export type PageCopyKind = (typeof PAGE_COPY_KINDS)[number];
const NAME = /^(chatgpt-gallery|search-console)-\d{8}-\d{6}-[0-9a-f]{6}\.json$/;
/** The newest copies kept; older ones are removed when a new one is saved. */
const KEEP = 40;

export interface PageCopyInfo {
  name: string;
  kind: PageCopyKind;
  bytes: number;
  savedAt: string;
}

/** “20261030-164500-a1b2c3” from a copy's name: sorts by time. */
const when = (name: string) => name.replace(/^.*?-(\d{8}-\d{6}-[0-9a-f]{6})\.json$/, '$1');
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** Save a copy the extension sent; null when it is not a JSON object of the expected kind. */
export function savePageCopy(kind: PageCopyKind, raw: string, now = new Date()): string | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || (data as { kind?: unknown }).kind !== kind) return null;
  const dir = dataPaths.pageCopies();
  fs.mkdirSync(dir, { recursive: true });
  const name = `${kind}-${stamp(now)}-${randomBytes(3).toString('hex')}.json`;
  fs.writeFileSync(safeJoin(dir, name), JSON.stringify({ ...(data as object), savedAt: now.toISOString() }, null, 1));
  for (const old of listPageCopies().slice(KEEP)) fs.rmSync(safeJoin(dir, old.name), { force: true });
  return name;
}

/** The copies, newest first. */
export function listPageCopies(): PageCopyInfo[] {
  const dir = dataPaths.pageCopies();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => NAME.test(n))
    .map((name) => {
      const stat = fs.statSync(safeJoin(dir, name));
      return { name, kind: (name.startsWith('search-console') ? 'search-console' : 'chatgpt-gallery') as PageCopyKind, bytes: stat.size, savedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => when(b.name).localeCompare(when(a.name)));
}

/** One copy's content, or null for a name that is not a copy. */
export function readPageCopy(name: string): Buffer | null {
  if (!NAME.test(name)) return null;
  const file = safeJoin(dataPaths.pageCopies(), name);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}
