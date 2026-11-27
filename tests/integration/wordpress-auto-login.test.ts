import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient, Website } from '@prisma/client';
import type { BrowserContext, Page } from 'playwright';
import { setupTestDb } from '../helpers/test-db';
import { startFakeWordPress, type FakeWp } from '../fixtures/fake-wordpress';
import { configureTestBrowser } from '../helpers/browser';
import { createTask } from '../helpers/fixtures';

/**
 * Owner request: “remove the manual login, add the password with Add website, then it logs in by itself”. The saved
 * sign-in is typed only into the website's own login page; a refused password is not tried again; a 2-step code or a
 * CAPTCHA is left to the owner in the visible window (pre-filled), never solved.
 */
let client: PrismaClient;
let session: typeof import('@/wordpress/session');
let browser: typeof import('@/wordpress/browser');
let creds: typeof import('@/lib/wp-credentials');
const servers: FakeWp[] = [];
const PASSWORD = 'S3cret-Owner-Pass!';
const CSRF = 'test-csrf-token-1234567890';

/** The owner's own step in the visible window, when the test says the owner is there. */
let owner: ((page: Page) => Promise<void>) | null = null;

async function call(handler: (req: Request, arg: { params: Promise<Record<string, string>> }) => Promise<Response>, method: string, url: string, params: Record<string, string>, json?: unknown) {
  const headers: Record<string, string> = { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: `bas_csrf=${CSRF}`, 'x-csrf-token': CSRF };
  if (json !== undefined) headers['content-type'] = 'application/json';
  return handler(new Request(`http://localhost:3000${url}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) }), { params: Promise.resolve(params) });
}

beforeAll(async () => {
  configureTestBrowser();
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  session = await import('@/wordpress/session');
  browser = await import('@/wordpress/browser');
  creds = await import('@/lib/wp-credentials');
  browser.onWordPressContext(async (context: BrowserContext) => {
    const watch = setInterval(async () => {
      const page = context.pages()[0];
      if (!owner || !page || page.isClosed()) return;
      const step = owner;
      owner = null;
      await step(page).catch(() => {});
    }, 700);
    context.on('close', () => clearInterval(watch));
  });
});

afterAll(async () => {
  await browser.closeAllContexts();
  for (const s of servers) await s.close();
});

async function newSite(wp: FakeWp, name: string): Promise<Website> {
  const route = await import('../../app/api/websites/route');
  const res = await call(route.POST, 'POST', '/api/websites', {}, { name, publicUrl: wp.url, language: 'en', targetCountry: 'United States', timezone: 'America/New_York', login: { username: 'owner', password: PASSWORD } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { website: { id: string }; loginQueued: boolean };
  expect(body.loginQueued).toBe(true);
  return client.website.findUniqueOrThrow({ where: { id: body.website.id } });
}

describe('WordPress sign-in saved with the website: automatic login', () => {
  it('Add website with a user name and password: saved encrypted (never in the database, logs or the API), login queued, and the app signs in by itself', async () => {
    const wp = await startFakeWordPress({ password: PASSWORD });
    servers.push(wp);
    const site = await newSite(wp, 'Auto Login Site');
    expect(await client.queueJob.count({ where: { queue: 'control', kind: 'wp.login', websiteId: site.id } })).toBe(1);

    // Nowhere in clear text: not in the credentials file, the database or the API's answer.
    expect(fs.readFileSync(`${process.env.BAS_DATA_DIR}/credentials/wordpress-logins.json`, 'utf8')).not.toContain(PASSWORD);
    const loginRoute = await import('../../app/api/websites/[id]/login/route');
    const got = await (await call(loginRoute.GET, 'GET', `/api/websites/${site.id}/login`, { id: site.id })).json();
    expect(JSON.stringify(got)).not.toContain(PASSWORD);
    expect(got.login).toMatchObject({ username: 'owner', last: null });

    const result = await session.autoLogin(site);
    expect(result).toMatchObject({ state: 'ACTIVE' });
    expect(wp.loginPosts()).toBe(1);
    // “Remember me” was ticked: the session survives a restart of the browser.
    await browser.closeAllContexts();
    expect((await session.testSession(site)).state).toBe('ACTIVE');
    expect(creds.savedLogin(site.id)?.last).toMatchObject({ ok: true });

    const dump = JSON.stringify([await client.log.findMany(), await client.auditLog.findMany(), await client.website.findMany(), await client.browserProfile.findMany(), await client.queueJob.findMany()]);
    expect(dump).not.toContain(PASSWORD);
  }, 120_000);

  it('a password WordPress refuses is recorded and not tried again until it is changed (no account lock-out)', async () => {
    const wp = await startFakeWordPress({ password: 'the-real-one' });
    servers.push(wp);
    const site = await newSite(wp, 'Wrong Password Site');
    const result = await session.autoLogin(site);
    expect(result).toMatchObject({ state: 'LOGIN_REQUIRED', refused: true });
    expect(result.detail).toMatch(/refused the saved sign-in: “Error: The password you entered for the username owner is incorrect\.”/);
    expect(result.detail).not.toContain(PASSWORD);
    expect(wp.loginPosts()).toBe(1);
    // Neither a job nor the worker loop tries it again.
    expect(await session.autoLoginIfSaved(await client.website.findUniqueOrThrow({ where: { id: site.id } }))).toBe(false);
    const { autoLoginTick } = await import('@/wordpress/auto-login-loop');
    await autoLoginTick();
    expect(wp.loginPosts()).toBe(1);
    // Changed: tried again, and it works.
    creds.saveLogin(site.id, 'owner', 'the-real-one');
    expect((await session.autoLogin(site)).state).toBe('ACTIVE');
    expect(wp.loginPosts()).toBe(2);
  }, 120_000);

  it('a 2-step code: the automatic login stops; the window opens with the sign-in filled in and the owner types only the code', async () => {
    const wp = await startFakeWordPress({ password: PASSWORD, twoFactor: '424242' });
    servers.push(wp);
    const site = await newSite(wp, 'Two Step Site');
    const auto = await session.autoLogin(site);
    expect(auto).toMatchObject({ state: 'LOGIN_REQUIRED', needsOwner: true });
    expect(auto.detail).toMatch(/second step/);
    // The owner only types the code; the user name and password were filled in and sent by the app. (The automatic
    // login's window is closed first, so the owner's step goes to the visible one.)
    await browser.closeAllContexts();
    owner = async (page) => {
      await page.waitForSelector('#authcode', { timeout: 20_000 });
      await page.fill('#authcode', '424242');
      await page.click('#wp-2fa-submit');
    };
    const login = await session.interactiveLogin(await client.website.findUniqueOrThrow({ where: { id: site.id } }), async () => true, 60_000);
    expect(login.state).toBe('ACTIVE');
    expect(login.detail).toMatch(/saved sign-in filled in/);
    expect(wp.loginPosts()).toBe(2);
  }, 120_000);

  it('a CAPTCHA: nothing is sent automatically; the window has the sign-in filled in and the owner does the check', async () => {
    const wp = await startFakeWordPress({ password: PASSWORD, captcha: true });
    servers.push(wp);
    const site = await newSite(wp, 'Captcha Site');
    const auto = await session.autoLogin(site);
    expect(auto).toMatchObject({ state: 'LOGIN_REQUIRED', needsOwner: true });
    expect(auto.detail).toMatch(/CAPTCHA/);
    expect(wp.loginPosts()).toBe(0);
    await browser.closeAllContexts();
    owner = async (page) => {
      await page.waitForSelector('#user_pass', { timeout: 20_000 });
      // The fields were filled in by the app; the owner does the check and clicks Log In.
      expect(await page.inputValue('#user_login')).toBe('owner');
      await page.evaluate(() => ((document.getElementById('g-recaptcha-response') as HTMLInputElement).value = 'ok'));
      await page.click('#wp-submit');
    };
    const login = await session.interactiveLogin(await client.website.findUniqueOrThrow({ where: { id: site.id } }), async () => true, 60_000);
    expect(login.state).toBe('ACTIVE');
    expect(wp.loginPosts()).toBe(1);
  }, 120_000);

  it('the session ends: the worker signs in again by itself and the paused article goes on', async () => {
    const wp = await startFakeWordPress({ password: PASSWORD });
    servers.push(wp);
    const site = await newSite(wp, 'Expired Session Site');
    expect((await session.autoLogin(site)).state).toBe('ACTIVE');
    // WordPress ends the session; a job finds the login page and the article pauses for the sign-in.
    wp.logoutAll();
    await client.browserProfile.update({ where: { id: site.wordpressProfileId! }, data: { sessionState: 'LOGIN_REQUIRED' } });
    const task = await createTask(client, site.id, { keyword: 'paused for the sign-in' });
    await client.articleTask.update({ where: { id: task.id }, data: { status: 'LOGIN_REQUIRED', pausedFor: 'wordpress-login' } });
    const { autoLoginTick } = await import('@/wordpress/auto-login-loop');
    expect(await autoLoginTick()).toBe(1);
    expect((await client.browserProfile.findUniqueOrThrow({ where: { id: site.wordpressProfileId! } })).sessionState).toBe('ACTIVE');
    expect((await client.articleTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('QUEUED');
    // At most once per website every 10 minutes.
    wp.logoutAll();
    await client.browserProfile.update({ where: { id: site.wordpressProfileId! }, data: { sessionState: 'LOGIN_REQUIRED' } });
    expect(await autoLoginTick()).toBe(0);
  }, 120_000);

  it('removing the saved sign-in: no automatic login any more', async () => {
    const site = (await client.website.findFirstOrThrow({ where: { name: 'Expired Session Site' } }));
    const loginRoute = await import('../../app/api/websites/[id]/login/route');
    const res = await call(loginRoute.DELETE, 'DELETE', `/api/websites/${site.id}/login`, { id: site.id });
    expect(await res.json()).toEqual({ removed: true });
    expect(creds.savedLogin(site.id)).toBeNull();
    expect(creds.loginFor(site.id)).toBeNull();
    expect((await session.autoLogin(site)).needsOwner).toBe(true);
  }, 60_000);
});
