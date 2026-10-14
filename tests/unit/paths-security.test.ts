import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isValidSlug, resolveDatabaseUrl, safeJoin, slugify } from '@/lib/paths';
import { checkDashboardRequest, isLoopbackHost, isSameLoopbackOrigin } from '@/lib/security';
import { redact, redactString } from '@/lib/redact';

describe('paths', () => {
  it('slugifies German and Unicode names into safe profile slugs', () => {
    expect(slugify('Über Größe & Co. Blog')).toBe('uber-grosse-co-blog');
    expect(isValidSlug(slugify('   '))).toBe(true);
    expect(isValidSlug('../evil')).toBe(false);
  });

  it('refuses path traversal and absolute segments', () => {
    const base = path.resolve('/tmp/base');
    expect(safeJoin(base, 'a', 'b.png')).toBe(path.join(base, 'a', 'b.png'));
    expect(() => safeJoin(base, '..', 'x')).toThrow();
    expect(() => safeJoin(base, '/etc/passwd')).toThrow();
    expect(() => safeJoin(base, 'C:\\Windows')).toThrow();
  });

  it('resolves the relative SQLite URL against prisma/ and keeps forward slashes', () => {
    const saved = process.env.BAS_DATA_DIR;
    try {
      delete process.env.BAS_DATA_DIR;
      const url = resolveDatabaseUrl('file:../data/app.db');
      expect(url.startsWith('file:')).toBe(true);
      expect(url).toContain('/data/app.db?');
      expect(url).toContain('socket_timeout=');
      // BAS_DATA_DIR moves the database too, unless DATABASE_URL was customized.
      const elsewhere = path.resolve(os.tmpdir(), 'bas-elsewhere');
      const fwd = (p: string) => p.split(path.sep).join('/');
      process.env.BAS_DATA_DIR = elsewhere;
      expect(resolveDatabaseUrl('file:../data/app.db')).toContain(`file:${fwd(path.join(elsewhere, 'app.db'))}?`);
      expect(resolveDatabaseUrl('')).toContain(`file:${fwd(path.join(elsewhere, 'app.db'))}?`);
      const custom = fwd(path.resolve(os.tmpdir(), 'custom', 'my.db'));
      expect(resolveDatabaseUrl(`file:${custom}`)).toContain(`file:${custom}?`);
    } finally {
      if (saved === undefined) delete process.env.BAS_DATA_DIR;
      else process.env.BAS_DATA_DIR = saved;
    }
    expect(() => resolveDatabaseUrl('postgres://x')).toThrow();
  });
});

describe('security (login-free localhost dashboard)', () => {
  it('accepts only loopback hosts', () => {
    expect(isLoopbackHost('localhost:3000')).toBe(true);
    expect(isLoopbackHost('127.0.0.1:3000')).toBe(true);
    expect(isLoopbackHost('[::1]:3000')).toBe(true);
    expect(isLoopbackHost('evil.example:3000')).toBe(false);
    expect(isLoopbackHost('localhost.evil.example')).toBe(false);
  });

  it('requires matching origin', () => {
    expect(isSameLoopbackOrigin('http://localhost:3000', 'localhost:3000')).toBe(true);
    expect(isSameLoopbackOrigin('http://evil.example', 'localhost:3000')).toBe(false);
    expect(isSameLoopbackOrigin('http://localhost:4000', 'localhost:3000')).toBe(false);
  });

  it('blocks cross-site and missing-CSRF mutations, allows same-origin with token', () => {
    const base = { host: 'localhost:3000' };
    const get = new Request('http://localhost:3000/api/x', { headers: base });
    expect(checkDashboardRequest(get).ok).toBe(true);
    const crossSite = new Request('http://localhost:3000/api/x', { method: 'POST', headers: { ...base, origin: 'https://evil.example', cookie: 'bas_csrf=abc', 'x-csrf-token': 'abc' } });
    expect(checkDashboardRequest(crossSite).ok).toBe(false);
    const noToken = new Request('http://localhost:3000/api/x', { method: 'POST', headers: { ...base, origin: 'http://localhost:3000', cookie: 'bas_csrf=abc' } });
    expect(checkDashboardRequest(noToken).ok).toBe(false);
    const ok = new Request('http://localhost:3000/api/x', { method: 'POST', headers: { ...base, origin: 'http://localhost:3000', cookie: 'bas_csrf=abc123', 'x-csrf-token': 'abc123' } });
    expect(checkDashboardRequest(ok).ok).toBe(true);
    const rebinding = new Request('http://evil.example:3000/api/x', { headers: { host: 'evil.example:3000' } });
    expect(checkDashboardRequest(rebinding).ok).toBe(false);
  });
});

describe('redaction', () => {
  it('removes connection keys, bearer tokens, cookies and passwords', () => {
    const s = redactString('Authorization: Bearer abcdefghijklmnop bas_ABCDEFGHIJKLMNOPQRSTUV password=hunter2 wordpress_logged_in_abc123=secretvalue');
    expect(s).not.toContain('abcdefghijklmnop');
    expect(s).not.toContain('ABCDEFGHIJKLMNOPQRSTUV');
    expect(s).not.toContain('hunter2');
    expect(s).not.toContain('secretvalue');
    const o = redact({ cookie: 'x=1', nested: { password: 'p', ok: 'fine' } });
    expect(o.cookie).toBe('[REDACTED]');
    expect(o.nested.password).toBe('[REDACTED]');
    expect(o.nested.ok).toBe('fine');
  });
});
