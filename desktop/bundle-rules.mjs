// Rules for the desktop bundle (prepare.mjs), kept here so they are tested (tests/unit/desktop-bundle.test.ts).

/**
 * What a package carries only for its developers (owner request 2026-11-12: a faster install, about 8,000 fewer
 * files): source maps, TypeScript sources and type declarations (Node.js never runs .ts files inside node_modules),
 * read-me and change-log files (never a licence), and test, docs and example folders at the package's top level.
 * prepare.mjs leaves these out of the bundle; check-bundle.mjs then proves the bundle still runs.
 */
const DEV_ONLY_FILE = /\.(map|ts|mts|cts|md|markdown)$/i;
const DEV_ONLY_DIR = new Set(['test', 'tests', '__tests__', 'docs', 'doc', 'example', 'examples', '.github']);

/** @param {string} relInPackage  a file's path inside its package folder */
export function devOnly(relInPackage) {
  const parts = relInPackage.split(/[\\/]/);
  if (parts.length > 1 && DEV_ONLY_DIR.has(parts[0])) return true;
  const name = parts[parts.length - 1];
  return DEV_ONLY_FILE.test(name) && !/^licen[cs]e/i.test(name);
}

/** The test a script uses to start itself when run directly (scripts/migrate.ts, seed.ts, install-tools.ts). */
export const ENTRY_GUARD = "import.meta.url === pathToFileURL(process.argv[1] ?? '').href";

/**
 * Compiling the worker and the start-up steps into one file each (prepare.mjs): a script bundled into another would
 * see its own `import.meta.url` equal to the program's (the bundle's), so it would start itself as well (migrations
 * and seeding a second time, the tools installer). Only the entry keeps its test; the others get `false`.
 * @param {string} entryFile  the absolute path of the entry being compiled
 */
export function entryGuardPlugin(entryFile) {
  return {
    name: 'entry-guards',
    setup(build) {
      build.onLoad({ filter: /[\\/]scripts[\\/][^\\/]+\.ts$/ }, async (args) => {
        const fs = await import('node:fs');
        const text = fs.readFileSync(args.path, 'utf8');
        if (args.path === entryFile || !text.includes(ENTRY_GUARD)) return undefined;
        return { contents: text.split(ENTRY_GUARD).join('false'), loader: 'ts' };
      });
    },
  };
}
