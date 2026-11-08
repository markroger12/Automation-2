import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { deleteLogin, loginFor, recordLoginResult, saveLogin, savedLogin } from '@/lib/wp-credentials';

/** Owner request: the WordPress password with the website, for automatic login — encrypted, never shown again. */
describe('saved WordPress sign-ins (data/credentials)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bas-wp-cred-'));
    process.env.BAS_DATA_DIR = dir;
  });

  it('keeps the password encrypted, bound to its website, and gives the dashboard only the user name', () => {
    saveLogin('site-a', ' admin ', 'pä$$wörd with spaces', new Date('2026-10-30T10:00:00Z'));
    const file = fs.readFileSync(path.join(dir, 'credentials', 'wordpress-logins.json'), 'utf8');
    expect(file).not.toContain('pä$$wörd');
    expect(file).not.toContain('with spaces');
    expect(savedLogin('site-a')).toEqual({ username: 'admin', savedAt: '2026-10-30T10:00:00.000Z', last: null });
    expect(JSON.stringify(savedLogin('site-a'))).not.toContain('pä$$wörd');
    expect(loginFor('site-a')).toEqual({ username: 'admin', password: 'pä$$wörd with spaces' });
    // Files only the owner's account can read.
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dir, 'credentials', 'wordpress-logins.json')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(dir, 'credentials', 'wordpress-logins.key')).mode & 0o777).toBe(0o600);
    }
    // An entry copied to another website does not decrypt there.
    const all = JSON.parse(file);
    all['site-b'] = all['site-a'];
    fs.writeFileSync(path.join(dir, 'credentials', 'wordpress-logins.json'), JSON.stringify(all));
    expect(loginFor('site-b')).toBeNull();
    // Another key (another data folder) cannot read it either.
    fs.writeFileSync(path.join(dir, 'credentials', 'wordpress-logins.key'), Buffer.alloc(32, 7));
    expect(loginFor('site-a')).toBeNull();
  });

  it('records the last automatic login; saving again starts fresh; removing forgets it', () => {
    saveLogin('site-a', 'admin', 'one');
    recordLoginResult('site-a', { ok: false, refused: true, detail: 'WordPress refused the saved sign-in.' }, new Date('2026-10-30T11:00:00Z'));
    expect(savedLogin('site-a')?.last).toEqual({ at: '2026-10-30T11:00:00.000Z', ok: false, refused: true, detail: 'WordPress refused the saved sign-in.' });
    saveLogin('site-a', 'admin', 'two');
    expect(savedLogin('site-a')?.last).toBeNull();
    expect(loginFor('site-a')?.password).toBe('two');
    expect(deleteLogin('site-a')).toBe(true);
    expect(savedLogin('site-a')).toBeNull();
    expect(deleteLogin('site-a')).toBe(false);
  });

  it('refuses an empty or oversized user name or password', () => {
    expect(() => saveLogin('site-a', '  ', 'x')).toThrow(/user name/);
    expect(() => saveLogin('site-a', 'admin', '')).toThrow(/password/);
    expect(() => saveLogin('site-a', 'admin', 'x'.repeat(301))).toThrow(/password/);
  });
});
