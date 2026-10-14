/**
 * Remove secrets before anything is logged, shown in diagnostics or exported.
 * Session cookies, bearer tokens, connection keys, JWTs and passwords are never
 * written to logs.
 */
const PATTERNS: [RegExp, string][] = [
  [/\bbas_[A-Za-z0-9_-]{16,}\b/g, 'bas_[REDACTED]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  [/((?:cookie|set-cookie)\s*[:=]\s*)[^\n]+/gi, '$1[REDACTED]'],
  [/((?:password|passwd|pwd|secret|token|api[_-]?key|session[_-]?secret|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1[REDACTED]'],
  [/(wordpress_logged_in_[a-f0-9]+=)[^;\s]+/gi, '$1[REDACTED]'],
  [/(__Secure-next-auth\.session-token=)[^;\s]+/gi, '$1[REDACTED]'],
  [/([?&](?:_wpnonce|nonce|token|key|access_token)=)[^&\s#]+/gi, '$1[REDACTED]'],
];

const SENSITIVE_KEYS = /^(password|passwd|pwd|secret|token|apikey|api_key|authorization|cookie|cookies|set-cookie|sessionsecret|session_secret|key|connectionkey|nonce|_wpnonce|passwordhash)$/i;

export function redactString(input: string): string {
  let out = input;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return '[TRUNCATED]' as unknown as T;
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value instanceof Date) return value;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.test(key) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
