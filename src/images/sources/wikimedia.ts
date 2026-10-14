import { safeFetch } from '@/lib/links/net';
import { normalizeText } from '@/lib/content/text';
import { hammingDistance, MAX_IMAGE_BYTES, storeImage } from '../store';

/**
 * Bounded celebrity gallery from Wikimedia Commons (no API key). Downloads go
 * through the SSRF-safe fetcher (12 MB cap, private hosts blocked), images are
 * normalized through sharp (metadata stripped), exact duplicates are removed by
 * SHA-256 and near-duplicates by perceptual hash. The source URL is stored as
 * technical provenance only — no rights/licensing checks are performed.
 */

interface CommonsPage {
  title: string;
  imageinfo?: { url: string; thumburl?: string; width: number; height: number; mime: string; descriptionurl?: string }[];
}

export interface GalleryResult {
  assets: { id: string; sourceUrl: string; title: string; width: number; height: number; phash: string | null }[];
  notes: string[];
}

const SKIP_TITLE = /(logo|signature|autograph|\bmap\b|flag|coat of arms|wappen|poster|cover|album|diagram|chart|icon|stamp|screenshot|plakat|unterschrift|karte)/i;
const UA = 'BlogAutomationStudio/3.0 (local editorial tool; image gallery)';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
let apiBase = COMMONS_API;

/** Tests point the gallery at a local stand-in (plain HTTP, random port). */
export function setCommonsApiBaseForTests(base: string | null) {
  apiBase = base ?? COMMONS_API;
}

export function commonsSearchUrl(name: string, limit = 20): string {
  const q = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrnamespace: '6',
    gsrlimit: String(limit),
    gsrsearch: `${name} filetype:bitmap`,
    prop: 'imageinfo',
    iiprop: 'url|size|mime',
    iiurlwidth: '1600',
  });
  return `${apiBase}?${q}`;
}

/** Rank candidates: subject words in the file name, then size; drop logos/signatures/odd shapes/small files. */
export function rankCommons(name: string, pages: CommonsPage[]): { page: CommonsPage; score: number; url: string; reason?: string }[] {
  const tokens = normalizeText(name).split(' ').filter((t) => t.length >= 3);
  const out: { page: CommonsPage; score: number; url: string; reason?: string }[] = [];
  for (const p of pages) {
    const info = p.imageinfo?.[0];
    if (!info) continue;
    const url = info.thumburl ?? info.url;
    const title = normalizeText(p.title.replace(/^File:/i, ''));
    const ratio = info.width / Math.max(1, info.height);
    let reason: string | undefined;
    if (!/image\/(jpeg|png|webp)/.test(info.mime)) reason = `unsupported type ${info.mime}`;
    else if (SKIP_TITLE.test(p.title)) reason = 'not a photo of the person (logo/signature/map/poster)';
    else if (info.width < 700 || info.height < 500) reason = `too small (${info.width}×${info.height})`;
    else if (ratio < 0.5 || ratio > 2.6) reason = `unusual shape (${ratio.toFixed(2)})`;
    const hits = tokens.filter((t) => title.includes(t)).length;
    if (!reason && tokens.length && hits === 0) reason = 'file name does not mention the person';
    out.push({ page: p, url, score: hits * 10 + Math.min(info.width * info.height, 6_000_000) / 1_000_000, reason });
  }
  return out.sort((a, b) => b.score - a.score);
}

export async function collectCommonsGallery(input: { name: string; taskId: string; websiteId: string; max: number; timeoutMs: number; nearDuplicateDistance?: number }): Promise<GalleryResult> {
  const notes: string[] = [];
  const res = await safeFetch(commonsSearchUrl(input.name), { timeoutMs: input.timeoutMs, maxBytes: 2_000_000, userAgent: UA, accept: 'application/json' });
  if (res.status !== 200) throw new Error(`Wikimedia Commons answered HTTP ${res.status}`);
  const pages = ((JSON.parse(res.body) as { query?: { pages?: CommonsPage[] } }).query?.pages ?? []) as CommonsPage[];
  const ranked = rankCommons(input.name, pages);
  for (const r of ranked.filter((x) => x.reason).slice(0, 8)) notes.push(`Skipped “${r.page.title}”: ${r.reason}.`);
  const assets: GalleryResult['assets'] = [];
  const seen = new Set<string>();
  for (const r of ranked.filter((x) => !x.reason)) {
    if (assets.length >= input.max) break;
    try {
      const img = await safeFetch(r.url, { timeoutMs: input.timeoutMs, maxBytes: MAX_IMAGE_BYTES, userAgent: UA, accept: 'image/*' });
      if (img.status !== 200) {
        notes.push(`Download failed for “${r.page.title}” (HTTP ${img.status}).`);
        continue;
      }
      const { asset, duplicate } = await storeImage({ buffer: img.buffer, taskId: input.taskId, websiteId: input.websiteId, role: 'GALLERY', origin: 'WIKIMEDIA', sourceUrl: r.page.imageinfo?.[0]?.descriptionurl ?? r.url, notes: r.page.title.slice(0, 180) });
      // A file already stored for this task from an earlier run is reused; a repeat within this run is a duplicate.
      if (duplicate && (seen.has(asset.id) || asset.origin !== 'WIKIMEDIA')) {
        notes.push(`“${r.page.title}” is an exact duplicate; skipped.`);
        continue;
      }
      seen.add(asset.id);
      if (asset.status === 'REJECTED') {
        notes.push(`“${r.page.title}” was removed by you earlier; skipped.`);
        continue;
      }
      const near = asset.phash ? assets.find((a) => a.phash && hammingDistance(a.phash, asset.phash!) <= (input.nearDuplicateDistance ?? 6)) : null;
      if (near) {
        notes.push(`“${r.page.title}” looks like a crop of “${near.title}”; skipped.`);
        continue;
      }
      assets.push({ id: asset.id, sourceUrl: asset.sourceUrl ?? r.url, title: r.page.title, width: asset.width ?? 0, height: asset.height ?? 0, phash: asset.phash });
    } catch (error) {
      notes.push(`Could not use “${r.page.title}”: ${(error as Error).message}`);
    }
  }
  return { assets, notes };
}
