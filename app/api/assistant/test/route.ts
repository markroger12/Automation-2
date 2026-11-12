import { route } from '@/lib/api';
import { AppError } from '@/lib/errors';
import { askGemini } from '@/lib/assistant/gemini';
import { assistantApiKey, assistantSettings } from '@/lib/assistant/settings';

/** Settings → Help assistant → Test: one tiny question with the saved key and model. */
export const POST = route({}, async () => {
  const apiKey = assistantApiKey();
  const { model } = assistantSettings();
  if (!apiKey) throw new AppError(409, 'ASSISTANT_NOT_SET_UP', 'Save your Gemini API key first.');
  const started = Date.now();
  await askGemini({ apiKey, model, system: 'Answer with one word.', turns: [{ role: 'user', text: 'Say OK.' }], timeoutMs: 30_000 });
  return { ok: true, model, ms: Date.now() - started };
});
