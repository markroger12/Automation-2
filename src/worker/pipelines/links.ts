import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { parseJson, stringArray } from '@/lib/json';
import { NeedsReviewError } from '@/lib/pipeline-errors';
import { htmlToMarkdown } from '@/lib/content/html-to-markdown';
import { makeSlug, normalizeText, stripTags } from '@/lib/content/text';
import { parseLinkCandidates, verifyLink, linkPolicy, type LinkKind } from '@/lib/links/verify';
import { placeLinks } from '@/lib/links/place';
import { chooseLineTarget, findAnchor, previousArticleTarget, rankTargets, type TargetLike } from '@/lib/links/internal';
import { safeFetch } from '@/lib/links/net';
import type { StageManifest } from '@/modules/types';
import { refreshLinkIndex } from '@/wordpress/link-index';
import type { PipelineContext, PipelineStage } from '../pipeline/types';
import { bind, waiting } from './common';

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// ------------------------------------------------------------- EXTERNAL_LINKS

interface ExternalDecision {
  phrase: string;
  url: string;
  finalUrl?: string;
  kind?: LinkKind;
  accepted: boolean;
  reason: string;
}

export function externalLinks(manifest: StageManifest): PipelineStage {
  return bind(manifest, {
    shouldRun: (ctx) => ctx.config.externalLinks && ctx.config.maxExternalLinks > 0,
    run: async (ctx) => {
      const body = ctx.task.bodyHtml ?? '';
      if (!body.trim()) throw new NeedsReviewError('There is no article body to add links to.', ['Article body missing'], 'Regenerate the article stage, then Retry.');
      const res = await ctx.askChatGPT('EXTERNAL_LINKS', { final_article: htmlToMarkdown(body) });
      if (res.status === 'waiting') return waiting('Waiting for ChatGPT: link suggestions');
      const settings = await getSettings();
      const keyword = normalizeText(ctx.task.focusKeyword ?? ctx.task.keyword);
      const bodyText = stripTags(body);
      const decisions: ExternalDecision[] = [];
      const candidates = parseLinkCandidates(res.text);
      const toVerify: { phrase: string; url: string }[] = [];
      for (const c of candidates) {
        const policy = linkPolicy(c.url, ctx.task.language);
        if (normalizeText(c.phrase) === keyword) decisions.push({ ...c, accepted: false, reason: 'anchor is the primary focus keyword' });
        else if (!bodyText.includes(c.phrase)) decisions.push({ ...c, accepted: false, reason: 'phrase does not appear exactly in the article' });
        else if (!policy.ok) decisions.push({ ...c, accepted: false, reason: policy.reason ?? 'not allowed' });
        else toVerify.push(c);
      }
      await ctx.progress(`Verifying ${toVerify.length} link candidate(s)…`);
      const verified = await pool(toVerify, 3, async (c) => ({ c, v: await verifyLink(c, ctx.task.language, { timeoutMs: settings.advanced.linkCheckTimeoutSec * 1000 }) }));
      const passed: { phrase: string; url: string; finalUrl: string; kind: LinkKind; priority: number; reason: string }[] = [];
      for (const { c, v } of verified) {
        if (v.ok) passed.push({ ...c, finalUrl: v.finalUrl!, kind: v.kind, priority: v.priority, reason: v.reason });
        else decisions.push({ ...c, kind: v.kind, accepted: false, reason: v.reason });
      }
      // Highest priority first; Wikipedia may make up at most half of the added links.
      const ordered = passed.map((p, i) => ({ ...p, i })).sort((a, b) => b.priority - a.priority || a.i - b.i);
      const max = ctx.config.maxExternalLinks;
      let html = body;
      let nonWiki = 0;
      let wiki = 0;
      const place = (p: (typeof ordered)[number]) => {
        const r = placeLinks(html, [{ anchor: p.phrase, url: p.finalUrl, kind: 'ext' }], { keyword: ctx.task.focusKeyword ?? ctx.task.keyword });
        if (r.placed.length) {
          html = r.html;
          decisions.push({ phrase: p.phrase, url: p.url, finalUrl: p.finalUrl, kind: p.kind, accepted: true, reason: p.reason });
          return true;
        }
        decisions.push({ phrase: p.phrase, url: p.url, finalUrl: p.finalUrl, kind: p.kind, accepted: false, reason: `verified, but not placed: ${r.skipped[0]?.reason ?? 'no position'}` });
        return false;
      };
      for (const p of ordered.filter((x) => x.kind !== 'wikipedia')) {
        if (nonWiki >= max) {
          decisions.push({ phrase: p.phrase, url: p.url, finalUrl: p.finalUrl, kind: p.kind, accepted: false, reason: `limit of ${max} external links reached` });
          continue;
        }
        if (place(p)) nonWiki++;
      }
      for (const p of ordered.filter((x) => x.kind === 'wikipedia')) {
        if (nonWiki + wiki >= max) {
          decisions.push({ phrase: p.phrase, url: p.url, finalUrl: p.finalUrl, kind: p.kind, accepted: false, reason: `limit of ${max} external links reached` });
          continue;
        }
        if (wiki + 1 > nonWiki) {
          decisions.push({ phrase: p.phrase, url: p.url, finalUrl: p.finalUrl, kind: p.kind, accepted: false, reason: 'Wikipedia may be at most half of the added links' });
          continue;
        }
        if (place(p)) wiki++;
      }
      const accepted = decisions.filter((d) => d.accepted);
      for (const d of decisions) await ctx.log(`Link ${d.accepted ? 'accepted' : 'rejected'}: “${d.phrase}” → ${d.url} — ${d.reason}`, d.accepted ? 'info' : 'debug');
      // Informational only: an article without external links is still complete (spec §9: a warning, not an error).
      const notes = accepted.length ? [] : [candidates.length ? `None of the ${candidates.length} suggested links passed verification; the article was kept without external links.` : 'ChatGPT suggested no usable links; the article was kept without external links.'];
      return {
        outcome: 'completed',
        outputHtml: html,
        prompt: res.prompt,
        output: res.text,
        data: { candidates: candidates.length, accepted, rejected: decisions.filter((d) => !d.accepted), warnings: [], notes },
        message: `${accepted.length} verified link(s) added${decisions.length - accepted.length ? `, ${decisions.length - accepted.length} rejected` : ''}`,
      };
    },
  });
}

// ------------------------------------------------------------- INTERNAL_LINKS

export interface InternalLinkData {
  line: string | null;
  url: string | null;
  title: string | null;
  reason: string | null;
  contextual: { anchor: string; url: string; title: string }[];
  candidates: { title: string; url: string; score: number; related: boolean; reasons: string[] }[];
  index: { via: string; active: number; refreshed: boolean } | null;
  removedByOwner?: boolean;
  /** Need the owner's attention (they become review reasons). */
  warnings: string[];
  /** Informational (shown, but do not block completion). */
  notes: string[];
}

type Override = { mode: 'none' } | { mode: 'url'; url: string; title?: string } | undefined;

/** The article this app wrote before for the same website: the previous keyword of its workflow, else by creation time. */
async function previousArticle(ctx: PipelineContext) {
  const usable = { status: { notIn: ['FAILED', 'CANCELLED'] }, legacy: false, websiteId: ctx.task.websiteId, id: { not: ctx.taskId } };
  const slot = await db.workflowKeyword.findFirst({ where: { taskId: ctx.taskId } });
  if (slot) {
    const before = await db.workflowKeyword.findMany({ where: { workflowId: slot.workflowId, position: { lt: slot.position }, taskId: { not: null } }, orderBy: { position: 'desc' }, take: 5 });
    for (const k of before) {
      const task = await db.articleTask.findFirst({ where: { ...usable, id: k.taskId! } });
      if (task) return task;
    }
  }
  return db.articleTask.findFirst({ where: { ...usable, createdAt: { lt: ctx.task.createdAt } }, orderBy: { createdAt: 'desc' } });
}

export function internalLinks(manifest: StageManifest): PipelineStage {
  return bind(manifest, {
    shouldRun: (ctx) => ctx.config.internalLinks,
    run: async (ctx) => {
      const site = await db.website.findUniqueOrThrow({ where: { id: ctx.task.websiteId } });
      const settings = await getSettings();
      const override = parseJson<Record<string, unknown>>(ctx.task.options, {}).internalLinkOverride as Override;
      const lineText = site.internalLinkLine || (site.language === 'de' ? 'Das könnte Ihnen gefallen:' : 'Also read:');
      const warnings: string[] = [];
      const notes: string[] = [];
      const empty: InternalLinkData = { line: null, url: null, title: null, reason: null, contextual: [], candidates: [], index: null, warnings, notes };
      if (override?.mode === 'none') return { outcome: 'completed', data: { ...empty, removedByOwner: true }, message: 'Internal link removed by the owner' };

      let index: InternalLinkData['index'] = null;
      try {
        await ctx.progress('Refreshing the internal link index…');
        const r = await refreshLinkIndex(site);
        index = { via: r.via, active: r.active, refreshed: r.refreshed };
        if (r.warning) notes.push(r.warning);
      } catch (error) {
        notes.push(`Internal link index not refreshed: ${(error as Error).message}`);
      }
      const rows = await db.linkTarget.findMany({ where: { websiteId: site.id, status: 'ACTIVE' } });
      const targets: (TargetLike & { row: (typeof rows)[number] })[] = rows.map((r) => ({ id: r.id, wpPostId: r.wpPostId, url: r.url, title: r.title, slug: r.slug, categoryIds: parseJson<number[]>(r.categoryIds, []), keyword: r.keyword, excerpt: r.excerpt, publishedAt: r.publishedAt, row: r }));
      const ranked = rankTargets(
        { keyword: ctx.task.keyword, secondary: stringArray(ctx.task.secondaryKeywords), title: ctx.task.selectedTitle, categoryExternalId: ctx.task.categoryExternalId, ownPostId: ctx.task.wpPostId },
        targets,
      );
      const host = new URL(site.publicUrl).hostname;
      const check = async (url: string): Promise<{ ok: boolean; finalUrl: string; note: string }> => {
        try {
          const res = await safeFetch(url, { trustedHosts: [host], timeoutMs: settings.advanced.linkCheckTimeoutSec * 1000, maxBytes: 3_000_000 });
          const finalHost = new URL(res.finalUrl).hostname;
          if (finalHost !== host && finalHost.replace(/^www\./, '') !== host.replace(/^www\./, '')) return { ok: false, finalUrl: res.finalUrl, note: `redirects off-site to ${finalHost}` };
          return res.status >= 200 && res.status < 300 ? { ok: true, finalUrl: res.finalUrl, note: 'reachable' } : { ok: false, finalUrl: res.finalUrl, note: `HTTP ${res.status}` };
        } catch (error) {
          return { ok: false, finalUrl: url, note: (error as Error).message };
        }
      };

      let chosen: { url: string; title: string; reason: string; id?: string } | null = null;
      if (override?.mode === 'url') {
        const sameSite = (() => {
          try {
            return new URL(override.url).hostname.replace(/^www\./, '') === host.replace(/^www\./, '');
          } catch {
            return false;
          }
        })();
        const v = sameSite ? await check(override.url) : { ok: false, finalUrl: override.url, note: 'not a URL of this website' };
        if (v.ok) chosen = { url: v.finalUrl, title: override.title ?? ranked.find((r) => r.target.url === override.url)?.target.title ?? override.url, reason: 'chosen by the owner' };
        else warnings.push(`The chosen internal link ${override.url} was not used: ${v.note}.`);
      }
      if (!chosen && (ctx.config.internalLinkLineTarget ?? 'previous-article') === 'previous-article') {
        // As in the owner's earlier tool: the line links the article this app wrote before for the same website.
        const prev = await previousArticle(ctx);
        if (prev) {
          const title = prev.selectedTitle ?? prev.seoTitle ?? prev.keyword;
          const found = previousArticleTarget({ title, wpPostId: prev.wpPostId, slug: prev.wpSlug ?? prev.slug ?? makeSlug(prev.keyword, prev.language) }, targets, site.publicUrl);
          if (found) {
            const v = await check(found.url);
            if (v.ok) chosen = { url: v.finalUrl, title: found.target?.title ?? title, reason: `previous article of this website (“${title}”)`, id: found.target?.id };
            // A planned address only for an article that has (or will still get) a WordPress post.
            else if (found.planned && prev.wpPostStatus !== 'publish' && (prev.wpPostId || !['COMPLETED', 'NEEDS_REVIEW'].includes(prev.status))) {
              chosen = { url: found.url, title, reason: `previous article of this website (“${title}”), not published yet: its planned address; the link works once that article is published` };
              notes.push(`The internal-link line points to the previous article “${title}”, which is not published yet (${found.url}). It works once that article is published with this address.`);
            } else notes.push(`The previous article “${title}” was not linked (${v.note}); the most related post was linked instead.`);
          } else notes.push(`The previous article “${title}” is not published and its address cannot be predicted (this site's posts do not use /<slug>/ addresses); the most related post was linked instead.`);
        }
      }
      if (!chosen) {
        const plan = chooseLineTarget(ranked);
        for (const option of plan?.order.slice(0, 6) ?? []) {
          const t = option.choice.target as (typeof targets)[number];
          const v = await check(t.url);
          await db.linkTarget.update({ where: { id: t.id }, data: { lastCheckedAt: new Date(), checkNote: v.note, ...(v.ok ? (v.finalUrl !== t.url ? { url: v.finalUrl } : {}) : /HTTP 4(04|10)/.test(v.note) ? { status: 'BROKEN' } : {}) } });
          if (v.ok) {
            chosen = { url: v.finalUrl, title: t.title, reason: option.reason === 'related' ? `most related (${option.choice.reasons.join('; ') || 'topic match'})` : option.reason === 'previous' ? 'previous article (no closely related post)' : 'latest post (no related or previous article)', id: t.id };
            break;
          }
          notes.push(`Skipped internal link candidate “${t.title}”: ${v.note}.`);
        }
      }
      if (!chosen) {
        if (targets.length) warnings.push('No published post of this website could be verified for the internal-link line (all candidates failed).');
        else notes.push(`${site.name} has no published posts to link to yet (first article?). The internal-link line was left out.`);
      }

      // Contextual links where a related post's own phrase already appears in the body.
      const contextual: InternalLinkData['contextual'] = [];
      const bodyText = stripTags(ctx.task.bodyHtml ?? '');
      type Suggestion = { targetId: string | null; url: string; title: string; kind: string; anchor: string | null; score: number; reasons: string[]; status: string; note: string | null };
      const suggestions: Suggestion[] = [];
      if (chosen) {
        const r = ranked.find((x) => x.target.id === chosen!.id);
        suggestions.push({ targetId: chosen.id ?? null, url: chosen.url, title: chosen.title, kind: 'LINE', anchor: null, score: r?.score ?? 0, reasons: r?.reasons ?? [], status: 'SELECTED', note: chosen.reason });
      }
      for (const r of ranked.filter((x) => x.related && x.target.id !== chosen?.id && x.target.url !== chosen?.url)) {
        const base = { targetId: r.target.id, url: r.target.url, title: r.target.title, kind: 'CONTEXTUAL', score: r.score, reasons: r.reasons };
        const anchor = findAnchor(bodyText, r.target);
        if (!anchor || normalizeText(anchor) === normalizeText(ctx.task.focusKeyword ?? ctx.task.keyword)) {
          suggestions.push({ ...base, anchor: null, status: 'NO_ANCHOR', note: anchor ? 'the only matching phrase is the focus keyword' : 'no natural phrase for it in the body' });
          continue;
        }
        if (contextual.length >= ctx.config.maxContextualInternalLinks) {
          suggestions.push({ ...base, anchor, status: 'PROPOSED', note: `not placed: at most ${ctx.config.maxContextualInternalLinks} contextual internal link(s)` });
          continue;
        }
        const v = await check(r.target.url);
        if (v.ok) {
          contextual.push({ anchor, url: v.finalUrl, title: r.target.title });
          suggestions.push({ ...base, url: v.finalUrl, anchor, status: 'SELECTED', note: null });
        } else suggestions.push({ ...base, anchor, status: 'UNREACHABLE', note: v.note });
      }
      for (const r of ranked.filter((x) => !x.related && x.target.id !== chosen?.id).slice(0, 5)) suggestions.push({ targetId: r.target.id, url: r.target.url, title: r.target.title, kind: 'CANDIDATE', anchor: null, score: r.score, reasons: r.reasons, status: 'NOT_RELATED', note: null });
      await db.$transaction([
        db.suggestedInternalLink.deleteMany({ where: { taskId: ctx.taskId } }),
        db.suggestedInternalLink.createMany({ data: suggestions.slice(0, 40).map((x) => ({ ...x, taskId: ctx.taskId, websiteId: site.id, reasons: JSON.stringify(x.reasons) })) }),
      ]);
      const data: InternalLinkData = {
        line: chosen ? lineText : null,
        url: chosen?.url ?? null,
        title: chosen?.title ?? null,
        reason: chosen?.reason ?? null,
        contextual,
        candidates: ranked.slice(0, 8).map((r) => ({ title: r.target.title, url: r.target.url, score: r.score, related: r.related, reasons: r.reasons })),
        index,
        warnings,
        notes,
      };
      return { outcome: 'completed', data, message: chosen ? `${lineText} ${chosen.title}${contextual.length ? ` + ${contextual.length} contextual` : ''}` : 'No internal link (see warnings)' };
    },
  });
}
