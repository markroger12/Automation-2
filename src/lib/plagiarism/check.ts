import { db } from '../db';
import { log } from '../log';
import { parseJson } from '../json';
import { boilerplateTokens, blockFingerprint, distinctivePassages, exactRuns, excerpt, nearMatches } from './match';
import { buildTextModel, inputSegments, type TextModel } from './text';
import { fetchPageDoc, hostOf, LIMITS, linkedUrls, ownerArticleDocs, searchConfigured, searchPassage, SourceError, wikipediaDocs, type SourceDoc } from './sources';
import type { CoverageEntry, EvidenceItem, ExemptItem, PlagiarismOptions, PlagiarismResult, SourceReport } from './types';

/**
 * Run one Plagiarism Evidence Check (worker, workflow queue). Gathers the
 * selected sources, finds verified exact runs and sentence-level near
 * matches, and stores evidence + coverage + limitations. Safe to repeat: an
 * interrupted run starts over. Never produces a verdict or a score.
 */

const MAX_EVIDENCE = 150;

class Cancelled extends Error {}

export async function runPlagiarismCheck(id: string, heartbeat: () => Promise<unknown> = async () => undefined): Promise<{ status: string }> {
  const check = await db.plagiarismCheck.findUnique({ where: { id }, include: { task: { include: { website: true } } } });
  if (!check) return { status: 'missing' };
  if (['COMPLETED', 'CANCELLED', 'FAILED'].includes(check.status)) return { status: check.status };
  await db.plagiarismCheck.update({ where: { id }, data: { status: 'RUNNING', startedAt: new Date(), progress: 'Starting…', message: null } });
  const opts = parseJson<PlagiarismOptions>(check.options, { ownerArticles: true, linkedPages: true, wikipedia: true, search: false, urls: [] });
  const progress = async (text: string) => {
    await heartbeat();
    const row = await db.plagiarismCheck.update({ where: { id }, data: { progress: text }, select: { status: true } });
    if (row.status === 'CANCELLED') throw new Cancelled();
  };

  try {
    const article = buildTextModel(inputSegments(check.inputHtml));
    const ownHosts = check.task?.website ? [hostOf(check.task.website.publicUrl)].filter(Boolean) : [];
    const coverage: CoverageEntry[] = [];
    const docs: SourceDoc[] = [];
    const seenUrls = new Set<string>();
    const fetchInto = async (url: string, kind: SourceDoc['kind'], coverageKind: CoverageEntry['kind'], query?: string) => {
      if (seenUrls.has(url)) return;
      seenUrls.add(url);
      try {
        const doc = await fetchPageDoc(url, kind, query);
        docs.push(doc);
        coverage.push({ kind: coverageKind, label: doc.title, url, status: 'CHECKED', detail: `${doc.model.tokens.length} words read${query ? ` (found for “${query}”)` : ''}` });
      } catch (error) {
        coverage.push({ kind: coverageKind, label: url, url, status: 'FAILED', detail: error instanceof SourceError ? error.message : (error as Error).message });
      }
    };

    // 1. The owner's saved articles (and recurring site text, which is exempt).
    let boilerplate = { tokens: new Set<number>(), blocks: [] as { text: string; articles: number }[] };
    if (opts.ownerArticles) {
      await progress('Comparing with your saved articles…');
      const owner = await ownerArticleDocs(check.taskId);
      docs.push(...owner.docs);
      coverage.push({ kind: 'OWNER_ARTICLES', label: 'Your saved articles', status: 'CHECKED', detail: owner.total ? `${owner.total} saved article(s) on all websites${owner.total >= LIMITS.ownerArticles ? ` (the newest ${LIMITS.ownerArticles})` : ''}` : 'no other saved articles yet' });
      if (check.task) {
        const counts = new Map<string, number>();
        for (const doc of owner.docs) {
          if (owner.websiteOf.get(doc.taskId!) !== check.task.websiteId) continue;
          for (const fp of new Set(doc.model.blocks.map((b) => blockFingerprint(doc.model, b)))) counts.set(fp, (counts.get(fp) ?? 0) + 1);
        }
        boilerplate = boilerplateTokens(article, counts, 3);
      }
    } else coverage.push({ kind: 'OWNER_ARTICLES', label: 'Your saved articles', status: 'SKIPPED', detail: 'not selected' });

    // 2. Pages linked from the article.
    if (opts.linkedPages) {
      const urls = linkedUrls(check.inputHtml, ownHosts);
      if (!urls.length) coverage.push({ kind: 'LINKED_PAGE', label: 'Pages linked from the article', status: 'SKIPPED', detail: 'the article has no external links' });
      for (const [i, url] of urls.entries()) {
        await progress(`Reading linked page ${i + 1} of ${urls.length}…`);
        await fetchInto(url, 'LINKED_PAGE', 'LINKED_PAGE');
      }
    }

    // 3. URLs the owner added.
    for (const [i, url] of opts.urls.slice(0, LIMITS.userUrls).entries()) {
      await progress(`Reading your URL ${i + 1} of ${opts.urls.length}…`);
      await fetchInto(url, 'USER_URL', 'USER_URL');
    }

    // 4. Wikipedia extracts for the topic.
    if (opts.wikipedia) {
      await progress('Reading Wikipedia extracts…');
      const topic = check.keyword || check.title;
      try {
        const wiki = await wikipediaDocs(topic, check.language);
        docs.push(...wiki);
        coverage.push({ kind: 'WIKIPEDIA', label: `Wikipedia (${check.language})`, status: 'CHECKED', detail: wiki.length ? `${wiki.length} article extract(s) for “${topic}”: ${wiki.map((w) => w.title.replace(/^Wikipedia \(\w+\): /, '')).join(', ')}` : `no article found for “${topic}”` });
      } catch (error) {
        coverage.push({ kind: 'WIKIPEDIA', label: `Wikipedia (${check.language})`, status: 'FAILED', detail: (error as Error).message });
      }
    }

    // 5. Licensed search service (optional): distinctive passages as exact-phrase queries.
    if (opts.search && searchConfigured()) {
      const passages = distinctivePassages(article, LIMITS.searchQueries);
      const found: { link: string; query: string }[] = [];
      for (const [i, p] of passages.entries()) {
        await progress(`Searching passage ${i + 1} of ${passages.length}…`);
        try {
          const hits = (await searchPassage(p.query, check.language)).filter((h) => !ownHosts.includes(hostOf(h.link)));
          coverage.push({ kind: 'SEARCH', label: `Search: “${p.query}”`, status: 'CHECKED', detail: hits.length ? `${hits.length} result(s)` : 'no results' });
          for (const h of hits) if (!found.some((f) => f.link === h.link)) found.push({ link: h.link, query: p.query });
        } catch (error) {
          coverage.push({ kind: 'SEARCH', label: `Search: “${p.query}”`, status: 'FAILED', detail: (error as Error).message });
          if (/rejected the key|quota/.test((error as Error).message)) break;
        }
      }
      const toRead = found.filter((f) => !seenUrls.has(f.link)).slice(0, LIMITS.searchResults);
      for (const [i, f] of toRead.entries()) {
        await progress(`Reading search result ${i + 1} of ${toRead.length}…`);
        await fetchInto(f.link, 'SEARCH_RESULT', 'SEARCH', f.query);
      }
      if (found.length > toRead.length) coverage.push({ kind: 'SEARCH', label: 'Further search results', status: 'SKIPPED', detail: `${found.length - toRead.length} more result page(s) not read (limit ${LIMITS.searchResults})` });
    } else if (opts.search) coverage.push({ kind: 'SEARCH', label: 'Search service', status: 'NOT_CONFIGURED', detail: 'No SERPER_API_KEY in .env, so the wider web was not searched.' });
    else coverage.push({ kind: 'SEARCH', label: 'Search service', status: 'SKIPPED', detail: searchConfigured() ? 'not selected' : 'not selected (no search key configured)' });

    await progress('Comparing…');
    const result = compare(article, docs, boilerplate);
    result.coverage = coverage;
    result.limitations = limitations(opts, coverage, result);
    const withFindings = result.sources.filter((s) => s.exactRuns || s.nearMatches).length;
    const summary = result.wordsInExactRuns || result.nearSentences
      ? `${result.wordsInExactRuns} of ${result.articleWords} words in identical runs of 8+ words and ${result.nearSentences} closely matching sentence(s), in ${withFindings} of ${docs.length} document(s) compared. Review the evidence; this is not a verdict.`
      : `No identical runs of 8+ words and no closely matching sentences in the ${docs.length} source(s) compared. Sources outside the coverage list were not checked.`;
    await db.plagiarismCheck.update({ where: { id }, data: { status: 'COMPLETED', result: JSON.stringify(result), message: summary, progress: null, finishedAt: new Date() } });
    await log({ category: 'plagiarism', taskId: check.taskId ?? undefined, message: `Plagiarism evidence check finished: ${summary}` });
    return { status: 'COMPLETED' };
  } catch (error) {
    if (error instanceof Cancelled) return { status: 'CANCELLED' };
    throw error;
  }
}

function compare(article: TextModel, docs: SourceDoc[], boilerplate: { tokens: Set<number>; blocks: { text: string; articles: number }[] }): PlagiarismResult {
  const evidence: EvidenceItem[] = [];
  const exemptMatches: ExemptItem[] = [];
  const sources: SourceReport[] = [];
  const exactCovered = new Set<number>();
  const nearSentenceStarts = new Set<number>();
  for (const doc of docs) {
    const runs = exactRuns(article, doc.model, boilerplate.tokens);
    const counted = runs.filter((r) => !r.exempt);
    const covered = new Set<number>();
    for (const r of counted) for (let t = r.a[0]; t < r.a[1]; t++) covered.add(t);
    const near = nearMatches(article, doc.model, covered, boilerplate.tokens);
    if (!runs.length && !near.length) continue;
    const index = sources.length;
    if (counted.length || near.length) {
      sources.push({ kind: doc.kind, title: doc.title, url: doc.url, taskId: doc.taskId, query: doc.query, exactRuns: counted.length, longestRun: Math.max(0, ...counted.map((r) => r.a[1] - r.a[0])), exactWords: counted.reduce((n, r) => n + r.countedWords, 0), nearMatches: near.length });
    } else {
      // Only exempt overlaps: keep the source so the exempt list can name it, without findings.
      sources.push({ kind: doc.kind, title: doc.title, url: doc.url, taskId: doc.taskId, query: doc.query, exactRuns: 0, longestRun: 0, exactWords: 0, nearMatches: 0 });
    }
    for (const r of runs) {
      if (r.exempt) {
        // Recurring site text is listed once (with how many articles repeat it), not once per article.
        if (r.exempt === 'quotation') exemptMatches.push({ source: index, reason: r.exempt, text: excerpt(article, r.a, 0).match, words: r.a[1] - r.a[0] });
        continue;
      }
      for (let t = r.a[0]; t < r.a[1]; t++) if (!article.tokens[t].quoted && !boilerplate.tokens.has(t)) exactCovered.add(t);
      evidence.push({ source: index, kind: 'exact', article: excerpt(article, r.a), match: excerpt(doc.model, r.s), words: r.a[1] - r.a[0] });
    }
    for (const n of near) {
      nearSentenceStarts.add(n.a[0]);
      evidence.push({ source: index, kind: 'near', article: excerpt(article, n.a, 0), match: excerpt(doc.model, n.s, 0), words: n.a[1] - n.a[0], shared: n.shared, contentWords: n.contentWords, ordered: Math.round(n.ordered * 100) / 100 });
    }
  }
  // Strongest evidence first: exact before near, then longer.
  evidence.sort((x, y) => (x.kind === y.kind ? y.words - x.words : x.kind === 'exact' ? -1 : 1));
  for (const s of nearSentenceStarts) if (exactCovered.has(s)) nearSentenceStarts.delete(s);
  return {
    articleWords: article.tokens.length,
    documentsCompared: docs.length,
    wordsInExactRuns: exactCovered.size,
    nearSentences: nearSentenceStarts.size,
    exempt: { quotedWords: article.tokens.filter((t) => t.quoted).length, boilerplateWords: boilerplate.tokens.size, boilerplateBlocks: boilerplate.blocks },
    sources,
    evidence: evidence.slice(0, MAX_EVIDENCE),
    exemptMatches: exemptMatches.slice(0, 50),
    coverage: [],
    limitations: [],
    checkedAt: new Date().toISOString(),
  };
}

function limitations(opts: PlagiarismOptions, coverage: CoverageEntry[], result: PlagiarismResult): string[] {
  const failed = coverage.filter((c) => c.status === 'FAILED').length;
  const searched = coverage.some((c) => c.kind === 'SEARCH' && c.status === 'CHECKED');
  const out = [
    searched
      ? 'Only the sources in the coverage list were compared: a few distinctive passages were searched, so copies of other passages elsewhere on the web can be missed.'
      : 'Only the sources in the coverage list were compared. The wider web was not searched, so copies elsewhere can be missed.',
    'Identical runs show the same wording, not who copied whom, when, or whether the use is permitted (licensed text, your own earlier article, a press release).',
    'Near matches compare single sentences; shared facts, names, titles and common phrasing can produce them legitimately.',
    'No number on this page proves or disproves plagiarism.',
  ];
  if (result.exempt.quotedWords || result.exempt.boilerplateWords) out.push(`Quotations (${result.exempt.quotedWords} words) and text that recurs across your site (${result.exempt.boilerplateWords} words) were not counted; matches there are listed separately.`);
  if (failed) out.push(`${failed} source(s) could not be read (see coverage); pages that need JavaScript, a login or block automated access are missing or incomplete.`);
  if (!opts.ownerArticles) out.push('Your own saved articles were not compared.');
  return out;
}
