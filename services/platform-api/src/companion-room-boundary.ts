import type { Database } from './database.ts';
import { ApiError, notFound } from './errors.ts';

/** A persisted product room needs the product turn service. Legacy mode or
 * persona never authorize an ordinary reply, a voice handoff or room deletion. */
export function assertLegacyConversationRow(row: { kind?: unknown }): void {
  if (row.kind === 'main') throw new ApiError(409, 'COMPANION_ROOM_REQUIRED', 'Use the companion room for this action.');
}

export async function assertLegacyConversation(client: Pick<Database, 'query'>, ownerId: string, id: string): Promise<void> {
  const result = await client.query('SELECT id,kind FROM platform_conversations WHERE id=$1 AND user_id=$2', [id, ownerId]);
  if (!result.rowCount) throw notFound();
  assertLegacyConversationRow(result.rows[0]);
}
