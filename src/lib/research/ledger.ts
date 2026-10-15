import { createHash } from 'node:crypto';
import { db } from '../db';
import { log } from '../log';
import { parseJson } from '../json';
import { safeFetch, LinkFetchError } from '../links/net';
import { htmlSegments } from '../plagiarism/text';
import { aboutSubject, extractClaims, internalConflicts, judge, locateInArticle, statusFor, type ClaimStatus, type ExtractedClaim, type Verdict } from './claims';

/**
 * Evidence ledger (upgrade 03): claims from the research notes, checked
 * against the sources the notes cite. Sources are fetched with the SSRF-safe
 * fetcher, cached per URL, and used only when the page is about the same
 * person. Nothing here edits the article: contradictions and unsupported
 * high-impact claims become review reasons for the owner.
 */

const SOURCE_TTL_MS = 7 * 24 * 3600_000;
const MAX_SOURCES = 12;
/** Occupations named in the notes, with their English/German equivalents (a source in either language counts). */
const OCCUPATIONS: string[][] = [
  ['actor', 'actress', 'schauspieler', 'schauspielerin'],
  ['singer', 'sänger', 'sängerin'],
  ['rapper'],
  ['musician', 'musiker', 'musikerin'],
  ['guitarist', 'gitarrist'],
  ['drummer', 'schlagzeuger'],
  ['model'],
  ['presenter', 'host', 'moderator', 'moderatorin'],
  ['footballer', 'soccer player', 'fußballer', 'fußballspieler'],
  ['athlete', 'sportler', 'sportlerin'],
  ['author', 'writer', 'autor', 'autorin', 'schriftsteller'],
  ['director', 'regisseur', 'regisseurin'],
  ['producer', 'produzent', 'produzentin'],
  ['comedian', 'komiker', 'komikerin'],
  ['politician', 'politiker', 'politikerin'],
  ['youtuber'],
  ['influencer'],
  ['chef', 'koch', 'köchin'],
];

export interface EvidenceEntry {
  sourceId: string;
  url: string;
  host: string;
  verdict: Verdict;
  excerpt: string | null;
  detail: string | null;
  observedAt: string;
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
};

/** A source page, from the 7-day cache or fetched now (public addresses only, bounded size and time, no cookies). */
export async function getSource(url: string, now = new Date(), opts: { force?: boolean } = {}) {
  const cached = await db.sourceRecord.findUnique({ where: { url } });
  if (cached && !opts.force && now.getTime() - cached.fetchedAt.getTime() < SOURCE_TTL_MS) return cached;
  let data: { title: string; status: string; httpStatus: number | null; detail: string | null; text: string };
  try {
    const page = await safeFetch(url, { timeoutMs: 15_000, maxBytes: 3_000_000, accept: 'text/html,application/xhtml+xml', userAgent: 'BlogAutomationStudio/3.0 (research evidence check; local tool)' });
    if (page.status >= 400) data = { title: '', status: 'DEAD', httpStatus: page.status, detail: `HTTP ${page.status}`, text: '' };
    else if (!/html/i.test(page.contentType)) data = { title: '', status: 'NOT_HTML', httpStatus: page.status, detail: page.contentType || 'unknown type', text: '' };
    else {
      const text = htmlSegments(page.body, { page: true }).map((s) => s.text).join('\n').slice(0, 150_000);
      const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(page.body)?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
      data = { title, status: 'OK', httpStatus: page.status, detail: null, text };
    }
  } catch (error) {
    const code = error instanceof LinkFetchError ? error.code : 'NETWORK';
    data = { title: '', status: code === 'BLOCKED_ADDRESS' || code === 'SCHEME' || code === 'PORT' ? 'BLOCKED' : code === 'DNS' || code === 'HTTP' ? 'DEAD' : 'FAILED', httpStatus: null, detail: (error as Error).message.slice(0, 300), text: '' };
  }
  const record = { ...data, host: hostOf(url), contentHash: data.text ? createHash('sha256').update(data.text).digest('hex') : null, fetchedAt: now };
  return db.sourceRecord.upsert({ where: { url }, update: record, create: { url, ...record } });
}

/** Words that tell this person apart from namesakes: secondary keywords and occupations named early in the notes. */
export function contextWords(notes: string, secondary: string[]): string[] {
  // URLs are not prose: “…/presenter/…” in a link must not make “presenter” an occupation.
  const head = notes.replace(/https?:\/\/[^\s)\]>"'<]+/g, ' ').slice(0, 1500).toLowerCase();
  const occupations = OCCUPATIONS.filter((group) => group.some((o) => new RegExp(`\\b${o}\\b`).test(head))).flat();
  return [...new Set([...secondary.map((s) => s.toLowerCase()).filter((s) => s.length > 3), ...occupations])].slice(0, 12);
}

const signature = (c: { claimType: string; values: string }) => `${c.claimType}:${JSON.stringify(parseJson<ExtractedClaim['values']>(c.values, { dates: [], amounts: [], names: [] }))}`;

export interface LedgerSummary {
  claims: number;
  byStatus: Partial<Record<ClaimStatus, number>>;
  sources: { ok: number; dead: number; offTopic: number; failed: number };
  conflicts: { type: string; values: string[] }[];
  /** Review reasons (become quality-gate warnings). */
  warnings: string[];
  /** Information only (shown in Research Evidence): unreachable or off-topic sources, internal conflicts. */
  notes: string[];
}

/** Build (or rebuild) the ledger of a task from its research notes. Owner decisions on unchanged claims are kept. */
export async function buildLedger(taskId: string, now = new Date(), opts: { refetch?: boolean } = {}): Promise<LedgerSummary> {
  const task = await db.articleTask.findUniqueOrThrow({ where: { id: taskId }, select: { id: true, keyword: true, researchNotes: true, secondaryKeywords: true } });
  const notes = task.researchNotes ?? '';
  const claims = extractClaims(notes, task.keyword);
  const conflicts = internalConflicts(claims);
  const context = contextWords(notes, parseJson<string[]>(task.secondaryKeywords, []));
  const urls = [...new Set([...claims.flatMap((c) => c.citations), ...[...notes.matchAll(/https?:\/\/[^\s)\]>"'<]+/g)].map((m) => m[0].replace(/[.,;:]+$/, ''))])].slice(0, MAX_SOURCES);
  const sources = [];
  for (const url of urls) sources.push(await getSource(url, now, { force: opts.refetch }));
  const usable: { id: string; url: string; host: string; title: string; text: string }[] = [];
  const offTopic: { url: string; reason: string }[] = [];
  for (const s of sources) {
    if (s.status !== 'OK') continue;
    const about = aboutSubject({ title: s.title, text: s.text }, task.keyword, context);
    if (about.ok) usable.push(s);
    else offTopic.push({ url: s.url, reason: about.reason ?? 'not about this person' });
  }
  const previous = new Map((await db.claimEvidence.findMany({ where: { taskId, ownerDecision: { not: null } } })).map((c) => [signature(c), c]));
  const rows = claims.map((claim) => {
    const evidence: EvidenceEntry[] = [];
    for (const s of usable) {
      const j = judge(claim, { title: s.title, text: s.text });
      if (j.verdict !== 'NO_MENTION') evidence.push({ sourceId: s.id, url: s.url, host: s.host, verdict: j.verdict, excerpt: j.excerpt?.slice(0, 400) ?? null, detail: j.detail, observedAt: now.toISOString() });
    }
    let status = statusFor(claim, evidence);
    const conflict = conflicts.find((c) => c.type === claim.type && claim.values.dates.some((d) => c.values.includes(d)));
    if (conflict && claim.nature !== 'ESTIMATE') status = 'CONTRADICTED';
    const kept = previous.get(`${claim.type}:${JSON.stringify(claim.values)}`);
    return {
      taskId,
      claimType: claim.type,
      claimText: claim.text,
      values: JSON.stringify(claim.values),
      nature: claim.nature,
      highImpact: claim.highImpact,
      status,
      citations: JSON.stringify(claim.citations),
      evidence: JSON.stringify(evidence),
      researchedAt: now,
      ownerDecision: kept?.ownerDecision ?? null,
      ownerValue: kept?.ownerValue ?? null,
      ownerNote: kept?.ownerNote ?? null,
      decidedAt: kept?.decidedAt ?? null,
    };
  });
  await db.$transaction([db.claimEvidence.deleteMany({ where: { taskId } }), db.claimEvidence.createMany({ data: rows })]);
  const byStatus: LedgerSummary['byStatus'] = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  // Only a missing evidence base is a review reason here; what the ARTICLE states is judged at the quality gate.
  const warnings: string[] = [];
  const info: string[] = [];
  if (!urls.length) warnings.push('The research cites no checkable source URLs, so no claim could be verified.');
  for (const c of conflicts) info.push(`The research notes give two different ${c.type === 'BIRTH' ? 'birth' : 'death'} dates (${c.values.join(' vs ')}).`);
  for (const o of offTopic) info.push(`Source not used: ${o.url} — ${o.reason}.`);
  const dead = sources.filter((s) => s.status === 'DEAD' || s.status === 'BLOCKED');
  if (dead.length) info.push(`${dead.length} cited source(s) could not be reached: ${dead.map((s) => s.url).slice(0, 3).join(', ')}.`);
  await log({ category: 'research', taskId, message: `Evidence ledger: ${rows.length} claim(s), ${usable.length} usable source(s), ${offTopic.length} off-topic, ${dead.length} unreachable.` });
  return { claims: rows.length, byStatus, sources: { ok: usable.length, dead: dead.length, offTopic: offTopic.length, failed: sources.filter((s) => s.status === 'FAILED' || s.status === 'NOT_HTML').length }, conflicts, warnings, notes: info };
}

const TYPE_LABEL: Record<string, string> = { BIRTH: 'birth date', DEATH: 'death date', FAMILY: 'family/relationship', EDUCATION: 'education', AWARD: 'award', NET_WORTH: 'net worth', CAREER: 'career' };

/**
 * At the quality gate: where each claim appears in the final article, and the
 * review reasons — contradicted high-impact claims, and unsupported
 * high-impact claims the article states. Hard stop when research notes
 * leaked into the article (raw URLs, “Sources:” lists, “research notes”).
 */
export async function evaluateArticleEvidence(taskId: string, html: string): Promise<{ warnings: string[]; hardStops: string[]; summary: { claims: number; verified: number; contradicted: number; unsupportedInArticle: number } }> {
  const paragraphs = htmlSegments(html).map((s) => s.text);
  const hardStops: string[] = [];
  const leak = paragraphs.findIndex((p) => /https?:\/\/\S+/.test(p) || /^(sources?|quellen?|references?|einzelnachweise)\s*:/i.test(p) || /\b(research notes|recherche-?notizen)\b/i.test(p));
  if (leak >= 0) hardStops.push(`Research notes or a raw source list appear in the article (paragraph ${leak + 1}: “${paragraphs[leak].slice(0, 80)}”).`);
  const claims = await db.claimEvidence.findMany({ where: { taskId } });
  const warnings: string[] = [];
  let unsupportedInArticle = 0;
  for (const c of claims) {
    const claim: ExtractedClaim = { type: c.claimType as ExtractedClaim['type'], text: c.claimText, values: parseJson(c.values, { dates: [], amounts: [], names: [] }), nature: c.nature as ExtractedClaim['nature'], highImpact: c.highImpact, citations: [] };
    const at = locateInArticle(claim, paragraphs);
    if (at !== c.articleParagraph) await db.claimEvidence.update({ where: { id: c.id }, data: { articleParagraph: at } });
    if (c.ownerDecision) continue;
    if (c.highImpact && c.status === 'CONTRADICTED') warnings.push(`Sources disagree on the ${TYPE_LABEL[c.claimType]}: “${c.claimText.slice(0, 120)}”. Check it in Research Evidence.`);
    else if (c.highImpact && at !== null && (c.status === 'UNVERIFIED' || c.status === 'DISPUTED')) {
      unsupportedInArticle++;
      warnings.push(`The article states an unsupported ${TYPE_LABEL[c.claimType]} claim (paragraph ${at + 1}): “${c.claimText.slice(0, 120)}”. Verify it, word it neutrally or leave it out.`);
    }
  }
  return { warnings, hardStops, summary: { claims: claims.length, verified: claims.filter((c) => c.status === 'VERIFIED').length, contradicted: claims.filter((c) => c.status === 'CONTRADICTED').length, unsupportedInArticle } };
}

/** What changed since the last research of the same keyword (another task): new, changed and no longer mentioned facts. */
export async function changesSinceLastResearch(taskId: string) {
  const task = await db.articleTask.findUniqueOrThrow({ where: { id: taskId }, select: { normalizedKeyword: true } });
  const current = await db.claimEvidence.findMany({ where: { taskId } });
  const prev = await db.claimEvidence.findFirst({ where: { taskId: { not: taskId }, task: { normalizedKeyword: task.normalizedKeyword } }, orderBy: { researchedAt: 'desc' } });
  if (!prev) return null;
  const before = await db.claimEvidence.findMany({ where: { taskId: prev.taskId } });
  const key = (c: { claimType: string; values: string }) => {
    const v = parseJson<ExtractedClaim['values']>(c.values, { dates: [], amounts: [], names: [] });
    return [...v.dates, ...v.amounts.map(String), ...v.names].sort().join('|');
  };
  const typesBefore = new Map<string, Set<string>>();
  for (const c of before) typesBefore.set(c.claimType, (typesBefore.get(c.claimType) ?? new Set()).add(key(c)));
  const typesNow = new Map<string, Set<string>>();
  for (const c of current) typesNow.set(c.claimType, (typesNow.get(c.claimType) ?? new Set()).add(key(c)));
  const changes: { type: string; kind: 'NEW' | 'CHANGED' | 'GONE'; before: string[]; now: string[] }[] = [];
  for (const type of new Set([...typesBefore.keys(), ...typesNow.keys()])) {
    const b = [...(typesBefore.get(type) ?? [])];
    const n = [...(typesNow.get(type) ?? [])];
    if (!b.length) changes.push({ type, kind: 'NEW', before: [], now: n });
    else if (!n.length) changes.push({ type, kind: 'GONE', before: b, now: [] });
    else if (b.sort().join() !== n.sort().join()) changes.push({ type, kind: 'CHANGED', before: b, now: n });
  }
  return { previousTaskId: prev.taskId, previousResearchedAt: prev.researchedAt, changes };
}
