/**
 * Search Console helpers (pure; used by the server and the browser): properties and the property's Search Console
 * page (opened by the owner, or by Automation Chrome to inspect a URL and click “Request indexing”,
 * src/lib/gsc/request-indexing.ts).
 */

/** A URL-prefix property ("https://example.com/") or a domain property ("sc-domain:example.com"). */
export function normalizeSearchConsoleProperty(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const domain = /^sc-domain:([a-z0-9.-]+)$/i.exec(v);
  if (domain) {
    const host = domain[1].toLowerCase().replace(/\.$/, '');
    return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host) ? `sc-domain:${host}` : null;
  }
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return `${u.origin}${u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`}`;
  } catch {
    return null;
  }
}

/** The property to inspect with: the configured one, else the website's URL as a URL-prefix property. */
export function inspectionProperty(configured: string | null | undefined, websiteUrl: string): string {
  return normalizeSearchConsoleProperty(configured) ?? normalizeSearchConsoleProperty(websiteUrl) ?? websiteUrl;
}

/**
 * The property's page in Search Console, with the “Inspect any URL in …” box. A URL Inspection link cannot be built
 * from the post's URL: its `id` is Google's own token (owner report: …/inspect?…&id=<post URL> answers 404). Google's
 * URL Inspection API returns a working one (`inspectionResultLink`).
 */
export function searchConsoleHome(property: string): string {
  return `https://search.google.com/search-console?resource_id=${encodeURIComponent(property)}`;
}
