/**
 * Runs before `npm run start:all`, `npm run dev:all` and `npm run setup` (owner report 2026-11-05: an update stopped
 * by a full disk left the Prisma client of the previous version; `next build` then failed with “Parameter 'c'
 * implicitly has an 'any' type” in app/(dashboard)/writers/[key]/page.tsx). The same happens after a plain `git pull`
 * that changes prisma/schema.prisma but no package: `npm install` (which generates the client) is not run.
 *
 * The generated client keeps a copy of the schema it was made from (node_modules/.prisma/client/schema.prisma). When it
 * differs from prisma/schema.prisma, `prisma generate` runs here — in its own process, before anything has loaded the
 * Prisma engine (on Windows a loaded engine cannot be replaced). Plain Node.js, no dependencies.
 */
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

/** True when the generated Prisma client was made from the current schema. */
export function clientMatchesSchema(dir = root) {
  const schema = read(path.join(dir, 'prisma', 'schema.prisma'));
  const generated = read(path.join(dir, 'node_modules', '.prisma', 'client', 'schema.prisma'));
  return schema !== null && generated !== null && schema === generated;
}

function main() {
  if (clientMatchesSchema()) return;
  const cli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
  if (!fs.existsSync(cli)) {
    console.error('✖ The packages are not installed (node_modules/prisma is missing). Run `npm install`, then try again.');
    process.exit(1);
  }
  console.log('▸ The database schema changed since the Prisma client was made: updating it (prisma generate)…');
  const r = spawnSync(process.execPath, [cli, 'generate'], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) {
    console.error('✖ prisma generate failed. Close every other window running the app (npm run start:all / dev:all), make sure the disk has free space, then try again.');
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
