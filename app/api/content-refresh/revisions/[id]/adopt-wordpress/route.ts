import { route } from '@/lib/api';
import { AppError } from '@/lib/errors';
import { proposeRevision } from '@/lib/refresh/service';
import { adoptWordPressVersion } from '@/wordpress/refresh-apply';

/** After a conflict: continue from the text that is in WordPress now (the app's text stays in the history). */
export const POST = route({}, async ({ params }) => {
  const adopted = await adoptWordPressVersion(params.id);
  if (!adopted) throw new AppError(409, 'CONFLICT', 'Only a revision stopped by edits made in WordPress can continue from the WordPress version.');
  return adopted.candidateId ? proposeRevision(adopted.candidateId) : { ok: true };
});
