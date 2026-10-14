import fs from 'node:fs';

/**
 * Point Playwright at a local Chromium for tests. Uses BROWSER_EXECUTABLE_PATH
 * when set, otherwise the container's bundled Chromium, otherwise installed
 * Chrome (channel "chrome"). Without a display, "visible" windows run headless.
 */
export function configureTestBrowser(): void {
  const bundled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  if (!process.env.BROWSER_EXECUTABLE_PATH && fs.existsSync(bundled)) process.env.BROWSER_EXECUTABLE_PATH = bundled;
  if (process.platform === 'linux' && !process.env.DISPLAY) process.env.BAS_FORCE_HEADLESS = '1';
}
