import type { BrowserContext } from 'playwright';

export interface FakeSearchConsoleConfig {
  /**
   * 'ok': “Indexing requested”; 'quota': the daily limit; 'signed-out': redirect to Google sign-in; 'signed-out-about':
   * redirect to Search Console's start page for signed-out visitors; 'no-access'.
   */
  mode?: 'ok' | 'quota' | 'signed-out' | 'signed-out-about' | 'no-access';
  /** How long the live test runs after REQUEST INDEXING. */
  liveTestMs?: number;
}

/**
 * A FAKE Search Console URL Inspection page on https://search.google.com/ (Playwright routing; nothing reaches Google).
 * It shows a result, a REQUEST INDEXING button, a live test, then Google's answer, as on the owner's screenshot.
 * `clicks()` counts REQUEST INDEXING clicks.
 */
export async function installFakeSearchConsole(context: BrowserContext, getConfig: () => FakeSearchConsoleConfig): Promise<{ clicks: () => number; opened: () => string[] }> {
  let clicks = 0;
  const opened: string[] = [];
  await context.route('https://accounts.google.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Sign in – Google Accounts</title><h1>Sign in</h1><p>to continue to Search Console</p>' }));
  await context.route('https://search.google.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/__fake/click') {
      clicks++;
      return route.fulfill({ status: 204, body: '' });
    }
    if (route.request().resourceType() !== 'document') return route.fulfill({ status: 404, body: '' });
    opened.push(url.toString());
    if (url.pathname.startsWith('/search-console/about')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Google Search Console</title><h1>Improve your performance on Google Search</h1><a href="https://accounts.google.com/ServiceLogin">Start now</a>' });
    const c = { mode: 'ok', liveTestMs: 1500, ...getConfig() };
    const inspected = url.searchParams.get('id') ?? '';
    const property = url.searchParams.get('resource_id') ?? '';
    const page = `<!doctype html><html><head><meta charset="utf-8"><title>URL Inspection</title></head><body><div id="app">Retrieving data from Google Index…</div><script>
      const C = ${JSON.stringify(c)};
      const app = document.getElementById('app');
      if (C.mode === 'signed-out') location.replace('https://accounts.google.com/ServiceLogin?service=sitemaps&continue=' + encodeURIComponent(location.href));
      if (C.mode === 'signed-out-about') location.replace('https://search.google.com/search-console/about');
      setTimeout(() => {
        if (C.mode === 'no-access') { app.innerHTML = '<h2>You don\\'t have access to property ${property.replace(/'/g, '')}</h2>'; return; }
        app.innerHTML = '<h1>URL Inspection</h1><p>${inspected.replace(/'/g, '')}</p><section><h2>URL is not on Google</h2><p>This page is not indexed.</p><div><span>Page changed?</span> <div role="button" tabindex="0" id="req"><span>REQUEST INDEXING</span></div></div></section>';
        document.getElementById('req').addEventListener('click', () => {
          fetch('/__fake/click', { method: 'POST' });
          app.insertAdjacentHTML('beforeend', '<div role="dialog" id="live"><p>Testing if live URL can be indexed</p></div>');
          setTimeout(() => {
            document.getElementById('live').remove();
            app.insertAdjacentHTML('beforeend', C.mode === 'quota'
              ? '<div role="dialog"><h2>Quota exceeded</h2><p>Sorry--we couldn\\'t process this request because you\\'ve exceeded your daily quota. Please try submitting this again tomorrow.</p></div>'
              : '<div role="dialog"><h2>Indexing requested</h2><p>URL was added to a priority crawl queue. Submitting a page multiple times will not change its queue position or priority.</p><div role="button">Dismiss</div></div>');
          }, C.liveTestMs);
        });
      }, 800);
    </script></body></html>`;
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: page });
  });
  return { clicks: () => clicks, opened: () => opened };
}
