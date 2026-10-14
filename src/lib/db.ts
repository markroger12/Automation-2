import { PrismaClient } from '@prisma/client';
import { resolveDatabaseUrl } from './paths';

const globalForPrisma = globalThis as unknown as { __basPrisma?: PrismaClient; __basPragmas?: Promise<void> };

function create(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: resolveDatabaseUrl() } },
    log: process.env.PRISMA_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });
}

export const db: PrismaClient = globalForPrisma.__basPrisma ?? create();
if (process.env.NODE_ENV !== 'production') globalForPrisma.__basPrisma = db;

/**
 * WAL lets the dashboard read while the worker writes. busy_timeout is set per
 * connection through socket_timeout in the resolved URL; WAL is persistent.
 */
export function ensurePragmas(client: PrismaClient = db): Promise<void> {
  if (client === db && globalForPrisma.__basPragmas) return globalForPrisma.__basPragmas;
  const p = (async () => {
    await client.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
    await client.$queryRawUnsafe('PRAGMA foreign_keys = ON;');
  })();
  if (client === db) globalForPrisma.__basPragmas = p;
  return p;
}

export type Db = PrismaClient;
export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;
