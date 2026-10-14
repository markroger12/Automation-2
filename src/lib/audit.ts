import { db, type Tx } from './db';
import { redact } from './redact';

/**
 * Audit potentially destructive or permission-changing actions (deletion,
 * stage regeneration, publish-permission edits, publish/schedule approvals,
 * profile resets). There are no user accounts: the actor is the local owner.
 */
export async function audit(
  action: string,
  entityType: string,
  entityId: string | null,
  details: Record<string, unknown> = {},
  client: Tx = db,
): Promise<void> {
  await client.auditLog.create({
    data: { action, entityType, entityId, details: JSON.stringify(redact(details)) },
  });
}
