/**
 * Publishing-slot time math (client-safe, pure). Slots are entered as
 * "h:mm AM/PM" in an IANA time zone (Asia/Karachi by default) and stored as
 * UTC instants. Conversions use Intl time-zone data, so DST changes in any
 * zone are handled: a wall time that does not exist (spring forward) moves
 * forward by the gap; an ambiguous one (fall back) uses the earlier instant.
 */

export const DEFAULT_SLOT_TIMEZONE = 'Asia/Karachi';

export function parseSlot(slot: string): { hour: number; minute: number } | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])\s*$/.exec(slot);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const pm = m[3].toLowerCase() === 'pm';
  if (hour === 12) hour = pm ? 12 : 0;
  else if (pm) hour += 12;
  return { hour, minute };
}

export function formatSlot(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(instant: Date, tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

/** Wall-clock date/time parts of an instant in a zone (weekday 0 = Sunday). */
export function zonedParts(instant: Date, tz: string) {
  return parts(instant, tz);
}

/** Offset (ms) of the zone from UTC at an instant. */
function offsetAt(instant: Date, tz: string): number {
  const p = parts(instant, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant.getTime() / 1000) * 1000;
}

/** UTC instant of a wall-clock time in a zone (DST-safe, see module comment). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  // Candidates from the offsets around that time; pick the earliest that maps back to the wall time.
  const offsets = [...new Set([offsetAt(new Date(naive - 36e5 * 12), tz), offsetAt(new Date(naive), tz), offsetAt(new Date(naive + 36e5 * 12), tz)])];
  const matches = offsets
    .map((o) => new Date(naive - o))
    .filter((d) => {
      const p = parts(d, tz);
      return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
    })
    .sort((a, b) => a.getTime() - b.getTime());
  if (matches.length) return matches[0];
  // Nonexistent wall time (spring forward): use the instant after the gap with the later offset.
  const later = Math.min(...offsets);
  return new Date(naive - later);
}

export interface SlotRules {
  slots: string[];
  /** Weekdays in the slot zone; empty = every day (0 = Sunday). */
  weekdays: number[];
  timezone: string;
}

/** Upcoming slot instants from `from` (inclusive) over `days` local days, sorted, de-duplicated. */
export function upcomingSlots(rules: SlotRules, from: Date, days = 14): Date[] {
  const parsed = rules.slots.map(parseSlot).filter((x): x is { hour: number; minute: number } => Boolean(x));
  if (!parsed.length) return [];
  const start = parts(from, rules.timezone);
  const out = new Map<number, Date>();
  for (let i = 0; i <= days; i++) {
    // Walk local calendar days via a UTC-noon anchor (immune to DST).
    const anchor = new Date(Date.UTC(start.year, start.month - 1, start.day + i, 12));
    const y = anchor.getUTCFullYear();
    const m = anchor.getUTCMonth() + 1;
    const d = anchor.getUTCDate();
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (rules.weekdays.length && !rules.weekdays.includes(weekday)) continue;
    for (const s of parsed) {
      const at = zonedTimeToUtc(y, m, d, s.hour, s.minute, rules.timezone);
      if (at.getTime() >= from.getTime()) out.set(at.getTime(), at);
    }
  }
  return [...out.values()].sort((a, b) => a.getTime() - b.getTime());
}

/** "Mon 14 Oct, 9:00 AM" in a zone. */
export function formatInZone(instant: Date | string, tz: string, locale = 'en-GB'): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(instant));
}
