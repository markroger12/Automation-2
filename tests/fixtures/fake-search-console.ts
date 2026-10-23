import type { BrowserContext } from 'playwright';

export interface FakeSearchConsoleConfig {
  /**
   * 'ok': “Indexing requested”; 'quota': the daily limit; 'signed-out': redirect to Google sign-in; 'signed-out-about':
   * redirect to Search Console's start page for signed-out visitors; 'no-access'.
   */
  mode?: 'ok' | 'quota' | 'signed-out' | 'signed-out-about' | 'no-access';
  /** How long the live test runs after REQUEST INDEXING. */
  liveTestMs?: number;
  /** The “Inspect any URL in …” box at the top of Search Console (default: shown). */
  searchBox?: boolean;
  /**
   * Google's reCAPTCHA on the page. 'invisible': loaded but never shown (as on Google's own pages; owner report:
   * “Google showed a check” though none was on screen). 'challenge': an “I'm not a robot” challenge is shown after
   * REQUEST INDEXING until the owner completes it (`challengeMs`; never when absent), then the live test goes on.
   */
  recaptcha?: 'invisible' | 'challenge';
  challengeMs?: number;
}

/** An inspection link as Google's URL Inspection API gives it: the `id` is Google's token, not the URL. */
export const fakeInspectionLink = (property: string, url: string) => `https://search.google.com/search-console/inspect?resource_id=${encodeURIComponent(property)}&id=tok_${Buffer.from(url).toString('base64url')}&utm_medium=link`;

/**
 * A FAKE Search Console on https://search.google.com/ (Playwright routing; nothing reaches Google), as the owner's
 * screenshots show it:
 * - `/search-console?resource_id=…` is the property's start page with the “Inspect any URL in …” box; Enter shows
 *   the URL Inspection result (the address becomes …/inspect?resource_id=…&id=<token>);
 * - `/search-console/inspect?…&id=<token>` shows the result directly, but with the post's URL as `id` Google answers
 *   404 (owner report);
 * - the result has REQUEST INDEXING, a live test, then Google's answer.
 * `clicks()` counts REQUEST INDEXING clicks, `typed()` the URLs typed into the box.
 */
export async function installFakeSearchConsole(context: BrowserContext, getConfig: () => FakeSearchConsoleConfig): Promise<{ clicks: () => number; opened: () => string[]; typed: () => string[] }> {
  let clicks = 0;
  const opened: string[] = [];
  const typed: string[] = [];
  // reCAPTCHA's frames (empty here; the page decides whether they are shown).
  await context.route('https://www.google.com/recaptcha/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>reCAPTCHA</title>' }));
  await context.route('https://accounts.google.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Sign in – Google Accounts</title><h1>Sign in</h1><p>to continue to Search Console</p>' }));
  await context.route('https://search.google.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/__fake/click') {
      clicks++;
      return route.fulfill({ status: 204, body: '' });
    }
    if (url.pathname === '/__fake/typed') {
      typed.push(url.searchParams.get('u') ?? '');
      return route.fulfill({ status: 204, body: '' });
    }
    if (route.request().resourceType() !== 'document') return route.fulfill({ status: 404, body: '' });
    opened.push(url.toString());
    if (url.pathname.startsWith('/search-console/about')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Google Search Console</title><h1>Improve your performance on Google Search</h1><a href="https://accounts.google.com/ServiceLogin">Start now</a>' });
    const id = url.searchParams.get('id') ?? '';
    if (url.pathname === '/search-console/inspect' && !id.startsWith('tok_')) {
      return route.fulfill({ status: 404, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Error 404 (Not Found)!!1</title><p><b>404.</b> <ins>That’s an error.</ins></p><p>The requested URL was not found on this server. <ins>That’s all we know.</ins></p>' });
    }
    const c = { mode: 'ok', liveTestMs: 1500, searchBox: true, ...getConfig() };
    const property = url.searchParams.get('resource_id') ?? '';
    const direct = url.pathname === '/search-console/inspect' ? Buffer.from(id.slice(4), 'base64url').toString() : null;
    const page = `<!doctype html><html><head><meta charset="utf-8"><title>Search Console</title></head><body><div id="top"></div><div id="app">Loading…</div><script>
      const C = ${JSON.stringify(c)};
      const PROPERTY = ${JSON.stringify(property)};
      const DIRECT = ${JSON.stringify(direct)};
      const app = document.getElementById('app');
      // As Google loads it: an invisible reCAPTCHA (its badge hidden) and its challenge frame kept off screen.
      if (C.recaptcha) {
        document.body.insertAdjacentHTML('beforeend', '<div class="grecaptcha-badge" style="width:256px;height:60px;position:fixed;bottom:14px;right:-186px;visibility:hidden"><iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/enterprise/anchor?ar=1&k=fake&size=invisible" width="256" height="60"></iframe></div>'
          + '<div id="rc-challenge" style="visibility:hidden;position:absolute;left:0;top:-10000px;z-index:2000000000"><iframe title="recaptcha challenge expires in two minutes" src="https://www.google.com/recaptcha/enterprise/bframe?k=fake" width="400" height="580"></iframe></div>');
      }
      function challenge(then) {
        if (C.recaptcha !== 'challenge') return then();
        const box = document.getElementById('rc-challenge');
        box.style.visibility = 'visible';
        box.style.top = '40px';
        if (C.challengeMs !== undefined) setTimeout(() => { box.style.visibility = 'hidden'; box.style.top = '-10000px'; then(); }, C.challengeMs);
      }
      if (C.mode === 'signed-out') location.replace('https://accounts.google.com/ServiceLogin?service=sitemaps&continue=' + encodeURIComponent(location.href));
      if (C.mode === 'signed-out-about') location.replace('https://search.google.com/search-console/about');
      function inspection(inspected) {
        if (C.mode === 'no-access') { app.innerHTML = '<h2>You don\\'t have access to property ' + PROPERTY + '</h2>'; return; }
        app.innerHTML = '<h1>URL Inspection</h1><p></p><section><h2>URL is not on Google</h2><p>This page is not indexed.</p><div><span>Page changed?</span> <div role="button" tabindex="0" id="req"><span>REQUEST INDEXING</span></div></div></section>';
        app.querySelector('p').textContent = inspected;
        document.getElementById('req').addEventListener('click', () => {
          fetch('/__fake/click', { method: 'POST' });
          app.insertAdjacentHTML('beforeend', '<div role="dialog" id="live"><p>Testing if live URL can be indexed</p></div>');
          challenge(() => setTimeout(() => {
            document.getElementById('live').remove();
            app.insertAdjacentHTML('beforeend', C.mode === 'quota'
              ? '<div role="dialog"><h2>Quota exceeded</h2><p>Sorry--we couldn\\'t process this request because you\\'ve exceeded your daily quota. Please try submitting this again tomorrow.</p></div>'
              : '<div role="dialog"><h2>Indexing requested</h2><p>URL was added to a priority crawl queue. Submitting a page multiple times will not change its queue position or priority.</p><div role="button">Dismiss</div></div>');
          }, C.liveTestMs));
        });
      }
      setTimeout(() => {
        if (C.searchBox) {
          const domain = PROPERTY.replace('sc-domain:', '').replace('https://', '').replace('http://', '').replace(/[/]$/, '');
          document.getElementById('top').innerHTML = '<header><input type="text" id="q"></header>';
          const q = document.getElementById('q');
          q.setAttribute('aria-label', 'Inspect any URL in "' + domain + '"');
          q.setAttribute('placeholder', 'Inspect any URL in "' + domain + '"');
          q.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || !q.value.trim()) return;
            fetch('/__fake/typed?u=' + encodeURIComponent(q.value.trim()));
            history.pushState({}, '', '/search-console/inspect?resource_id=' + encodeURIComponent(PROPERTY) + '&id=tok_x');
            app.textContent = 'Retrieving data from Google Index…';
            const inspected = q.value.trim();
            setTimeout(() => inspection(inspected), 800);
          });
        }
        if (DIRECT) inspection(DIRECT);
        else app.innerHTML = '<h1>Overview</h1><p>Performance · Indexing</p>';
      }, 600);
    </script></body></html>`;
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: page });
  });
  return { clicks: () => clicks, opened: () => opened, typed: () => typed };
}
