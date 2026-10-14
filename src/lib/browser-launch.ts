import type { LaunchOptions } from 'playwright';

/**
 * Browser selection for WordPress automation, previews and tests.
 * Default: installed Google Chrome (channel "chrome"). Edge (msedge) or a
 * Chromium executable are explicit fallbacks via .env.
 */
export function browserLaunchBase(): Pick<LaunchOptions, 'channel' | 'executablePath'> {
  const executablePath = process.env.BROWSER_EXECUTABLE_PATH?.trim();
  if (executablePath) return { executablePath };
  const channel = (process.env.BROWSER_CHANNEL?.trim() || 'chrome').toLowerCase();
  if (channel === 'chromium') return {};
  if (channel === 'msedge' || channel === 'chrome') return { channel };
  return { channel: 'chrome' };
}

export function describeBrowserChoice(): string {
  const base = browserLaunchBase();
  return base.executablePath ? `executable ${base.executablePath}` : `channel ${base.channel ?? 'chromium (bundled)'}`;
}
