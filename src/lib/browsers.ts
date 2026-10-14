import fs from 'node:fs';
import path from 'node:path';

export interface DetectedBrowser {
  name: 'Google Chrome' | 'Microsoft Edge' | 'Chromium';
  channel: 'chrome' | 'msedge' | 'chromium';
  path: string;
}

/** Locate installed Chrome/Edge (Windows first, then macOS/Linux). */
export function detectBrowsers(): DetectedBrowser[] {
  const env = process.env;
  const candidates: DetectedBrowser[] = [];
  const add = (name: DetectedBrowser['name'], channel: DetectedBrowser['channel'], p: string | undefined) => {
    if (p && !candidates.some((c) => c.path === p)) candidates.push({ name, channel, path: p });
  };
  if (process.platform === 'win32') {
    for (const base of [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']]) {
      if (!base) continue;
      add('Google Chrome', 'chrome', path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      add('Microsoft Edge', 'msedge', path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    add('Google Chrome', 'chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    add('Microsoft Edge', 'msedge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    add('Google Chrome', 'chrome', '/usr/bin/google-chrome');
    add('Google Chrome', 'chrome', '/opt/google/chrome/chrome');
    add('Microsoft Edge', 'msedge', '/usr/bin/microsoft-edge');
    add('Chromium', 'chromium', '/usr/bin/chromium');
  }
  const explicit = env.BROWSER_EXECUTABLE_PATH?.trim();
  const found = candidates.filter((c) => {
    try {
      return fs.statSync(c.path).isFile();
    } catch {
      return false;
    }
  });
  if (explicit) {
    try {
      if (fs.statSync(explicit).isFile()) found.unshift({ name: 'Chromium', channel: 'chromium', path: explicit });
    } catch {
      /* ignored; reported by diagnostics */
    }
  }
  return found;
}

/** Path to Chrome for the visible Automation Chrome (ChatGPT) profile. */
export function chromeExecutable(): string | null {
  const explicit = process.env.BROWSER_EXECUTABLE_PATH?.trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  const browsers = detectBrowsers();
  return (browsers.find((b) => b.channel === 'chrome') ?? browsers[0])?.path ?? null;
}
