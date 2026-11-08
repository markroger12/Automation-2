import { db } from '@/lib/db';
import { log, errorMessage } from '@/lib/log';
import { registerControlHandler } from './control';
import { launchAutomationChrome } from '@/lib/automation-chrome';
import { GOOGLE_SIGNIN_URL } from '@/lib/gsc/request-indexing';
import { renderGscProof } from '@/lib/gsc/proof';
import { autoLogin, deleteProfile, detectEditor, interactiveLogin, openAdminWindow, resetSession, syncCategories, testSession } from '@/wordpress/session';
import { savedLogin } from '@/lib/wp-credentials';
import { refreshLinkIndex } from '@/wordpress/link-index';
import { scheduleKeywordPost, verifyKeywordPublished } from '@/wordpress/schedule';
import { applyContentRevision } from '@/wordpress/refresh-apply';

async function site(websiteId: unknown) {
  if (typeof websiteId !== 'string') throw new Error('Missing websiteId');
  const s = await db.website.findUnique({ where: { id: websiteId } });
  if (!s) throw new Error('Website not found');
  return s;
}

/** Registers control-queue handlers. Only the worker opens browsers. */
export function registerBuiltInControlHandlers(): void {
  registerControlHandler('wp.login', async (job, payload, { heartbeat }) => {
    const s = await site(payload.websiteId ?? job.websiteId);
    // Owner request: with a saved sign-in the app logs in by itself; the window opens only for what needs the owner
    // (a CAPTCHA or a second-factor code, or no saved sign-in) — then with the user name and password filled in.
    const saved = savedLogin(s.id);
    let result = saved && !saved.last?.refused ? await autoLogin(s) : null;
    if (!result || (result.state !== 'ACTIVE' && (result.needsOwner || result.refused))) result = await interactiveLogin(await site(s.id), heartbeat);
    const extra: Record<string, unknown> = {};
    if (result.state === 'ACTIVE') {
      try {
        extra.editor = await detectEditor(s);
      } catch (error) {
        extra.editorError = errorMessage(error);
      }
      try {
        extra.categories = (await syncCategories(await site(s.id))).count;
      } catch (error) {
        extra.categoryError = errorMessage(error);
      }
    }
    return { ...result, ...extra };
  });
  registerControlHandler('wp.test', async (job, payload) => testSession(await site(payload.websiteId ?? job.websiteId)));
  registerControlHandler('wp.refresh', async (job, payload) => {
    const s = await site(payload.websiteId ?? job.websiteId);
    const check = await testSession(s);
    if (check.state !== 'ACTIVE') return check;
    return { ...check, editor: await detectEditor(s) };
  });
  registerControlHandler('wp.sync-categories', async (job, payload) => syncCategories(await site(payload.websiteId ?? job.websiteId)));
  registerControlHandler('wp.refresh-link-index', async (job, payload) => refreshLinkIndex(await site(payload.websiteId ?? job.websiteId), { force: true }));
  registerControlHandler('wp.detect-editor', async (job, payload) => ({ editor: await detectEditor(await site(payload.websiteId ?? job.websiteId)) }));
  registerControlHandler('wp.open-browser', async (job, payload, { heartbeat }) => openAdminWindow(await site(payload.websiteId ?? job.websiteId), heartbeat));
  registerControlHandler('wp.reset-session', async (job, payload) => resetSession(await site(payload.websiteId ?? job.websiteId)));
  // Approved publishing path: only READY workflow keywords on sites that allow publishing (see src/wordpress/schedule.ts).
  registerControlHandler('wp.schedule', async (job, payload) => scheduleKeywordPost(String(payload.keywordId ?? job.relatedId)));
  registerControlHandler('wp.verify-published', async (job, payload) => verifyKeywordPublished(String(payload.keywordId ?? job.relatedId)));
  // Content refresh: an owner-approved revision written to the same post (content only; see src/wordpress/refresh-apply.ts).
  registerControlHandler('wp.refresh-apply', async (job, payload) => applyContentRevision(String(payload.revisionId ?? job.relatedId)));
  registerControlHandler('chrome.launch', async () => {
    const result = launchAutomationChrome();
    await log({ category: 'extension', message: `Automation Chrome launched (PID ${result.pid ?? '?'}).` });
    return result;
  });
  // Owner request: sign in to Google (Search Console) in Automation Chrome. Opens Google's sign-in page there (a new
  // window when it is already running); the owner signs in themselves — the app never sees the password.
  // Proof of a Search Console “Request indexing”: the page copy Automation Chrome saved, as a PNG with the article.
  registerControlHandler('gsc.proof', async (_job, payload) => renderGscProof({ jobId: String(payload.jobId), keywordId: String(payload.keywordId), url: String(payload.url) }));
  registerControlHandler('chrome.google-signin', async () => {
    const result = launchAutomationChrome(GOOGLE_SIGNIN_URL, { allowRunning: true });
    await log({ category: 'search', message: 'Google sign-in (Search Console) opened in Automation Chrome.' });
    return result;
  });
  registerControlHandler('wp.delete-profile', async (job, payload) => {
    const s = await site(payload.websiteId ?? job.websiteId);
    const result = await deleteProfile(s);
    await log({ level: 'warn', category: 'wordpress', message: `${s.name}: browser profile folder deleted by the owner.` });
    return result;
  });
}
