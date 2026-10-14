import type { z } from 'zod';

/** Parse a JSON TEXT column; return fallback on malformed/legacy content. */
export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Parse and validate a JSON column with a Zod schema; fallback when invalid. */
export function parseJsonWith<S extends z.ZodType>(schema: S, raw: string | null | undefined, fallback: z.output<S>): z.output<S> {
  const value = parseJson<unknown>(raw, undefined);
  if (value === undefined) return fallback;
  const result = schema.safeParse(value);
  return result.success ? result.data : fallback;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function stringArray(raw: string | null | undefined): string[] {
  const value = parseJson<unknown>(raw, []);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
