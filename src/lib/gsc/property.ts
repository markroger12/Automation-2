import { db } from '../db';
import { log } from '../log';
import { siteProperty } from '../search-performance/service';
import { listProperties, readKey } from './client';

/**
 * Which Search Console property to use for a website (owner report: a website added in Search Console as a URL-prefix
 * property, “https://easyvibs.co.uk/”, was asked for as “sc-domain:easyvibs.co.uk” and Google refused). The service
 * account's own list of properties decides: the configured one when the account can use it, otherwise the property of
 * the same website that it can use — the domain property first, then the URL prefix of the website address, then its
 * www / non-www and http variants.
 */

export interface AccessibleProperty {
  siteUrl: string;
  permissionLevel: string;
}

const usable = (p: AccessibleProperty) => p.permissionLevel !== 'siteUnverifiedUser';

/** The properties that can stand for this website address, best first. */
export function propertyCandidates(publicUrl: string): string[] {
  let u: URL;
  try {
    u = new URL(publicUrl);
  } catch {
    return [];
  }
  const host = u.hostname.toLowerCase();
  const bare = host.replace(/^www\./, '');
  const path = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
  const hosts = [host, host === bare ? `www.${bare}` : bare];
  const out = [`sc-domain:${bare}`];
  for (const scheme of ['https:', 'http:']) for (const h of hosts) for (const p of path === '/' ? ['/'] : [path, '/']) out.push(`${scheme}//${h}${p}`);
  return [...new Set(out)];
}

export function pickProperty(configured: string | null, publicUrl: string, accessible: AccessibleProperty[]): { property: string | null; detected: boolean } {
  const can = accessible.filter(usable).map((p) => p.siteUrl);
  if (configured && can.includes(configured)) return { property: configured, detected: false };
  const found = propertyCandidates(publicUrl).find((c) => can.includes(c));
  return found ? { property: found, detected: found !== configured } : { property: configured, detected: false };
}

let cache: { at: number; list: AccessibleProperty[] } | null = null;
const CACHE_MS = 10 * 60_000;

/** The service account's properties (cached 10 minutes; `fresh` asks Google again). Null without a key or on error. */
export async function accessibleProperties(fresh = false): Promise<AccessibleProperty[] | null> {
  if (!readKey()) return null;
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.list;
  try {
    const list = await listProperties();
    cache = { at: Date.now(), list };
    return list;
  } catch {
    return null;
  }
}

export function forgetAccessibleProperties(): void {
  cache = null;
}

/**
 * The website's property, detected from the service account's list when the configured one is not usable. A detected
 * property is saved on the website (and logged), so the page shows the one in use.
 */
export async function resolveWebsiteProperty(websiteId: string, opts: { fresh?: boolean } = {}): Promise<{ site: { id: string; name: string; publicUrl: string }; property: string | null; detectedFrom?: string | null; accessible: AccessibleProperty[] | null }> {
  const site = await db.website.findUniqueOrThrow({ where: { id: websiteId }, select: { id: true, name: true, publicUrl: true, searchConsoleProperty: true, workflows: { select: { searchConsoleProperty: true }, take: 1 } } });
  const configured = siteProperty(site, site.workflows[0]?.searchConsoleProperty);
  const accessible = await accessibleProperties(opts.fresh);
  if (!accessible) return { site, property: configured, accessible };
  const picked = pickProperty(configured, site.publicUrl, accessible);
  if (picked.detected && picked.property) {
    await db.website.update({ where: { id: site.id }, data: { searchConsoleProperty: picked.property } });
    await log({ category: 'search-console', message: `${site.name}: Search Console property ${picked.property} detected (the service account can use it${configured ? `; ${configured} is not shared with it` : ''}).` });
    return { site, property: picked.property, detectedFrom: configured, accessible };
  }
  return { site, property: picked.property, accessible };
}
