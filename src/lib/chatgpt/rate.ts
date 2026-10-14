import { db, type Tx } from '../db';
import { getSettings, getValue, setValue } from '../settings';
import { scheduleBackoffMs } from '../backoff';

/**
 * Account-level ChatGPT pressure control shared by all tabs (one budget):
 * 429/usage limits step through the backoff schedule, honour Retry-After and
 * halve concurrency; sustained healthy operation slowly restores it.
 */
export interface RateState {
  step: number;
  backoffUntil: string | null;
  last429At: string | null;
  lastSuccessAt: string | null;
  lastIncreaseAt: string | null;
  concurrency: number;
  reason: string | null;
  recent429: string[];
  totalBackoffMs: number;
}

const KEY = 'chatgpt.rate';

export async function getRateState(client: Tx = db): Promise<RateState> {
  const settings = await getSettings(client);
  const base = settings.workflow.highThroughputMode ? settings.workflow.taskConcurrency : 1;
  const stored = await getValue<Partial<RateState>>(KEY, {}, client);
  return {
    step: stored.step ?? 0,
    backoffUntil: stored.backoffUntil ?? null,
    last429At: stored.last429At ?? null,
    lastSuccessAt: stored.lastSuccessAt ?? null,
    lastIncreaseAt: stored.lastIncreaseAt ?? null,
    concurrency: Math.max(1, Math.min(stored.concurrency ?? base, settings.workflow.maxTaskConcurrency)),
    reason: stored.reason ?? null,
    recent429: (stored.recent429 ?? []).slice(-50),
    totalBackoffMs: stored.totalBackoffMs ?? 0,
  };
}

/** Effective number of concurrent ChatGPT/article slots right now. */
export async function allowedSlots(client: Tx = db, now = new Date()): Promise<number> {
  const settings = await getSettings(client);
  if (!settings.workflow.highThroughputMode) return 1;
  const state = await getRateState(client);
  if (!settings.workflow.adaptiveConcurrency) return Math.min(settings.workflow.taskConcurrency, settings.workflow.maxTaskConcurrency);
  if (state.backoffUntil && new Date(state.backoffUntil) > now) return Math.max(1, Math.min(state.concurrency, 1));
  return state.concurrency;
}

export async function inBackoff(client: Tx = db, now = new Date()): Promise<Date | null> {
  const state = await getRateState(client);
  if (state.backoffUntil && new Date(state.backoffUntil) > now) return new Date(state.backoffUntil);
  return null;
}

/** Record a 429 / usage limit. Returns when requests may resume. */
export async function recordRateLimit(options: { retryAfterMs?: number | null; reason: string; usageCap?: boolean }, client: Tx = db, now = new Date()): Promise<Date> {
  const settings = await getSettings(client);
  const state = await getRateState(client);
  const step = Math.min(state.step + 1, settings.advanced.backoffScheduleSec.length - 1);
  const scheduled = scheduleBackoffMs(step, settings.advanced.backoffScheduleSec);
  const wait = Math.max(scheduled, options.retryAfterMs ?? 0, options.usageCap ? 15 * 60_000 : 0);
  const until = new Date(now.getTime() + wait);
  const next: RateState = {
    ...state,
    step,
    backoffUntil: until.toISOString(),
    last429At: now.toISOString(),
    reason: options.reason,
    concurrency: settings.workflow.adaptiveConcurrency ? Math.max(1, Math.floor(state.concurrency / 2)) : state.concurrency,
    recent429: [...state.recent429, now.toISOString()].slice(-50),
    totalBackoffMs: state.totalBackoffMs + wait,
  };
  await setValue(KEY, next, client);
  return until;
}

/** Record a successful ChatGPT completion; slowly restore pressure when healthy. */
export async function recordSuccess(client: Tx = db, now = new Date(), backlog = 0): Promise<void> {
  const settings = await getSettings(client);
  const state = await getRateState(client);
  const cap = Math.min(settings.workflow.maxTaskConcurrency, 5);
  const since429 = state.last429At ? now.getTime() - new Date(state.last429At).getTime() : Infinity;
  const quietSince429 = since429 > 10 * 60_000;
  const quietSinceIncrease = !state.lastIncreaseAt || now.getTime() - new Date(state.lastIncreaseAt).getTime() > 15 * 60_000;
  const next: RateState = { ...state, lastSuccessAt: now.toISOString() };
  if (quietSince429) next.step = Math.max(0, state.step - 1);
  const start = settings.workflow.highThroughputMode ? settings.workflow.taskConcurrency : 1;
  // Above the starting value only after 30 healthy minutes and when work is actually waiting.
  const target = settings.workflow.highThroughputMode && since429 > 30 * 60_000 && backlog > state.concurrency ? cap : start;
  if (settings.workflow.adaptiveConcurrency && quietSince429 && quietSinceIncrease && state.concurrency < Math.max(target, 1) && state.concurrency < cap) {
    next.concurrency = state.concurrency + 1;
    next.lastIncreaseAt = now.toISOString();
  }
  await setValue(KEY, next, client);
}

/** Owner changed concurrency settings: reset the adaptive value to the new start. */
export async function resetConcurrency(client: Tx = db): Promise<void> {
  const settings = await getSettings(client);
  const state = await getRateState(client);
  await setValue(KEY, { ...state, concurrency: settings.workflow.highThroughputMode ? settings.workflow.taskConcurrency : 1 }, client);
}
