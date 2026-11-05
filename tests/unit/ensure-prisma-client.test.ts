import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain Node.js script without types (scripts/ensure-prisma-client.mjs)
import { clientMatchesSchema } from '../../scripts/ensure-prisma-client.mjs';

/**
 * Owner report (2026-11-05): an update stopped by a full disk left the Prisma client of the previous version, and
 * `next build` failed (“Parameter 'c' implicitly has an 'any' type”). Before start:all / dev:all / setup the client is
 * compared with prisma/schema.prisma and generated again when they differ.
 */
describe('the Prisma client is made again when the schema changed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bas-client-'));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };

  it('same schema (also with Windows line ends): nothing to do; changed or missing: generate', () => {
    write('prisma/schema.prisma', 'model A {\n  id String @id\n}\n');
    write('node_modules/.prisma/client/schema.prisma', 'model A {\r\n  id String @id\r\n}\r\n');
    expect(clientMatchesSchema(dir)).toBe(true);
    write('prisma/schema.prisma', 'model A {\n  id String @id\n}\n\nmodel CustomWriter {\n  id String @id\n}\n');
    expect(clientMatchesSchema(dir)).toBe(false);
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true });
    expect(clientMatchesSchema(dir)).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });

  it('runs before start:all, dev:all and setup', () => {
    const scripts = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')).scripts as Record<string, string>;
    for (const name of ['prestart:all', 'predev:all', 'setup']) expect(scripts[name]).toMatch(/^node scripts\/ensure-prisma-client\.mjs && /);
  });
});
