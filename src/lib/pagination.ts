/** Pages of a long list (owner request: no long scrolling). Pages count from 1. */
export const PAGE_SIZES = [10, 20, 30, 40, 50] as const;

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

/** The page to show: a page past the end (after a filter or a delete) shows the last one. */
export function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(Math.max(1, Math.floor(page) || 1), pageCount(total, pageSize));
}

export function pageSlice<T>(rows: T[], page: number, pageSize: number): T[] {
  const p = clampPage(page, rows.length, pageSize);
  return rows.slice((p - 1) * pageSize, p * pageSize);
}
