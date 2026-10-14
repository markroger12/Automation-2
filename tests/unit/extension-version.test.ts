import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPECTED_EXTENSION_VERSION } from '@/lib/agent/version';

const ext = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', 'extension', f), 'utf8');

describe('extension version constants', () => {
  it('manifest, background, content and server expectation all match', () => {
    const manifest = JSON.parse(ext('manifest.json')) as { version: string };
    const bg = /const EXTENSION_VERSION = '([^']+)'/.exec(ext('background.js'))?.[1];
    const content = /const EXTENSION_VERSION = '([^']+)'/.exec(ext('content.js'))?.[1];
    expect(bg).toBe(manifest.version);
    expect(content).toBe(manifest.version);
    expect(EXPECTED_EXTENSION_VERSION).toBe(manifest.version);
  });

  it('requests only narrow permissions (no blanket https://*/*)', () => {
    const manifest = JSON.parse(ext('manifest.json')) as { permissions: string[]; host_permissions: string[] };
    expect(manifest.permissions.sort()).toEqual(['alarms', 'notifications', 'storage', 'tabs']);
    expect(manifest.host_permissions).not.toContain('https://*/*');
    expect(manifest.host_permissions).not.toContain('<all_urls>');
    expect(manifest.host_permissions.every((h) => h.startsWith('https://chatgpt.com/') || h.startsWith('http://localhost/') || h.startsWith('http://127.0.0.1/'))).toBe(true);
  });
});
