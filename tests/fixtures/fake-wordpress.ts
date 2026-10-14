import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * A small fake WordPress for integration tests (NOT a real WordPress). It
 * models the pieces the app relies on: login cookie, wp-admin pages in
 * English/German, admin-ajax rest-nonce, REST categories (or a disabled REST
 * API to force the admin-table fallback), post-new.php for Gutenberg or
 * Classic, and an optional Hostinger-style overlay. Posts/Rank Math are added
 * by later milestones.
 */
export interface FakeWpOptions {
  language?: 'en' | 'de';
  editor?: 'gutenberg' | 'classic';
  restDisabled?: boolean;
  overlay?: boolean;
  categories?: { id: number; name: string; slug: string; parent?: number; count?: number }[];
}

export interface FakeWp {
  url: string;
  adminUrl: string;
  options: Required<Omit<FakeWpOptions, 'categories'>> & { categories: NonNullable<FakeWpOptions['categories']> };
  sessions: Set<string>;
  requests: { method: string; path: string; body: string }[];
  close(): Promise<void>;
  /** Forget all sessions (simulates an expired login). */
  logoutAll(): void;
}

const NONCE = 'fake-nonce-123';

function html(lang: string, body: string, bodyClass = '') {
  return `<!doctype html><html lang="${lang === 'de' ? 'de-DE' : 'en-US'}"><head><meta charset="utf-8"><title>WP</title></head><body class="${bodyClass}">${body}</body></html>`;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

export async function startFakeWordPress(opts: FakeWpOptions = {}): Promise<FakeWp> {
  const options = {
    language: opts.language ?? 'en',
    editor: opts.editor ?? 'gutenberg',
    restDisabled: opts.restDisabled ?? false,
    overlay: opts.overlay ?? false,
    categories: opts.categories ?? [
      { id: 1, name: opts.language === 'de' ? 'Allgemein' : 'Uncategorized', slug: opts.language === 'de' ? 'allgemein' : 'uncategorized', count: 3 },
      { id: 7, name: 'Celebrities', slug: 'celebrities', count: 12 },
      { id: 9, name: 'Tech &amp; Apps', slug: 'tech-apps', count: 5 },
    ],
  };
  const sessions = new Set<string>();
  const requests: FakeWp['requests'] = [];
  const t = (en: string, de: string) => (options.language === 'de' ? de : en);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = req.method === 'POST' ? await readBody(req) : '';
    requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, body });
    const cookie = req.headers.cookie ?? '';
    const token = /wordpress_logged_in_fake=([^;]+)/.exec(cookie)?.[1];
    const loggedIn = Boolean(token && sessions.has(token));
    const send = (status: number, content: string, type = 'text/html; charset=utf-8', headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': type, ...headers });
      res.end(content);
    };
    const redirect = (location: string, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(302, { Location: location, ...headers });
      res.end();
    };
    const p = url.pathname;

    if (p === '/wp-login.php') {
      if (req.method === 'POST') {
        const form = new URLSearchParams(body);
        if (form.get('log') && form.get('pwd')) {
          const tok = randomUUID();
          sessions.add(tok);
          // Like WordPress: a persistent cookie only with "Remember Me", otherwise a session cookie.
          const persist = form.get('rememberme') === 'forever' ? '; Max-Age=1209600' : '';
          return redirect(form.get('redirect_to') || '/wp-admin/', { 'Set-Cookie': `wordpress_logged_in_fake=${tok}; Path=/; HttpOnly${persist}` });
        }
        return send(200, html(options.language, `<div id="login_error">${t('Error', 'Fehler')}</div>`));
      }
      return send(
        200,
        html(
          options.language,
          `<form name="loginform" id="loginform" method="post" action="/wp-login.php"><input id="user_login" name="log"><input id="user_pass" name="pwd" type="password"><input name="rememberme" type="checkbox" id="rememberme" value="forever"><input type="hidden" name="redirect_to" value="${url.searchParams.get('redirect_to') ?? '/wp-admin/'}"><button id="wp-submit" type="submit">${t('Log In', 'Anmelden')}</button></form>`,
          'login',
        ),
      );
    }

    if (p.startsWith('/wp-admin')) {
      if (!loggedIn && p !== '/wp-admin/admin-ajax.php') return redirect(`/wp-login.php?redirect_to=${encodeURIComponent(p + url.search)}&reauth=1`);
      const adminBar = `<div id="wpadminbar">${t('Howdy', 'Willkommen')}</div><ul id="adminmenu"></ul>`;
      const overlay = options.overlay ? `<div id="hostinger-onboarding-overlay" style="position:fixed;inset:0;background:#000;z-index:99999">Hostinger</div>` : '';
      if (p === '/wp-admin/' || p === '/wp-admin/index.php') {
        return send(200, html(options.language, `${adminBar}${overlay}<h1>${t('Dashboard', 'Übersicht')}</h1>`, 'wp-admin'));
      }
      if (p === '/wp-admin/admin-ajax.php') {
        if (url.searchParams.get('action') === 'rest-nonce') return send(200, loggedIn ? NONCE : '0', 'text/plain');
        return send(400, '0', 'text/plain');
      }
      if (p === '/wp-admin/edit-tags.php') {
        const paged = Number(url.searchParams.get('paged') ?? '1');
        const rows = paged === 1 ? options.categories : [];
        const trs = rows
          .map((c) => `<tr id="tag-${c.id}"><td class="name column-name"><strong><a class="row-title" href="#">${c.parent ? '— ' : ''}${c.name}</a></strong></td><td class="slug column-slug">${c.slug}</td><td class="posts column-posts">${c.count ?? 0}</td></tr>`)
          .join('');
        return send(200, html(options.language, `${adminBar}<table class="wp-list-table"><tbody id="the-list">${trs}</tbody></table>`, 'wp-admin'));
      }
      if (p === '/wp-admin/post-new.php') {
        if (options.editor === 'gutenberg') {
          return send(200, html(options.language, `${adminBar}${overlay}<div class="edit-post-layout"><div class="block-editor"></div></div>`, 'wp-admin block-editor-page'));
        }
        return send(200, html(options.language, `${adminBar}${overlay}<div id="postdivrich"><textarea id="content"></textarea></div><div id="submitdiv"><input id="publish" type="submit" value="${t('Publish', 'Veröffentlichen')}"></div>`, 'wp-admin'));
      }
      return send(404, html(options.language, `${adminBar}Not found`, 'wp-admin'));
    }

    if (p.startsWith('/wp-json/') || url.searchParams.has('rest_route')) {
      if (options.restDisabled) return send(404, JSON.stringify({ code: 'rest_no_route' }), 'application/json');
      const route = p.startsWith('/wp-json/') ? p.slice('/wp-json'.length) : (url.searchParams.get('rest_route') ?? '');
      if (route === '/wp/v2/categories') {
        const perPage = Number(url.searchParams.get('per_page') ?? '10');
        const page = Number(url.searchParams.get('page') ?? '1');
        const total = Math.max(1, Math.ceil(options.categories.length / perPage));
        if (page > total) return send(400, JSON.stringify({ code: 'rest_post_invalid_page_number' }), 'application/json');
        const items = options.categories.slice((page - 1) * perPage, page * perPage).map((c) => ({ id: c.id, name: c.name, slug: c.slug, parent: c.parent ?? 0, count: c.count ?? 0 }));
        return send(200, JSON.stringify(items), 'application/json', { 'X-WP-TotalPages': String(total), 'X-WP-Total': String(options.categories.length) });
      }
      return send(404, JSON.stringify({ code: 'rest_no_route' }), 'application/json');
    }

    if (p === '/') return send(200, html(options.language, '<h1>Fake blog</h1>'));
    return send(404, 'not found', 'text/plain');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    adminUrl: `${url}/wp-admin/`,
    options,
    sessions,
    requests,
    logoutAll: () => sessions.clear(),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
