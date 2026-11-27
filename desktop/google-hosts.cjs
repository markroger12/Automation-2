'use strict';
/**
 * Which addresses the app's Search Console tab may show (owner request 2026-11-08: “search console ko bhi app me add
 * krde, check krta hon login kr ke”): Search Console and Google's own sign-in, which passes through a few Google
 * addresses (accounts.google.com, the country domain such as accounts.google.com.pk, accounts.youtube.com for its
 * sign-in cookie, gstatic.com). Everything else opens in the default browser. Plain Node.js, no Electron: tested by
 * tests/unit/desktop-google.test.ts.
 */

const GOOGLE_HOST = /^([a-z0-9-]+\.)*google\.com(\.[a-z]{2})?$|^([a-z0-9-]+\.)*google\.[a-z]{2}$/;

/** True for a page the Search Console tab shows itself (https only). */
function staysInGoogleTab(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return GOOGLE_HOST.test(host) || host === 'accounts.youtube.com' || host === 'www.gstatic.com' || host === 'ssl.gstatic.com';
  } catch {
    return false;
  }
}

const SEARCH_CONSOLE_URL = 'https://search.google.com/search-console';

module.exports = { staysInGoogleTab, SEARCH_CONSOLE_URL };
