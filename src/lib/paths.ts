import fs from 'node:fs';
import path from 'node:path';

/**
 * All filesystem locations are derived here with path.join/resolve so Windows
 * drive letters, spaces and Unicode folder names work. Nothing outside the
 * project data directory is ever written by the application.
 */
export function projectRoot(): string {
  return process.env.BAS_PROJECT_ROOT ? path.resolve(process.env.BAS_PROJECT_ROOT) : process.cwd();
}

export function dataDir(): string {
  return process.env.BAS_DATA_DIR ? path.resolve(process.env.BAS_DATA_DIR) : path.join(projectRoot(), 'data');
}

export const dataPaths = {
  db: () => path.join(dataDir(), 'app.db'),
  profiles: () => path.join(dataDir(), 'profiles'),
  chatgptChrome: () => path.join(dataDir(), 'chatgpt-chrome'),
  media: () => path.join(dataDir(), 'media'),
  screenshots: () => path.join(dataDir(), 'screenshots'),
  logs: () => path.join(dataDir(), 'logs'),
  backups: () => path.join(dataDir(), 'backups'),
  tools: () => path.join(dataDir(), 'tools'),
  workerLock: () => path.join(dataDir(), 'worker.lock'),
  uploads: () => path.join(dataDir(), 'uploads'),
  reports: () => path.join(dataDir(), 'reports'),
};

export function ensureDataDirs(): void {
  for (const dir of [
    dataDir(),
    dataPaths.profiles(),
    dataPaths.chatgptChrome(),
    dataPaths.media(),
    dataPaths.screenshots(),
    dataPaths.logs(),
    dataPaths.backups(),
    dataPaths.tools(),
    dataPaths.uploads(),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Resolve DATABASE_URL to an absolute `file:` URL. Prisma resolves relative
 * SQLite paths against the schema directory for the CLI but against the
 * generated client at runtime, which differs between Next.js and the worker.
 * We resolve once, relative to prisma/, and hand Prisma the absolute path.
 */
const DEFAULT_DATABASE_URL = 'file:../data/app.db';

export function resolveDatabaseUrl(raw = process.env.DATABASE_URL): string {
  let value = raw && raw.trim() ? raw.trim() : DEFAULT_DATABASE_URL;
  // BAS_DATA_DIR moves ALL app data, including the database, unless DATABASE_URL was customized.
  if (process.env.BAS_DATA_DIR && value === DEFAULT_DATABASE_URL) value = `file:${dataPaths.db().split(path.sep).join('/')}`;
  if (!value.startsWith('file:')) {
    throw new Error(`DATABASE_URL must be a SQLite file: URL (got "${value.slice(0, 40)}")`);
  }
  const [filePart, query] = value.slice('file:'.length).split('?');
  const absolute = path.isAbsolute(filePart) || /^[A-Za-z]:[\\/]/.test(filePart)
    ? path.resolve(filePart)
    : path.resolve(projectRoot(), 'prisma', filePart);
  const normalized = absolute.split(path.sep).join('/');
  const params = new URLSearchParams(query ?? '');
  if (!params.has('socket_timeout')) params.set('socket_timeout', '15');
  if (!params.has('connection_limit')) params.set('connection_limit', '4');
  return `file:${normalized}?${params.toString()}`;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

export function slugify(input: string, maxLength = 64): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'site';
}

/**
 * Join untrusted relative segments under a base directory and refuse any
 * result that escapes it (path traversal, absolute paths, drive letters).
 */
export function safeJoin(base: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (segment.includes('\0')) throw new Error('Invalid path segment');
    if (path.isAbsolute(segment) || /^[A-Za-z]:/.test(segment)) throw new Error('Absolute paths are not allowed');
  }
  const resolvedBase = path.resolve(base);
  const target = path.resolve(resolvedBase, ...segments);
  const relative = path.relative(resolvedBase, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return target;
  throw new Error('Path escapes its allowed directory');
}

export function profileDirForSlug(slug: string): string {
  if (!isValidSlug(slug)) throw new Error(`Invalid profile slug "${slug}"`);
  return safeJoin(dataPaths.profiles(), slug);
}

/** Relative (data-dir based) representation stored in the database. */
export function toDataRelative(absolute: string): string {
  const rel = path.relative(dataDir(), absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path is outside the data directory');
  return rel.split(path.sep).join('/');
}

export function fromDataRelative(relative: string): string {
  return safeJoin(dataDir(), ...relative.split('/'));
}
