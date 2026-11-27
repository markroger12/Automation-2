import { z } from 'zod';
import { route } from '@/lib/api';
import { audit } from '@/lib/audit';
import { assistantSettings, removeAssistantKey, saveAssistantSettings } from '@/lib/assistant/settings';

/** Settings → Help assistant. The key is write-only: answers carry whether one is saved and its last 4 characters. */
export const GET = route({}, async () => assistantSettings());

export const PUT = route(
  { body: z.object({ apiKey: z.string().max(300).optional(), model: z.string().max(80).optional(), remove: z.boolean().optional() }) },
  async ({ body }) => {
    if (body.remove) {
      const s = removeAssistantKey();
      await audit('assistant.key.remove', 'Setting', 'assistant', {});
      return s;
    }
    const s = saveAssistantSettings({ apiKey: body.apiKey, model: body.model });
    await audit(body.apiKey?.trim() ? 'assistant.key.save' : 'assistant.model.save', 'Setting', 'assistant', { model: s.model });
    return s;
  },
);
