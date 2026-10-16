import { formFiles, formRoute, route } from '@/lib/api';
import { badRequest } from '@/lib/errors';
import { audit } from '@/lib/audit';
import { forgetKey, saveKey } from '@/lib/gsc/client';

/** Upload the service-account JSON key (stored in data/credentials, never returned or logged). */
export const POST = formRoute({ maxBytes: 64 * 1024 }, async ({ form }) => {
  const [file] = await formFiles(form, 'file', 1);
  if (!file) throw badRequest('Choose the service-account JSON key file.');
  const key = saveKey(file.bytes.toString('utf8'));
  await audit('gsc.key-saved', 'Setting', 'gsc', { email: key.client_email });
  return { connected: true, email: key.client_email, project: key.project_id ?? null };
});

export const DELETE = route({}, async () => {
  forgetKey();
  await audit('gsc.key-removed', 'Setting', 'gsc', {});
  return { connected: false };
});
