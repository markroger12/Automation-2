import { describe, expect, it } from 'vitest';
import { changeKinds, parseLog, updateBlocker } from '@/lib/update/service';
// @ts-expect-error plain Node.js script without types (scripts/start-all.mjs)
import { UPDATE_STEPS, escapeHtml, interrupted, loopbackHost, packagesChanged, stripAnsi } from '../../scripts/start-all.mjs';

/** Owner request: one click in Settings instead of git pull, npm run start:all and reloading the extension by hand. */
describe('app update: what GitHub has and whether the button may start it', () => {
  it('reads git log lines (subjects may hold any character)', () => {
    const sep = '\x1f';
    expect(parseLog(`abc${sep}2026-10-30T16:00:00+05:00${sep}Fix: a | b — “c”\ndef${sep}2026-10-29T10:00:00+05:00${sep}Second`)).toEqual([
      { sha: 'abc', date: '2026-10-30T16:00:00+05:00', subject: 'Fix: a | b — “c”' },
      { sha: 'def', date: '2026-10-29T10:00:00+05:00', subject: 'Second' },
    ]);
    expect(parseLog('')).toEqual([]);
  });

  it('names what an update changes: packages, the extension, the database', () => {
    expect(changeKinds(['app/page.tsx', 'package-lock.json', 'extension/content.js', 'prisma/migrations/20261030_x/migration.sql'])).toEqual({ packages: true, extension: true, database: true, files: 4 });
    expect(changeKinds(['src/lib/a.ts', 'prisma/schema.prisma'])).toEqual({ packages: false, extension: false, database: false, files: 2 });
  });

  it('starts only when a plain fast-forward is possible, and says why not in plain words', () => {
    const ok = { supervised: true, desktop: false, behind: 3, ahead: 0, localChanges: [] as string[], updating: false };
    expect(updateBlocker(ok)).toBeNull();
    expect(updateBlocker({ ...ok, behind: 0 })).toBeNull();
    expect(updateBlocker({ ...ok, supervised: false })).toMatch(/npm run start:all/);
    expect(updateBlocker({ ...ok, desktop: true })).toMatch(/installer/);
    expect(updateBlocker({ ...ok, updating: true })).toMatch(/running/);
    expect(updateBlocker({ ...ok, ahead: 2 })).toMatch(/2 changes .* GitHub does not have/);
    // The owner's own edits are never overwritten.
    expect(updateBlocker({ ...ok, localChanges: ['src/lib/a.ts'] })).toMatch(/1 file was changed on this computer; the update would overwrite it/);
  });
});

describe('npm run start:all (scripts/start-all.mjs)', () => {
  it('has the update steps in order and installs packages only when they changed', () => {
    expect(UPDATE_STEPS.map((s: { key: string }) => s.key)).toEqual(['stop', 'code', 'install', 'build', 'prepare', 'start']);
    expect(packagesChanged(['package.json'])).toBe(true);
    expect(packagesChanged(['package-lock.json', 'src/a.ts'])).toBe(true);
    expect(packagesChanged(['src/package.json.ts', 'app/page.tsx'])).toBe(false);
  });

  it('marks an update that a closed window interrupted as failed, with its running step', () => {
    const running = { state: 'running', error: null, steps: [{ key: 'stop', state: 'done' }, { key: 'build', state: 'running' }, { key: 'start', state: 'waiting' }] };
    const after = interrupted(running, new Date('2026-10-30T12:00:00Z'));
    expect(after.state).toBe('failed');
    expect(after.finishedAt).toBe('2026-10-30T12:00:00.000Z');
    expect(after.error).toMatch(/interrupted/);
    expect(after.steps.map((s: { state: string }) => s.state)).toEqual(['done', 'failed', 'waiting']);
    const done = { state: 'done', steps: [] };
    expect(interrupted(done)).toBe(done);
    expect(interrupted(null)).toBeNull();
  });

  it('answers only requests addressed to this computer; the log has no terminal colours; the page escapes text', () => {
    expect(loopbackHost('localhost:3000')).toBe(true);
    expect(loopbackHost('127.0.0.1:3000')).toBe(true);
    expect(loopbackHost('[::1]:3000')).toBe(true);
    expect(loopbackHost('evil.example:3000')).toBe(false);
    expect(loopbackHost('localhost.evil.example')).toBe(false);
    expect(loopbackHost(undefined)).toBe(false);
    expect(stripAnsi('\x1b[32m✓\x1b[39m Compiled \x1b[1msuccessfully\x1b[22m')).toBe('✓ Compiled successfully');
    expect(escapeHtml('<b>"x" & \'y\'</b>')).toBe('&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
  });
});
