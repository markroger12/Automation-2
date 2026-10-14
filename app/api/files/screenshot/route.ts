import fs from 'node:fs';
import path from 'node:path';
import { route } from '@/lib/api';
import { AppError } from '@/lib/errors';
import { dataPaths, safeJoin } from '@/lib/paths';

const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** Serve a sanitized failure screenshot from data/screenshots only (no traversal). */
export const GET = route({}, async ({ searchParams }) => {
  const rel = searchParams.get('path') ?? '';
  const name = rel.replace(/^screenshots\//, '');
  let file: string;
  try {
    file = safeJoin(dataPaths.screenshots(), ...name.split('/'));
  } catch {
    throw new AppError(400, 'BAD_PATH', 'Invalid screenshot path.');
  }
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type || !fs.existsSync(file)) throw new AppError(404, 'NOT_FOUND', 'Screenshot not found (it may have been pruned by retention).');
  return new Response(new Uint8Array(fs.readFileSync(file)), { headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
});
