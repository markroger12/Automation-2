import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { createWebsite } from '@/lib/websites';
import { audit } from '@/lib/audit';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { enqueueSiteAction } from '@/lib/site-actions';
import { PASSWORD_MAX, USERNAME_MAX, saveLogin } from '@/lib/wp-credentials';

export const GET = route({}, async () => {
  const sites = await db.website.findMany({
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    include: { wordpressProfile: { select: { sessionState: true, lastCheckedAt: true } }, categories: { select: { id: true, name: true, externalId: true }, orderBy: { name: 'asc' } } },
  });
  return { websites: sites };
});

/** Optional WordPress sign-in given with a new website (owner request: log in automatically). */
const loginSchema = z.object({ username: z.string().trim().min(1, 'Enter the user name or email').max(USERNAME_MAX), password: z.string().min(1, 'Enter the password').max(PASSWORD_MAX) });

export const POST = route({ body: z.record(z.string(), z.unknown()) }, async ({ body }) => {
  // The sign-in is checked before the website exists, and never stored with it (src/lib/wp-credentials.ts).
  const login = body.login === undefined || body.login === null ? null : loginSchema.safeParse(body.login);
  if (login && !login.success) throw new AppError(400, 'VALIDATION', login.error.issues[0].message, Object.fromEntries(login.error.issues.map((i) => [`login.${i.path.join('.')}`, [i.message]])));
  const { login: _omit, ...fields } = body;
  void _omit;
  const site = await createWebsite(fields);
  await audit('website.create', 'Website', site.id, { name: site.name, publicUrl: site.publicUrl, savedLogin: Boolean(login) });
  if (login?.success) {
    saveLogin(site.id, login.data.username, login.data.password);
    await enqueueSiteAction(site.id, 'login');
  }
  return { website: site, loginQueued: Boolean(login?.success) };
});
