import fs from 'node:fs';

/**
 * Point Playwright at a local Chromium for tests. Uses BROWSER_EXECUTABLE_PATH
 * when set, otherwise the container's bundled Chromium, otherwise installed
 * Chrome (channel "chrome"). Without a display, "visible" windows run headless.
 * (A launch that fails for a missing browser leaves a playwright-artifacts-*
 * folder in the temp directory.)
 */
export function configureTestBrowser(): void {
  const bundled = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((p) => fs.existsSync(p));
  if (!process.env.BROWSER_EXECUTABLE_PATH && bundled) process.env.BROWSER_EXECUTABLE_PATH = bundled;
  if (process.platform === 'linux' && !process.env.DISPLAY) process.env.BAS_FORCE_HEADLESS = '1';
}
