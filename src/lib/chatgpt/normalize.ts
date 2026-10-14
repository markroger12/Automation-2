import { createHash } from 'node:crypto';

/**
 * Normalize a ChatGPT answer into the user-facing body: strip chatbot
 * preambles, UI citation tokens, writing-block wrappers and control markers,
 * while keeping Markdown headings, tables, links and facts intact.
 */

const PREAMBLE_PATTERNS: RegExp[] = [
  /^(?:sure|certainly|of course|absolutely|great|okay|ok)[!,.]?\s[^\n]{0,160}(?:\n|$)/i,
  /^here(?:'s| is| are)\b[^\n]{0,180}:\s*(?:\n|$)/i,
  /^below (?:is|are)\b[^\n]{0,180}:\s*(?:\n|$)/i,
  /^(?:gerne|natürlich|selbstverständlich|klar)[!,.]?\s[^\n]{0,160}(?:\n|$)/i,
  /^hier (?:ist|sind)\b[^\n]{0,180}:\s*(?:\n|$)/i,
];

const TRAILER_PATTERNS: RegExp[] = [
  /\n+(?:let me know|would you like|if you(?:'d| would) like|i hope this|feel free to|do you want)[^\n]*$/i,
  /\n+(?:möchtest du|soll ich|wenn du möchtest|lass mich wissen)[^\n]*$/i,
];

export function normalizeResponseText(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').replace(/ /g, ' ');
  // UI-only citation tokens and private-use markers (e.g. "citeturn0search1", "【4:0†source】").
  text = text.replace(/[^]*/g, '');
  text = text.replace(/[-]/g, '');
  text = text.replace(/\bcite(?:turn\d+(?:search|news|view|fetch|file)\d+)+/g, '');
  text = text.replace(/【[^】]{0,40}†[^】]{0,40}】/g, '');
  // Writing-block / canvas wrappers.
  text = text.replace(/^:{3}writing\b[^\n]*\n([\s\S]*?)\n:{3}\s*$/gm, '$1');
  text = text.replace(/<\/?(?:writing-block|canvas|artifact)[^>]*>/gi, '');
  // Whole answer wrapped in a single code fence.
  const fenced = text.trim().match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fenced) text = fenced[1];
  text = text.trim();
  for (let i = 0; i < 2; i++) {
    for (const re of PREAMBLE_PATTERNS) text = text.replace(re, '').trimStart();
  }
  for (const re of TRAILER_PATTERNS) text = text.replace(re, '');
  return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Normalized prompt hash used to recognise an already-submitted prompt. */
export function promptFingerprint(prompt: string): string {
  return sha256(prompt.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim());
}

export function responseFingerprint(text: string): string {
  return sha256(text.replace(/\s+/g, ' ').trim());
}
