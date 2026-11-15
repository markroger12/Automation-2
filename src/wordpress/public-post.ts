import type { Website } from '@prisma/client';
import { safeFetch } from '@/lib/links/net';

/**
 * A post as any visitor sees it, without signing in (owner report 2026-11-15: an ended WordPress sign-in left three
 * keywords “scheduled” for days, with “Could not check WordPress after the slot: … not logged in”). WordPress's
 * public REST API shows a post only once it is published; a scheduled, draft, private or trashed post answers
 * 401/403/404. So the check after a slot needs no sign-in when WordPress published the post itself, the usual case.
 */
export type PublicPost = { state: 'published'; link: string; dateGmt: string | null } | { state: 'not-public' } | { state: 'unknown'; reason: string };

type RestAnswer = { id?: number; status?: string; link?: string; date_gmt?: string; code?: string };

const base = (site: Pick<Website, 'publicUrl'>) => site.publicUrl.replace(/\/?$/, '/');

export async function publicPost(site: Pick<Website, 'publicUrl'>, postId: number, timeoutMs = 20_000): Promise<PublicPost> {
  const host = new URL(site.publicUrl).hostname;
  // A query no cache has seen: a page cache must not answer with the post as it was before its slot.
  const query = `_fields=id,status,link,date_gmt&_bas=${Date.now()}`;
  const route = `/wp/v2/posts/${postId}`;
  const urls = [`${base(site)}wp-json${route}?${query}`, `${base(site)}?rest_route=${encodeURIComponent(route)}&${query}`];
  let reason = 'no answer';
  for (const url of urls) {
    try {
      const res = await safeFetch(url, { trustedHosts: [host], timeoutMs, maxBytes: 200_000 });
      let json: RestAnswer | null = null;
      try {
        json = JSON.parse(res.body) as RestAnswer;
      } catch {
        json = null;
      }
      if (res.status === 200 && json && json.id === postId) {
        if (json.status === 'publish' && typeof json.link === 'string') return { state: 'published', link: json.link, dateGmt: json.date_gmt ?? null };
        return { state: 'not-public' };
      }
      // WordPress's own refusal for a post a visitor may not see (scheduled, draft, private) or that is not there.
      if ([401, 403, 404, 410].includes(res.status) && json?.code && json.code !== 'rest_no_route') return { state: 'not-public' };
      reason = `HTTP ${res.status}${json?.code ? ` ${json.code}` : ''}`;
    } catch (error) {
      reason = (error as Error).message.split('\n')[0];
    }
  }
  return { state: 'unknown', reason };
}

/**
 * Start WordPress's own scheduler (WP-Cron) as a visit to the site does: wp-cron.php publishes the posts whose time
 * has come, and nothing else. No sign-in, no cookies.
 */
export async function visitWpCron(site: Pick<Website, 'publicUrl'>, timeoutMs = 30_000): Promise<void> {
  const host = new URL(site.publicUrl).hostname;
  await safeFetch(`${base(site)}wp-cron.php`, { trustedHosts: [host], timeoutMs, maxBytes: 200_000 }).catch(() => null);
}
