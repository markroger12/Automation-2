/** Removes tracking parameters (ChatGPT adds `utm_source=chatgpt.com` to every cited link). */
export function stripTracking(url: string): string {
  if (!/[?&]utm_/i.test(url)) return url;
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) if (/^utm_/i.test(key)) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return url;
  }
}
