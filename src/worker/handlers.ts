import { db } from '@/lib/db';
import { log, errorMessage } from '@/lib/log';
import { registerControlHandler } from './control';
import { launchAutomationChrome } from '@/lib/automation-chrome';
import { deleteProfile, detectEditor, interactiveLogin, openAdminWindow, resetSession, syncCategories, testSession } from '@/wordpress/session';
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
    const result = await interactiveLogin(s, heartbeat);
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
  registerControlHandler('wp.delete-profile', async (job, payload) => {
    const s = await site(payload.websiteId ?? job.websiteId);
    const result = await deleteProfile(s);
    await log({ level: 'warn', category: 'wordpress', message: `${s.name}: browser profile folder deleted by the owner.` });
    return result;
  });
}
