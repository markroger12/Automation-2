/**
 * Runs before `npm run start:all`, `npm run dev:all` and `npm run setup`, and in the one-click update's build step
 * (owner report 2026-11-05: an update stopped by a full disk left the Prisma client of the previous version; `next
 * build` then failed with “Parameter 'c' implicitly has an 'any' type” in app/(dashboard)/writers/[key]/page.tsx). The
 * same happens after a plain `git pull` that changes prisma/schema.prisma but no package (`npm install`, which
 * generates the client, is not run), and when `prisma generate` stopped half-way (on Windows a running app keeps the
 * engine file locked: EPERM).
 *
 * After a `prisma generate` that finished, a stamp with the schema's fingerprint is written into the generated client
 * (node_modules/.prisma/client/bas-schema.sha256). No stamp, or one of another schema → `prisma generate` runs here,
 * in its own process, before anything has loaded the Prisma engine. A client made by `npm install` has no stamp yet:
 * it is made once more at the next start (a few seconds). Plain Node.js, no dependencies.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
};
const stampFile = (dir) => path.join(dir, 'node_modules', '.prisma', 'client', 'bas-schema.sha256');

/** The fingerprint of prisma/schema.prisma (line ends ignored); null without a schema. */
export function schemaHash(dir = root) {
  const schema = read(path.join(dir, 'prisma', 'schema.prisma'));
  return schema === null ? null : crypto.createHash('sha256').update(schema).digest('hex');
}

/** True when a `prisma generate` of the current schema finished (its stamp) and the client's schema copy matches. */
export function clientMatchesSchema(dir = root) {
  const hash = schemaHash(dir);
  const schema = read(path.join(dir, 'prisma', 'schema.prisma'));
  const generated = read(path.join(dir, 'node_modules', '.prisma', 'client', 'schema.prisma'));
  const stamp = read(stampFile(dir))?.trim() ?? null;
  return hash !== null && schema === generated && stamp === hash;
}

/** Generate the client and stamp it; returns false when `prisma generate` failed. */
export function generateClient(dir = root) {
  const cli = path.join(dir, 'node_modules', 'prisma', 'build', 'index.js');
  if (!fs.existsSync(cli)) {
    console.error('✖ The packages are not installed (node_modules/prisma is missing). Run `npm install`, then try again.');
    return false;
  }
  fs.rmSync(stampFile(dir), { force: true });
  const r = spawnSync(process.execPath, [cli, 'generate'], { cwd: dir, stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) return false;
  fs.writeFileSync(stampFile(dir), `${schemaHash(dir)}\n`);
  return true;
}

function main() {
  const force = process.argv.includes('--force');
  if (!force && clientMatchesSchema()) return;
  console.log(force ? '▸ Updating the Prisma client (prisma generate)…' : '▸ The Prisma client is not made from the current database schema: updating it (prisma generate)…');
  if (!generateClient()) {
    console.error('✖ prisma generate failed. Close every window running the app (npm run start:all / dev:all) — or restart the PC, so no old app process keeps the Prisma engine file locked — make sure the disk has free space, then try again.');
    process.exit(1);
  }
}

// Run directly (not imported by a test). Windows paths compare without case (F:\claude vs F:\Claude).
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && same(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) main();
