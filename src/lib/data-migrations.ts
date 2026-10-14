import type { PrismaClient } from '@prisma/client';

/**
 * Versioned, idempotent data migrations (separate from Prisma schema
 * migrations). Each runs once, is recorded in DataMigration, and must never
 * delete owner data.
 */
export interface DataMigrationDef {
  id: string;
  description: string;
  run: (client: PrismaClient) => Promise<Record<string, unknown>>;
}

const migrations: DataMigrationDef[] = [];

export function registerDataMigration(def: DataMigrationDef) {
  if (!migrations.some((m) => m.id === def.id)) migrations.push(def);
}

export async function runDataMigrations(client: PrismaClient): Promise<string[]> {
  const { loadBuiltInDataMigrations } = await import('./data-migrations-list');
  loadBuiltInDataMigrations();
  const report: string[] = [];
  for (const migration of migrations) {
    const done = await client.dataMigration.findUnique({ where: { id: migration.id } });
    if (done) {
      report.push(`Data migration ${migration.id}: already applied ✓`);
      continue;
    }
    const details = await migration.run(client);
    await client.dataMigration.create({ data: { id: migration.id, details: JSON.stringify(details) } });
    report.push(`Data migration ${migration.id}: applied ✓ ${JSON.stringify(details)}`);
  }
  return report;
}
