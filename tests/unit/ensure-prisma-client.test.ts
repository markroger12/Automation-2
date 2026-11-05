import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain Node.js script without types (scripts/ensure-prisma-client.mjs)
import { clientMatchesSchema, schemaHash } from '../../scripts/ensure-prisma-client.mjs';

/**
 * Owner report (2026-11-05): an update stopped by a full disk left the Prisma client of the previous version, and
 * `next build` failed (“Parameter 'c' implicitly has an 'any' type”). The client's schema copy already matched there
 * (a `prisma generate` that stopped half-way), so the check also needs the stamp a finished generate writes.
 */
describe('the Prisma client is made again unless a generate of this schema finished', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bas-client-'));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };

  it('needs the schema copy and the stamp of a finished generate (Windows line ends ignored)', () => {
    write('prisma/schema.prisma', 'model A {\n  id String @id\n}\n');
    write('node_modules/.prisma/client/schema.prisma', 'model A {\r\n  id String @id\r\n}\r\n');
    // The owner's case: the schema copy is the new one, but no finished generate stamped it.
    expect(clientMatchesSchema(dir)).toBe(false);
    write('node_modules/.prisma/client/bas-schema.sha256', `${schemaHash(dir)}\n`);
    expect(clientMatchesSchema(dir)).toBe(true);
    // The schema changed (git pull, an update): generate again.
    write('prisma/schema.prisma', 'model A {\n  id String @id\n}\n\nmodel CustomWriter {\n  id String @id\n}\n');
    expect(clientMatchesSchema(dir)).toBe(false);
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true });
    expect(clientMatchesSchema(dir)).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });

  it('runs before start:all, dev:all and setup, and in the update’s build step', () => {
    const repo = path.resolve(__dirname, '..', '..');
    const scripts = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).scripts as Record<string, string>;
    for (const name of ['prestart:all', 'predev:all', 'setup']) expect(scripts[name]).toMatch(/^node scripts\/ensure-prisma-client\.mjs && /);
    expect(fs.readFileSync(path.join(repo, 'scripts', 'start-all.mjs'), 'utf8')).toMatch(/ensure-prisma-client\.mjs'\), '--force'\]/);
  });
});
