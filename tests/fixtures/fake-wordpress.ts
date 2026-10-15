import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * A small fake WordPress for integration tests (NOT a real WordPress, NOT the
 * real Rank Math). It models what the app relies on: login cookie, wp-admin
 * pages in English/German, admin-ajax rest-nonce, the REST API (index,
 * categories, posts, tags, Rank Math's updateMeta route), a Gutenberg-like
 * editor page with a minimal `wp.data` stub, the Classic editor form, an
 * optional Hostinger-style overlay, and failure modes (lost create
 * acknowledgement, expired login).
 *
 * The "Rank Math" panel here uses the fixture's OWN simple, documented rules
 * (see `fakeRankMathScore`) so the app's reading/correction logic can be
 * tested. It is not Rank Math's algorithm. Real WordPress coverage lives in
 * tests/e2e (WP_E2E_ADMIN_URL).
 */
export interface FakeWpOptions {
  language?: 'en' | 'de';
  editor?: 'gutenberg' | 'classic';
  restDisabled?: boolean;
  overlay?: boolean;
  categories?: { id: number; name: string; slug: string; parent?: number; count?: number }[];
  /** Simulate an installed Rank Math (REST namespace, editor panel). */
  rankMath?: boolean;
  /** Highest score the fake panel will show (to test an unreachable target). */
  rankMathScoreCap?: number;
  /** Number of upcoming post creates whose HTTP answer is dropped after the post was created. */
  dropCreateAcks?: number;
  /** Number of upcoming media uploads whose HTTP answer is dropped after the file was stored. */
  dropMediaAcks?: number;
  /** Role of the signed-in account (capabilities as in WordPress core). */
  role?: 'administrator' | 'editor' | 'author' | 'contributor' | 'subscriber';
  /** Admin pages show WordPress's “session expired” pop-up (as after a heartbeat with an expired cookie). */
  expiredPopup?: boolean;
}

const ROLE_CAPS: Record<NonNullable<FakeWpOptions['role']>, string[]> = {
  administrator: ['read', 'edit_posts', 'upload_files', 'publish_posts', 'manage_categories'],
  editor: ['read', 'edit_posts', 'upload_files', 'publish_posts', 'manage_categories'],
  author: ['read', 'edit_posts', 'upload_files', 'publish_posts'],
  contributor: ['read', 'edit_posts'],
  subscriber: ['read'],
};

export interface FakePost {
  id: number;
  status: string;
  title: string;
  content: string;
  slug: string;
  categories: number[];
  tags: number[];
  featured_media: number;
  date_gmt: string;
  modified_gmt: string;
  meta: Record<string, string>;
}

export interface FakeWp {
  url: string;
  adminUrl: string;
  options: Required<Omit<FakeWpOptions, 'categories'>> & { categories: NonNullable<FakeWpOptions['categories']> };
  sessions: Set<string>;
  requests: { method: string; path: string; body: string }[];
  posts: Map<number, FakePost>;
  tags: { id: number; name: string; slug: string }[];
  media: Map<number, { id: number; bytes: number; mime: string; filename: string; slug: string; alt: string; url: string }>;
  close(): Promise<void>;
  /** Forget all sessions (simulates an expired login). */
  logoutAll(): void;
  /** Add a post directly (e.g. a draft that an earlier lost request created). */
  addPost(p: Partial<FakePost> & { title: string }): FakePost;
  /** Public path redirects (e.g. a post whose URL changed): "/?p=101" → "/new-slug/". */
  redirects: Map<string, string>;
}

const NONCE = 'fa0e1d2c3b';

function html(lang: string, body: string, bodyClass = '', head = '') {
  return `<!doctype html><html lang="${lang === 'de' ? 'de-DE' : 'en-US'}"><head><meta charset="utf-8"><title>WP</title>${head}</head><body class="${bodyClass}">${body}</body></html>`;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nowGmt = () => new Date().toISOString().replace(/\.\d+Z$/, '');
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * The fixture's own scoring rules (NOT Rank Math's). Each failed rule yields a
 * recommendation worded like Rank Math's English/German checklist.
 */
export function fakeRankMathScore(post: FakePost, language: 'en' | 'de', cap = 100): { score: number; checks: { text: string; ok: boolean }[] } {
  const kw = (post.meta.rank_math_focus_keyword ?? '').trim().toLowerCase();
  const title = (post.meta.rank_math_title ?? '').toLowerCase();
  const desc = (post.meta.rank_math_description ?? '').toLowerCase();
  const text = post.content.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').toLowerCase();
  const firstPara = (/<p>([\s\S]*?)<\/p>/i.exec(post.content)?.[1] ?? '').toLowerCase();
  const headings = Array.from(post.content.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)).map((m) => m[1].toLowerCase());
  const de = language === 'de';
  const rules: { ok: boolean; points: number; en: string; de: string }[] = [
    { ok: Boolean(kw), points: 20, en: 'Set a Focus Keyword for this content.', de: 'Lege ein Fokus-Keyword für diesen Inhalt fest.' },
    { ok: Boolean(kw) && title.includes(kw), points: 10, en: 'Focus Keyword not found in your SEO Title.', de: 'Fokus-Keyword wurde nicht im SEO-Titel gefunden.' },
    { ok: Boolean(kw) && title.startsWith(kw), points: 10, en: "Focus Keyword doesn't appear at the beginning of SEO title.", de: 'Das Fokus-Keyword steht nicht am Anfang des SEO-Titels.' },
    { ok: Boolean(kw) && desc.includes(kw), points: 15, en: 'Focus Keyword not found in your SEO Meta Description.', de: 'Fokus-Keyword wurde nicht in der Meta-Beschreibung gefunden.' },
    { ok: Boolean(kw) && post.slug.includes(slugify(kw)), points: 10, en: 'Focus Keyword not found in the URL.', de: 'Fokus-Keyword wurde nicht in der URL gefunden.' },
    { ok: Boolean(kw) && firstPara.includes(kw), points: 15, en: "Focus Keyword doesn't appear at the beginning of your content.", de: 'Das Fokus-Keyword erscheint nicht am Anfang deines Inhalts.' },
    { ok: Boolean(kw) && headings.some((h) => h.includes(kw)), points: 10, en: 'Focus Keyword not found in subheading(s) like H2, H3, H4, etc..', de: 'Fokus-Keyword wurde in keiner Zwischenüberschrift (H2, H3, H4) gefunden.' },
    { ok: text.split(/\s+/).filter(Boolean).length >= 300, points: 10, en: 'Content is too short.', de: 'Der Inhalt ist zu kurz.' },
  ];
  const score = Math.min(cap, rules.reduce((s, r) => s + (r.ok ? r.points : 0), 0));
  return { score, checks: rules.map((r) => ({ text: de ? r.de : r.en, ok: r.ok })) };
}

function gutenbergPage(o: FakeWp['options'], post: FakePost, adminBar: string, overlay: string, restRoot: string): string {
  const rm = o.rankMath ? fakeRankMathScore(post, o.language, o.rankMathScoreCap) : null;
  const panel = rm
    ? `<div class="rank-math-toolbar-score"><span class="score-text" id="rm-score">…</span></div>
       <ul class="rank-math-checklist">${rm.checks.map((c) => `<li class="${c.ok ? 'test-ok' : 'test-fail'}">${esc(c.text)}</li>`).join('')}</ul>`
    : '';
  const t = (en: string, de: string) => (o.language === 'de' ? de : en);
  const script = `
    window.wpApiSettings = { root: ${JSON.stringify(restRoot)}, nonce: ${JSON.stringify(NONCE)} };
    (function () {
      var post = ${JSON.stringify({ id: post.id, status: post.status, title: post.title, meta: post.meta })};
      var blocks = ${JSON.stringify(
        Array.from(post.content.matchAll(/<!--\s*wp:([a-z0-9/-]+)[^>]*?(\/)?-->/g))
          .filter((m) => !m[1].startsWith('list-item'))
          .map((m) => ({ name: m[1].includes('/') ? m[1] : `core/${m[1]}`, isValid: !post.content.includes('bas-invalid-block'), innerBlocks: [] })),
      )};
      if (!blocks.length) blocks = [{ name: 'core/freeform', isValid: true, innerBlocks: [] }];
      var saving = false, ok = true;
      function save(status) {
        saving = true;
        var body = { id: post.id };
        if (status) body.status = status;
        return fetch(wpApiSettings.root + 'wp/v2/posts/' + post.id, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': wpApiSettings.nonce, 'X-HTTP-Method-Override': 'PUT' }, body: JSON.stringify(body) })
          .then(function (r) { ok = r.ok; return r.json(); })
          .then(function (j) { if (ok && j.status) post.status = j.status; saving = false; })
          .catch(function () { ok = false; saving = false; });
      }
      var ready = false;
      setTimeout(function () { ready = true; }, 300);
      window.wp = { data: {
        select: function (store) {
          if (store === 'core/editor') return {
            getCurrentPostId: function () { return post.id; },
            getCurrentPostAttribute: function (k) { return post[k]; },
            getEditedPostAttribute: function (k) { return post[k]; },
            __unstableIsEditorReady: function () { return ready; },
            isSavingPost: function () { return saving; },
            didPostSaveRequestSucceed: function () { return ok; }
          };
          if (store === 'core/block-editor') return { getBlocks: function () { return ready ? blocks : []; } };
          ${o.rankMath ? `if (store === 'rank-math') return { getKeywords: function () { return post.meta.rank_math_focus_keyword || ''; }, getSerpTitle: function () { return post.meta.rank_math_title || ''; }, getSerpDescription: function () { return post.meta.rank_math_description || ''; } };` : ''}
          return null;
        },
        dispatch: function (store) {
          if (store === 'core/editor') return { savePost: function () { return save(); } };
          if (store === 'core/preferences') return { set: function () {} };
          return {};
        }
      } };
      window.__basPublish = function () { return save('publish'); };
      ${rm ? `setTimeout(function () { document.getElementById('rm-score').textContent = ${JSON.stringify(`${rm.score} / 100`)}; }, 900);` : ''}
    })();`;
  return html(
    o.language,
    `${adminBar}${overlay}<div class="edit-post-welcome-guide components-modal__frame"><div class="components-modal__header"><button aria-label="${t('Close', 'Schließen')}" onclick="this.closest('.edit-post-welcome-guide').remove()">x</button></div></div>
     <div class="edit-post-layout"><div class="block-editor"><button class="editor-post-publish-button__button" onclick="window.__basPublish()">${t('Publish', 'Veröffentlichen')}</button>${panel}</div></div>`,
    'wp-admin block-editor-page',
    `<script>${script}</script>`,
  );
}

function classicPage(o: FakeWp['options'], post: FakePost, adminBar: string, overlay: string): string {
  const t = (en: string, de: string) => (o.language === 'de' ? de : en);
  const rm = o.rankMath ? fakeRankMathScore(post, o.language, o.rankMathScoreCap) : null;
  const panel = rm
    ? `<div id="rank-math-metabox-wrapper"><div class="rank-math-seo-score"><span class="score-text">${rm.score} / 100</span></div>
       <input type="hidden" name="rank_math_focus_keyword" value="${esc(post.meta.rank_math_focus_keyword ?? '')}">
       <input type="hidden" name="rank_math_title" value="${esc(post.meta.rank_math_title ?? '')}">
       <input type="hidden" name="rank_math_description" value="${esc(post.meta.rank_math_description ?? '')}">
       <ul class="rank-math-checklist">${rm.checks.map((c) => `<li class="${c.ok ? 'test-ok' : 'test-fail'}">${esc(c.text)}</li>`).join('')}</ul></div>`
    : '';
  return html(
    o.language,
    `${adminBar}${overlay}<form id="post" method="post" action="/wp-admin/post.php">
      <input type="hidden" name="action" value="editpost"><input type="hidden" id="post_ID" name="post_ID" value="${post.id}">
      <input type="hidden" id="original_post_status" name="original_post_status" value="${post.status}">
      <input type="hidden" name="original_publish" value="${t('Publish', 'Veröffentlichen')}">
      <input id="title" name="post_title" value="${esc(post.title)}">
      <div id="postdivrich"><textarea id="content" name="content">${esc(post.content)}</textarea></div>
      <div id="submitdiv"><input type="hidden" name="post_status" value="${post.status === 'publish' ? 'publish' : 'draft'}">
        ${post.status === 'draft' ? `<input type="submit" name="save" id="save-post" value="${t('Save Draft', 'Entwurf speichern')}">` : ''}
        <input type="submit" name="publish" id="publish" value="${t('Publish', 'Veröffentlichen')}"></div>
      ${panel}
    </form>`,
    'wp-admin post-php',
  );
}

export async function startFakeWordPress(opts: FakeWpOptions = {}): Promise<FakeWp> {
  const options = {
    language: opts.language ?? 'en',
    editor: opts.editor ?? 'gutenberg',
    restDisabled: opts.restDisabled ?? false,
    overlay: opts.overlay ?? false,
    rankMath: opts.rankMath ?? false,
    rankMathScoreCap: opts.rankMathScoreCap ?? 100,
    dropCreateAcks: opts.dropCreateAcks ?? 0,
    dropMediaAcks: opts.dropMediaAcks ?? 0,
    role: opts.role ?? 'administrator',
    expiredPopup: opts.expiredPopup ?? false,
    categories: opts.categories ?? [
      { id: 1, name: opts.language === 'de' ? 'Allgemein' : 'Uncategorized', slug: opts.language === 'de' ? 'allgemein' : 'uncategorized', count: 3 },
      { id: 7, name: 'Celebrities', slug: 'celebrities', count: 12 },
      { id: 9, name: 'Tech &amp; Apps', slug: 'tech-apps', count: 5 },
    ],
  };
  const sessions = new Set<string>();
  const redirects = new Map<string, string>();
  let baseUrl = 'http://fake';
  const requests: FakeWp['requests'] = [];
  const posts = new Map<number, FakePost>();
  const tags: FakeWp['tags'] = [];
  const media: FakeWp['media'] = new Map();
  let nextId = 100;
  const t = (en: string, de: string) => (options.language === 'de' ? de : en);
  const can = (cap: string) => ROLE_CAPS[options.role].includes(cap);

  const addPost = (p: Partial<FakePost> & { title: string }): FakePost => {
    const id = p.id ?? nextId++;
    const post: FakePost = {
      id,
      status: p.status ?? 'draft',
      title: p.title,
      content: p.content ?? '',
      slug: p.slug ?? '',
      categories: p.categories ?? [1],
      tags: p.tags ?? [],
      featured_media: p.featured_media ?? 0,
      date_gmt: p.date_gmt ?? nowGmt(),
      modified_gmt: p.modified_gmt ?? nowGmt(),
      meta: p.meta ?? {},
    };
    // Like WordPress: a slug already used by another post gets a numeric suffix.
    if (post.slug) {
      let candidate = post.slug;
      for (let n = 2; [...posts.values()].some((x) => x.id !== id && x.slug === candidate); n++) candidate = `${post.slug}-${n}`;
      post.slug = candidate;
    }
    posts.set(id, post);
    return post;
  };

  const restPost = (p: FakePost) => ({
    id: p.id,
    status: p.status,
    type: 'post',
    slug: p.slug,
    generated_slug: slugify(p.title),
    link: `${baseUrl}/?p=${p.id}`,
    date_gmt: p.date_gmt,
    modified_gmt: p.modified_gmt,
    title: { raw: p.title, rendered: esc(p.title) },
    content: { raw: p.content, rendered: p.content },
    excerpt: { rendered: `<p>${esc(p.content.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160))}</p>` },
    categories: p.categories,
    tags: p.tags,
    featured_media: p.featured_media,
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : '';
    requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, body });
    const cookie = req.headers.cookie ?? '';
    const token = /wordpress_logged_in_fake=([^;]+)/.exec(cookie)?.[1];
    const loggedIn = Boolean(token && sessions.has(token));
    const send = (status: number, content: string, type = 'text/html; charset=utf-8', headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': type, ...headers });
      res.end(content);
    };
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) => send(status, JSON.stringify(data), 'application/json', headers);
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

    const restRoute = p.startsWith('/wp-json') ? p.slice('/wp-json'.length) || '/' : url.searchParams.get('rest_route');
    if (restRoute !== null) {
      if (options.restDisabled) return json(404, { code: 'rest_no_route' });
      const method = ((req.headers['x-http-method-override'] as string) || req.method || 'GET').toUpperCase();
      const write = method !== 'GET';
      const authed = loggedIn && req.headers['x-wp-nonce'] === NONCE;
      if (write && !authed) return json(loggedIn ? 403 : 401, { code: loggedIn ? 'rest_cookie_invalid_nonce' : 'rest_not_logged_in', message: 'Sorry, you are not allowed to do that.' });
      let data: Record<string, unknown> = {};
      if (body && /json/.test(String(req.headers['content-type'] ?? ''))) data = JSON.parse(body) as Record<string, unknown>;
      if (restRoute === '/' || restRoute === '') return json(200, { name: 'Fake WP', namespaces: ['oembed/1.0', 'wp/v2', ...(options.rankMath ? ['rankmath/v1'] : [])] });
      if (restRoute === '/wp/v2/users/me' && method === 'GET') {
        if (!authed) return json(401, { code: 'rest_not_logged_in', message: 'You are not currently logged in.' });
        return json(200, { id: 1, name: 'Fake Owner', roles: [options.role], capabilities: Object.fromEntries(ROLE_CAPS[options.role].map((c) => [c, true])) });
      }
      if (restRoute === '/wp/v2/categories') {
        const perPage = Number(url.searchParams.get('per_page') ?? '10');
        const page = Number(url.searchParams.get('page') ?? '1');
        const total = Math.max(1, Math.ceil(options.categories.length / perPage));
        if (page > total) return json(400, { code: 'rest_post_invalid_page_number' });
        const items = options.categories.slice((page - 1) * perPage, page * perPage).map((c) => ({ id: c.id, name: c.name, slug: c.slug, parent: c.parent ?? 0, count: c.count ?? 0 }));
        return json(200, items, { 'X-WP-TotalPages': String(total), 'X-WP-Total': String(options.categories.length) });
      }
      const cat = /^\/wp\/v2\/categories\/(\d+)$/.exec(restRoute);
      if (cat) {
        const c = options.categories.find((x) => x.id === Number(cat[1]));
        return c ? json(200, { id: c.id }) : json(404, { code: 'rest_term_invalid' });
      }
      if (restRoute === '/wp/v2/tags') {
        if (method === 'POST') {
          const name = String(data.name ?? '').trim();
          const existing = tags.find((x) => x.name.toLowerCase() === name.toLowerCase());
          if (existing) return json(400, { code: 'term_exists', message: 'A term with the name provided already exists.', data: { status: 400, term_id: existing.id } });
          const tag = { id: 500 + tags.length, name, slug: slugify(name) };
          tags.push(tag);
          return json(201, tag);
        }
        const search = (url.searchParams.get('search') ?? '').toLowerCase();
        return json(200, tags.filter((x) => x.name.toLowerCase().includes(search)));
      }
      if (restRoute === '/wp/v2/posts') {
        if (method === 'POST') {
          if (!can('edit_posts')) return json(403, { code: 'rest_cannot_create', message: 'Sorry, you are not allowed to create posts as this user.' });
          const cats = (data.categories as number[] | undefined) ?? [1];
          if (cats.some((c) => !options.categories.some((x) => x.id === c))) return json(400, { code: 'rest_invalid_param', message: 'Invalid parameter(s): categories' });
          const post = addPost({ title: String(data.title ?? ''), content: String(data.content ?? ''), slug: String(data.slug ?? ''), status: String(data.status ?? 'draft'), categories: cats, tags: (data.tags as number[]) ?? [], featured_media: Number(data.featured_media ?? 0) });
          if (options.dropCreateAcks > 0) {
            options.dropCreateAcks--;
            req.socket.destroy(); // the post exists, but the answer is lost
            return;
          }
          return json(201, restPost(post));
        }
        const search = (url.searchParams.get('search') ?? '').toLowerCase();
        const statuses = (url.searchParams.get('status') ?? 'publish').split(',');
        const list = [...posts.values()].filter((x) => statuses.includes(x.status) && (!search || x.title.toLowerCase().includes(search) || x.content.toLowerCase().includes(search))).sort((a, b) => b.id - a.id);
        return json(200, list.map(restPost));
      }
      const one = /^\/wp\/v2\/posts\/(\d+)$/.exec(restRoute);
      if (one) {
        const post = posts.get(Number(one[1]));
        if (!post) return json(404, { code: 'rest_post_invalid_id', message: 'Invalid post ID.' });
        // Like WordPress cron: a scheduled post whose time has come is published.
        if (post.status === 'future' && Date.parse(`${post.date_gmt}Z`) <= Date.now()) post.status = 'publish';
        if (method === 'GET') return json(200, restPost(post));
        if (method === 'DELETE') {
          post.status = 'trash';
          return json(200, restPost(post));
        }
        for (const k of ['title', 'content', 'slug', 'status'] as const) if (typeof data[k] === 'string') (post as unknown as Record<string, unknown>)[k] = data[k];
        if (typeof data.date_gmt === 'string') post.date_gmt = data.date_gmt.replace(/Z$/, '').slice(0, 19);
        // WordPress publishes immediately when "future" is requested for a time already passed.
        if (post.status === 'future' && Date.parse(`${post.date_gmt}Z`) <= Date.now()) post.status = 'publish';
        if (Array.isArray(data.categories)) post.categories = data.categories as number[];
        if (Array.isArray(data.tags)) post.tags = data.tags as number[];
        if (typeof data.featured_media === 'number') post.featured_media = data.featured_media;
        post.modified_gmt = nowGmt();
        return json(200, restPost(post));
      }
      if (restRoute === '/wp/v2/media' && method === 'POST') {
        if (!can('upload_files')) return json(403, { code: 'rest_cannot_create', message: 'Sorry, you are not allowed to upload files.' });
        const filename = /filename="([^"]+)"/.exec(String(req.headers['content-disposition'] ?? ''))?.[1] ?? 'upload.bin';
        const id = nextId++;
        // Like WordPress: the attachment slug comes from the file name (unique: a taken slug gets a suffix).
        const base = slugify(filename.replace(/\.[^.]+$/, ''));
        let slug = base;
        for (let n = 2; [...media.values()].some((m) => m.slug === slug); n++) slug = `${base}-${n}`;
        const item = { id, bytes: Number(req.headers['content-length'] ?? body.length), mime: String(req.headers['content-type'] ?? ''), filename, slug, alt: '', url: `${baseUrl}/wp-content/uploads/${filename}` };
        media.set(id, item);
        if (options.dropMediaAcks > 0) {
          options.dropMediaAcks--;
          req.socket.destroy(); // the file is stored, but the answer is lost
          return;
        }
        return json(201, { id, source_url: item.url, mime_type: item.mime, alt_text: '', slug });
      }
      if (restRoute === '/wp/v2/media' && method === 'GET') {
        const slug = url.searchParams.get('slug');
        const list = [...media.values()].filter((m) => !slug || m.slug === slug);
        return json(200, list.map((m) => ({ id: m.id, source_url: m.url, alt_text: m.alt, slug: m.slug })));
      }
      const mediaOne = /^\/wp\/v2\/media\/(\d+)$/.exec(restRoute);
      if (mediaOne) {
        const item = media.get(Number(mediaOne[1]));
        if (!item) return json(404, { code: 'rest_post_invalid_id' });
        if (method === 'POST' && typeof data.alt_text === 'string') item.alt = data.alt_text;
        return json(200, { id: item.id, source_url: item.url, alt_text: item.alt });
      }
      if (restRoute === '/rankmath/v1/updateMeta' && options.rankMath) {
        const post = posts.get(Number(data.objectID));
        if (!post) return json(404, { code: 'invalid_post' });
        Object.assign(post.meta, data.meta as Record<string, string>);
        return json(200, { slug: post.slug });
      }
      return json(404, { code: 'rest_no_route', message: 'No route was found matching the URL and request method.' });
    }

    if (p.startsWith('/wp-admin')) {
      if (!loggedIn && p !== '/wp-admin/admin-ajax.php') return redirect(`/wp-login.php?redirect_to=${encodeURIComponent(p + url.search)}&reauth=1`);
      // WordPress prints its (hidden) session-expired pop-up on every admin page; it shows when the login cookie is gone.
      // Like WordPress: the wrapper has no size of its own (its children are fixed-position).
      const authCheck = `<div id="wp-auth-check-wrap" class="${options.expiredPopup ? '' : 'hidden'}" style="${options.expiredPopup ? '' : 'display:none'}"><div id="wp-auth-check-bg" style="position:fixed;inset:0"></div><div id="wp-auth-check" style="position:fixed;top:40px;left:40px;width:300px;height:200px"><div class="wp-auth-check-close"></div>${t('Session expired', 'Sitzung abgelaufen')}</div></div>`;
      const adminBar = `<div id="wpadminbar">${t('Howdy', 'Willkommen')}</div><ul id="adminmenu"></ul>${authCheck}`;
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
      if (p === '/wp-admin/post.php') {
        if (req.method === 'POST') {
          const form = new URLSearchParams(body);
          const post = posts.get(Number(form.get('post_ID')));
          if (!post) return send(404, 'no post');
          post.title = form.get('post_title') ?? post.title;
          post.content = form.get('content') ?? post.content;
          if (form.has('publish')) post.status = 'publish';
          post.modified_gmt = nowGmt();
          return redirect(`/wp-admin/post.php?post=${post.id}&action=edit&message=${form.has('publish') ? 6 : 10}`);
        }
        const post = posts.get(Number(url.searchParams.get('post')));
        if (!post) return send(404, html(options.language, `${adminBar}Not found`, 'wp-admin'));
        const restRoot = `${url.protocol}//${req.headers.host}/wp-json/`;
        return send(200, options.editor === 'gutenberg' ? gutenbergPage(options, post, adminBar, overlay, restRoot) : classicPage(options, post, adminBar, overlay));
      }
      return send(404, html(options.language, `${adminBar}Not found`, 'wp-admin'));
    }

    const target = redirects.get(p + url.search) ?? redirects.get(p);
    if (target) return redirect(target);
    // Public post pages: only published posts are visible.
    const byId = url.searchParams.get('p') ? posts.get(Number(url.searchParams.get('p'))) : [...posts.values()].find((x) => x.slug && p === `/${x.slug}/`);
    if (byId || url.searchParams.get('p')) {
      if (!byId || byId.status !== 'publish') return send(404, html(options.language, `<h1>${t('Page not found', 'Seite nicht gefunden')}</h1>`, 'error404'));
      return send(200, `<!doctype html><html lang="${options.language}"><head><title>${esc(byId.title)} – Fake blog</title></head><body><h1>${esc(byId.title)}</h1>${byId.content}</body></html>`);
    }
    if (p === '/') return send(200, html(options.language, '<h1>Fake blog</h1>'));
    return send(404, 'not found', 'text/plain');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  baseUrl = url;
  return {
    url,
    adminUrl: `${url}/wp-admin/`,
    options,
    sessions,
    requests,
    posts,
    tags,
    media,
    addPost,
    redirects,
    logoutAll: () => sessions.clear(),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
