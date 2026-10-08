import type { Database } from './database.ts';
/** Bounded maintenance of actual expired user deletions. No content or identities
 * are returned to logs; content-free command tombstones prevent resurrection. */
export async function purgeExpiredMemoryDeletions(db:Database,limit=100):Promise<number> {
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('Invalid memory retention batch.');
  return db.withBoundedTransaction(async client=>{
    const result=await client.query(`DELETE FROM platform_memories WHERE id IN (
      SELECT id FROM platform_memories WHERE deleted_at IS NOT NULL AND undo_until<=clock_timestamp()
      ORDER BY undo_until,id LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING id`,[limit]);
    return result.rowCount??0;
  });
}
