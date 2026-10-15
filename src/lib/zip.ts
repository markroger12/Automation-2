import zlib from 'node:zlib';

/**
 * Minimal, bounded ZIP reader for owner-supplied exports (e.g. a Search
 * Console “Download CSV” zip). Stored and deflate entries only; no ZIP64, no
 * encryption. Entry count and uncompressed sizes are capped, and inflation
 * stops at the declared size, so a crafted archive cannot exhaust memory.
 */

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export class ZipError extends Error {}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === LOCAL;
}

export function readZip(buf: Buffer, limits: { maxEntries?: number; maxEntryBytes?: number; maxTotalBytes?: number } = {}): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? 50;
  const maxEntryBytes = limits.maxEntryBytes ?? 10 * 1024 * 1024;
  const maxTotalBytes = limits.maxTotalBytes ?? 30 * 1024 * 1024;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('Not a ZIP file (no end-of-archive record).');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported.');
  if (count > maxEntries) throw new ZipError(`The archive has ${count} files (at most ${maxEntries}).`);
  const out: ZipEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new ZipError('Damaged ZIP directory.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // directory
    if (flags & 0x1) throw new ZipError(`“${name}” is encrypted.`);
    if (size > maxEntryBytes) throw new ZipError(`“${name}” is too large (${size} bytes).`);
    total += size;
    if (total > maxTotalBytes) throw new ZipError('The archive is too large when unpacked.');
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL) throw new ZipError(`Damaged entry “${name}”.`);
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(start, start + compressed);
    if (raw.length !== compressed) throw new ZipError(`Truncated entry “${name}”.`);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
      } catch (error) {
        throw new ZipError(`Could not unpack “${name}”: ${(error as Error).message}`);
      }
    } else throw new ZipError(`“${name}” uses an unsupported compression method (${method}).`);
    if (data.length !== size) throw new ZipError(`“${name}” does not match its declared size.`);
    out.push({ name, data });
  }
  return out;
}
