import { z } from 'zod';
import { route } from '@/lib/api';
import { AppError } from '@/lib/errors';
import { log } from '@/lib/log';
import { askGemini } from '@/lib/assistant/gemini';
import { ASSISTANT_SYSTEM, appContext } from '@/lib/assistant/context';
import { assistantApiKey, assistantSettings } from '@/lib/assistant/settings';

const body = z.object({
  question: z.string().trim().min(1, 'Type a question.').max(2000, 'Keep the question under 2,000 characters.'),
  history: z
    .array(z.object({ role: z.enum(['user', 'model']), text: z.string().max(6000) }))
    .max(12)
    .default([]),
});

/** What the assistant would send with a question, for the panel's “Details sent with your question”. */
export const GET = route({}, async () => ({ settings: assistantSettings(), context: await appContext() }));

/**
 * Ask the help assistant (owner request 2026-11-12). The question goes to Gemini with the owner's key, together with
 * the app's current state (appContext: states, counts and short messages; no passwords, keys or article texts).
 */
export const POST = route({ body }, async ({ body }) => {
  const apiKey = assistantApiKey();
  const { model } = assistantSettings();
  if (!apiKey) throw new AppError(409, 'ASSISTANT_NOT_SET_UP', 'Add your Gemini API key in Settings → Help assistant first.');
  const context = await appContext();
  const started = Date.now();
  const answer = await askGemini({
    apiKey,
    model,
    system: `${ASSISTANT_SYSTEM}\n\nThe app right now:\n${context}`,
    turns: [...body.history.slice(-10), { role: 'user', text: body.question }],
  });
  await log({ category: 'assistant', message: `Help assistant answered in ${((Date.now() - started) / 1000).toFixed(1)} s (${model}).` });
  return { answer, model, context };
});
