import { load } from 'cheerio';
import { LinkFetchError, safeFetch, type SafeFetchOptions } from './net';
import { normalizeText } from '../content/text';

/**
 * External link policy and verification. A candidate is accepted only when
 * the URL passes the domain policy, the page is reachable (SSRF-safe fetch),
 * is HTML, is not a soft 404 or a disambiguation page, stays on the same site
 * after redirects, and actually identifies the linked phrase.
 */

export type LinkKind = 'official' | 'edu-gov' | 'reference' | 'imdb' | 'wikipedia' | 'news' | 'other';

const BLOCKED: { reason: string; hosts: string[] }[] = [
  { reason: 'social media', hosts: ['facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com', 'pinterest.com', 'snapchat.com', 'threads.net', 'reddit.com', 'tumblr.com', 'linkedin.com', 'vk.com', 'youtube.com', 'youtu.be', 'twitch.tv', 'onlyfans.com', 'patreon.com'] },
  { reason: 'shop', hosts: ['amazon.com', 'amazon.de', 'amazon.co.uk', 'ebay.com', 'ebay.de', 'etsy.com', 'aliexpress.com', 'walmart.com', 'temu.com', 'shein.com', 'otto.de', 'zalando.de'] },
  { reason: 'URL shortener', hosts: ['bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'ow.ly', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'is.gd', 'shorturl.at', 'rb.gy', 'tiny.cc', 'lnkd.in'] },
  { reason: 'net-worth aggregator', hosts: ['celebritynetworth.com', 'networthspot.com', 'wealthygorilla.com', 'networthpost.org', 'celebsnetworth.net', 'networth.zone', 'bornrich.com', 'therichest.com', 'idolnetworth.com', 'marriedbiography.com', 'biographymask.com', 'celebsagewiki.com'] },
  { reason: 'gossip site', hosts: ['perezhilton.com', 'radaronline.com', 'tmz.com', 'starcasm.net', 'thehollywoodgossip.com', 'promiflash.de', 'intouch.wunderweib.de'] },
];

const REFERENCE = ['britannica.com', 'brockhaus.de', 'merriam-webster.com', 'duden.de', 'nationalgeographic.com', 'who.int', 'un.org', 'europa.eu', 'nih.gov', 'mayoclinic.org', 'developer.mozilla.org', 'w3.org'];
const NEWS = ['bbc.com', 'bbc.co.uk', 'nytimes.com', 'theguardian.com', 'reuters.com', 'apnews.com', 'washingtonpost.com', 'variety.com', 'hollywoodreporter.com', 'billboard.com', 'rollingstone.com', 'people.com', 'spiegel.de', 'zeit.de', 'faz.net', 'sueddeutsche.de', 'tagesschau.de', 'stern.de', 'welt.de', 'focus.de', 'bild.de', 'ndr.de', 'wdr.de', 'br.de'];

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Registrable-ish domain (last two labels; three for common second-level suffixes). */
export function siteKey(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.');
  const twoLevel = /^(co|com|org|net|gov|ac|edu)$/.test(parts[parts.length - 2] ?? '') && (parts[parts.length - 1] ?? '').length === 2;
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

export interface PolicyResult {
  ok: boolean;
  reason?: string;
  kind: LinkKind;
  priority: number;
}

export function linkPolicy(rawUrl: string, language: string): PolicyResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'not a valid URL', kind: 'other', priority: 0 };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: `scheme ${url.protocol} not allowed`, kind: 'other', priority: 0 };
  if (url.username || url.password) return { ok: false, reason: 'URL contains credentials', kind: 'other', priority: 0 };
  const host = url.hostname.toLowerCase();
  for (const group of BLOCKED) if (group.hosts.some((h) => hostMatches(host, h))) return { ok: false, reason: `${group.reason} (${host})`, kind: 'other', priority: 0 };
  if (/\.(zip|exe|dmg|apk|msi|rar|7z)$/i.test(url.pathname)) return { ok: false, reason: 'download link', kind: 'other', priority: 0 };
  if (hostMatches(host, 'wikipedia.org')) {
    const lang = host.split('.')[0];
    const wanted = language === 'de' ? 'de' : 'en';
    if (lang !== wanted && !(lang === 'm' || host === `${wanted}.m.wikipedia.org`)) return { ok: false, reason: `Wikipedia in another language (${host}; article is ${wanted})`, kind: 'wikipedia', priority: 0 };
    return { ok: true, kind: 'wikipedia', priority: 2 };
  }
  if (hostMatches(host, 'imdb.com')) return { ok: true, kind: 'imdb', priority: 3 };
  if (/\.(gov|edu|mil)$/.test(host) || /\.(gov|ac|edu)\.[a-z]{2}$/.test(host) || hostMatches(host, 'bund.de') || /\.uni-[a-z-]+\.de$|^uni-[a-z-]+\.de$/.test(host)) return { ok: true, kind: 'edu-gov', priority: 5 };
  if (REFERENCE.some((d) => hostMatches(host, d))) return { ok: true, kind: 'reference', priority: 4 };
  if (NEWS.some((d) => hostMatches(host, d))) return { ok: true, kind: 'news', priority: 3 };
  return { ok: true, kind: 'other', priority: 1 };
}

const STOP = new Set(
  'the a an and or of in on at to for with by from as is are was were be de der die das und oder von im in am an zu für mit bei aus als ist sind war ein eine einer eines dem den des its their his her they he she it'.split(' '),
);
export function significantTokens(text: string): string[] {
  return normalizeText(text)
    .split(' ')
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

export interface PageFacts {
  title: string;
  ogTitle: string;
  h1: string;
  lang: string | null;
  text: string;
  disambiguation: boolean;
  soft404: boolean;
}

export function pageFacts(html: string): PageFacts {
  const $ = load(html);
  $('script,style,noscript,svg,nav,footer').remove();
  const title = $('title').first().text().trim();
  const ogTitle = $('meta[property="og:title"]').attr('content')?.trim() ?? '';
  const h1 = $('h1').first().text().trim();
  const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 6000);
  const disambiguation =
    $('#disambigbox, .disambig, #disambig, table.metadata.disambig').length > 0 ||
    /\bmay (also )?refer to\b|\bsteht für:|\bbezeichnet:|\bBegriffsklärung\b/i.test(text.slice(0, 1500)) ||
    /\((disambiguation|Begriffsklärung)\)/i.test(title);
  const soft404 = /\b(page not found|404 not found|seite nicht gefunden|error 404|nicht gefunden)\b/i.test(`${title} ${h1}`);
  return { title, ogTitle, h1, lang: $('html').attr('lang') ?? null, text, disambiguation, soft404 };
}

/** Does the page identify the phrase? Most significant phrase words must appear in its title/heading (or, for non-reference pages, early text). */
export function identifiesSubject(phrase: string, facts: PageFacts, kind: LinkKind): { ok: boolean; detail: string } {
  const tokens = significantTokens(phrase);
  if (!tokens.length) return { ok: false, detail: 'anchor has no significant words' };
  const head = normalizeText(`${facts.title} ${facts.ogTitle} ${facts.h1}`);
  const inHead = tokens.filter((t) => head.includes(t)).length / tokens.length;
  if (inHead >= 0.6) return { ok: true, detail: `title matches (${Math.round(inHead * 100)} %)` };
  if (kind === 'wikipedia' || kind === 'imdb') return { ok: false, detail: `page title “${facts.title.slice(0, 80)}” does not match the anchor` };
  const body = normalizeText(facts.text.slice(0, 3000));
  const inBody = tokens.filter((t) => body.includes(t)).length / tokens.length;
  if (inBody >= 0.8) return { ok: true, detail: `subject found early in the page (${Math.round(inBody * 100)} %)` };
  return { ok: false, detail: `page “${facts.title.slice(0, 80)}” does not identify “${phrase}”` };
}

export interface VerifyResult {
  ok: boolean;
  reason: string;
  finalUrl?: string;
  title?: string;
  kind: LinkKind;
  priority: number;
}

export async function verifyLink(candidate: { phrase: string; url: string }, language: string, fetchOpts: SafeFetchOptions = {}): Promise<VerifyResult> {
  const policy = linkPolicy(candidate.url, language);
  if (!policy.ok) return { ok: false, reason: policy.reason!, kind: policy.kind, priority: 0 };
  const original = new URL(candidate.url);
  const attempts = original.protocol === 'http:' ? [candidate.url.replace(/^http:/, 'https:'), candidate.url] : [candidate.url];
  let lastError = 'unreachable';
  for (const attempt of attempts) {
    try {
      const page = await safeFetch(attempt, {
        acceptLanguage: language === 'de' ? 'de-DE,de;q=0.9' : 'en-US,en;q=0.9',
        // Never follow a link off its own site (expired domains, parking, trackers).
        allowRedirect: (_from, to) => siteKey(to.hostname) === siteKey(original.hostname),
        ...fetchOpts,
      });
      if (page.status < 200 || page.status >= 300) {
        lastError = `HTTP ${page.status}`;
        continue;
      }
      if (!/html/i.test(page.contentType)) return { ok: false, reason: `not an HTML page (${page.contentType || 'unknown type'})`, kind: policy.kind, priority: 0 };
      const finalHost = new URL(page.finalUrl).hostname;
      if (siteKey(finalHost) !== siteKey(original.hostname)) return { ok: false, reason: `redirects to another site (${finalHost})`, kind: policy.kind, priority: 0 };
      const finalPolicy = linkPolicy(page.finalUrl, language);
      if (!finalPolicy.ok) return { ok: false, reason: `redirect target: ${finalPolicy.reason}`, kind: policy.kind, priority: 0 };
      const facts = pageFacts(page.body);
      if (facts.soft404) return { ok: false, reason: `page says “not found” (${facts.title.slice(0, 60)})`, kind: policy.kind, priority: 0 };
      if (facts.disambiguation) return { ok: false, reason: 'disambiguation page', kind: policy.kind, priority: 0 };
      const subject = identifiesSubject(candidate.phrase, facts, policy.kind);
      if (!subject.ok) return { ok: false, reason: subject.detail, kind: policy.kind, priority: 0 };
      const https = page.finalUrl.startsWith('https:');
      return { ok: true, reason: `${subject.detail}${https ? '' : ' (no HTTPS available)'}`, finalUrl: page.finalUrl, title: facts.title, kind: policy.kind, priority: policy.priority + (https ? 0.5 : 0) };
    } catch (error) {
      if (error instanceof LinkFetchError && error.code === 'REDIRECT_REFUSED') return { ok: false, reason: error.message, kind: policy.kind, priority: 0 };
      lastError = error instanceof LinkFetchError ? `${error.code.toLowerCase().replace('_', ' ')}: ${error.message}` : (error as Error).message;
    }
  }
  return { ok: false, reason: lastError, kind: policy.kind, priority: 0 };
}

/** Parse "LINK: phrase | URL" lines (tolerates bullets, bold, quotes and angle brackets). */
export function parseLinkCandidates(text: string): { phrase: string; url: string }[] {
  const out: { phrase: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[\s>*\-•\d.)]+/, '').replace(/\*\*/g, '').trim();
    const m = /^LINK\s*:\s*(.+?)\s*\|\s*<?(https?:\/\/[^\s<>|]+)>?\s*$/i.exec(line);
    if (!m) continue;
    const phrase = m[1].replace(/^["“„'‘]+|["”“'’]+$/g, '').replace(/^\[|\]$/g, '').trim();
    const url = m[2].replace(/[).,;]+$/, '');
    const key = `${phrase.toLowerCase()}|${url}`;
    if (!phrase || phrase.length > 120 || seen.has(key)) continue;
    seen.add(key);
    out.push({ phrase, url });
  }
  return out;
}
