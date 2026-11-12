import { AppError } from '../errors';

/**
 * One request to Google's Gemini API (generateContent) with the owner's own key. The key goes in the
 * `x-goog-api-key` header, never in the address, so it cannot end up in a log of URLs. Nothing is retried blindly:
 * a refused key or a used-up free quota is said in plain words.
 */
export interface GeminiTurn {
  role: 'user' | 'model';
  text: string;
}

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export async function askGemini(opts: { apiKey: string; model: string; system: string; turns: GeminiTurn[]; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  let res: Response;
  try {
    res = await doFetch(`${ENDPOINT}/${encodeURIComponent(opts.model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.system }] },
        contents: opts.turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
        generationConfig: { temperature: 0.3, maxOutputTokens: 1200 },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new AppError(502, 'ASSISTANT_OFFLINE', (error as Error).name === 'AbortError' ? 'Gemini did not answer within a minute. Try again.' : 'Gemini could not be reached. Check the internet connection and try again.');
  } finally {
    clearTimeout(timer);
  }
  const body = (await res.json().catch(() => null)) as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; error?: { message?: string; status?: string } } | null;
  if (!res.ok) {
    const status = body?.error?.status ?? '';
    if (res.status === 400 && /API_KEY|api key/i.test(`${status} ${body?.error?.message ?? ''}`)) throw new AppError(400, 'ASSISTANT_KEY', 'Google refused the API key. Check it in Settings → Help assistant (make a new one at aistudio.google.com if needed).');
    if (res.status === 403) throw new AppError(403, 'ASSISTANT_KEY', 'This API key may not use Gemini. Check it in Settings → Help assistant.');
    if (res.status === 404) throw new AppError(404, 'ASSISTANT_MODEL', `Google does not know the model “${opts.model}”. Choose another model in Settings → Help assistant.`);
    if (res.status === 429) throw new AppError(429, 'ASSISTANT_QUOTA', 'The free Gemini quota for now is used up. Try again later (it renews by itself).');
    throw new AppError(502, 'ASSISTANT_ERROR', `Gemini answered with an error (${res.status}${body?.error?.message ? `: ${body.error.message.slice(0, 200)}` : ''}).`);
  }
  const text = (body?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
  if (!text) throw new AppError(502, 'ASSISTANT_EMPTY', body?.candidates?.[0]?.finishReason === 'SAFETY' ? 'Gemini did not answer this question. Ask it another way.' : 'Gemini sent an empty answer. Try again.');
  return text;
}
