/**
 * Runs under tsx — the worker's toolchain, which wraps named functions in
 * `__name()`. Opens a WordPress profile context the way the worker does and
 * evaluates a function with a named inner helper in the page. Prints JSON.
 */
import { chromium } from 'playwright';
import { firstPage, withSiteContext, closeAllContexts } from '@/wordpress/browser';

const url = process.argv[2];
const site = { id: 'toolchain-check', slug: 'toolchain-check', name: 'Check', adminUrl: `${url}/wp-admin/`, publicUrl: url, language: 'en' };
const inPage = () => {
  const named = (x: number) => x + 1;
  return named(1);
};
const viaWorkerContext = await withSiteContext(site, { headed: false, purpose: 'check' }, async (context) => {
  const page = await firstPage(context);
  await page.goto(url);
  return page.evaluate(inPage).then(
    (v) => ({ ok: true, value: v }),
    (e: Error) => ({ ok: false, error: e.message.split('\n')[0] }),
  );
});
await closeAllContexts();
// Negative control: a bare context without the app's init script.
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH, headless: true });
const bare = await (await browser.newContext()).newPage();
await bare.goto(url);
const withoutShim = await bare.evaluate(inPage).then(
  (v) => ({ ok: true, value: v }),
  (e: Error) => ({ ok: false, error: e.message.split('\n')[0] }),
);
await browser.close();
console.log(JSON.stringify({ viaWorkerContext, withoutShim }));
