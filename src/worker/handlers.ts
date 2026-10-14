import { db } from '@/lib/db';
import { log, errorMessage } from '@/lib/log';
import { registerControlHandler } from './control';
import { deleteProfile, detectEditor, interactiveLogin, openAdminWindow, resetSession, syncCategories, testSession } from '@/wordpress/session';

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
  registerControlHandler('wp.detect-editor', async (job, payload) => ({ editor: await detectEditor(await site(payload.websiteId ?? job.websiteId)) }));
  registerControlHandler('wp.open-browser', async (job, payload, { heartbeat }) => openAdminWindow(await site(payload.websiteId ?? job.websiteId), heartbeat));
  registerControlHandler('wp.reset-session', async (job, payload) => resetSession(await site(payload.websiteId ?? job.websiteId)));
  registerControlHandler('wp.delete-profile', async (job, payload) => {
    const s = await site(payload.websiteId ?? job.websiteId);
    const result = await deleteProfile(s);
    await log({ level: 'warn', category: 'wordpress', message: `${s.name}: browser profile folder deleted by the owner.` });
    return result;
  });
}
