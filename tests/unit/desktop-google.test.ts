import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Owner request (2026-11-08): Search Console in the desktop app. Its tab shows only Search Console and Google's own
 * sign-in pages (desktop/google-hosts.cjs); every other address opens in the default browser.
 */
const require = createRequire(import.meta.url);
const { staysInGoogleTab, SEARCH_CONSOLE_URL } = require(path.resolve(__dirname, '..', '..', 'desktop', 'google-hosts.cjs')) as { staysInGoogleTab: (url: string) => boolean; SEARCH_CONSOLE_URL: string };

describe("the desktop app's Search Console tab", () => {
  it('shows Search Console and the pages Google signs in through', () => {
    expect(SEARCH_CONSOLE_URL).toBe('https://search.google.com/search-console');
    for (const url of [
      SEARCH_CONSOLE_URL,
      'https://search.google.com/search-console/inspect?resource_id=sc-domain%3Aexample.com',
      'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fsearch.google.com%2Fsearch-console',
      'https://accounts.google.com.pk/accounts/SetSID',
      'https://accounts.google.de/accounts/SetSID',
      'https://myaccount.google.com/',
      'https://www.google.com/accounts/CheckCookie',
      'https://accounts.youtube.com/accounts/SetSID',
      'https://ssl.gstatic.com/accounts/static/x.js',
    ])
      expect(staysInGoogleTab(url), url).toBe(true);
  });

  it('everything else opens in the default browser (other sites, look-alikes, http)', () => {
    for (const url of [
      'https://example.com/',
      'https://chatgpt.com/',
      'https://google.com.evil.example/',
      'https://notgoogle.com/',
      'https://google.com-login.example/',
      'https://evilgoogle.com/',
      'http://accounts.google.com/',
      'https://www.youtube.com/watch?v=1',
      'javascript:alert(1)',
      'not a url',
    ])
      expect(staysInGoogleTab(url), url).toBe(false);
  });
});
