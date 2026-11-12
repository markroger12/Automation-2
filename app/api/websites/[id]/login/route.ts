import { z } from 'zod';
import { route } from '@/lib/api';
import { audit } from '@/lib/audit';
import { db } from '@/lib/db';
import { notFound } from '@/lib/errors';
import { enqueueSiteAction } from '@/lib/site-actions';
import { PASSWORD_MAX, USERNAME_MAX, deleteLogin, saveLogin, savedLogin } from '@/lib/wp-credentials';

/**
 * The website's saved WordPress sign-in (owner request: automatic login). GET says whether one is saved, for which
 * user and how the last automatic login went — never the password. PUT saves or replaces it and logs in; DELETE
 * removes it.
 */
async function site(id: string) {
  const s = await db.website.findUnique({ where: { id }, select: { id: true } });
  if (!s) throw notFound('Website');
  return s;
}

export const GET = route({}, async ({ params }) => ({ login: savedLogin((await site(params.id)).id) }));

export const PUT = route(
  { body: z.object({ username: z.string().trim().min(1, 'Enter the user name or email').max(USERNAME_MAX), password: z.string().min(1, 'Enter the password').max(PASSWORD_MAX), logIn: z.boolean().default(true) }) },
  async ({ params, body }) => {
    const s = await site(params.id);
    const login = saveLogin(s.id, body.username, body.password);
    await audit('website.login.saved', 'Website', s.id, { username: login.username });
    const queued = body.logIn ? await enqueueSiteAction(s.id, 'login') : null;
    return { login, jobId: queued?.jobId ?? null };
  },
);

export const DELETE = route({}, async ({ params }) => {
  const s = await site(params.id);
  const removed = deleteLogin(s.id);
  if (removed) await audit('website.login.removed', 'Website', s.id, {});
  return { removed };
});
