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
    // pageCapture: the proof copy of the Search Console page after “Request indexing” (owner request).
    expect(manifest.permissions.sort()).toEqual(['alarms', 'notifications', 'pageCapture', 'storage', 'tabs']);
    expect(manifest.host_permissions).not.toContain('https://*/*');
    expect(manifest.host_permissions).not.toContain('<all_urls>');
    // ChatGPT, its two generated-image CDNs (image capture, M8), the two hosts of its image-search gallery
    // (celebrity photos, as in the owner's earlier tool), Search Console (URL Inspection → Request indexing, owner
    // request) and the local app — nothing else.
    const allowed = ['https://chatgpt.com/*', 'https://*.oaiusercontent.com/*', 'https://oaidalleapiprodscus.blob.core.windows.net/*', 'https://images.openai.com/*', 'https://*.mm.bing.net/*', 'https://search.google.com/*', 'http://localhost/*', 'http://127.0.0.1/*'];
    expect(manifest.host_permissions.filter((h) => !allowed.includes(h))).toEqual([]);
  });
});
