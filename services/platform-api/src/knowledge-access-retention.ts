import type {Database} from './database.ts';
/** Internal worker maintenance. The stored expiry is the authority; callers
 * cannot supply an account or cutoff to erase unexpired access history. */
export async function purgeExpiredKnowledgeAccess(db:Database,limit=100):Promise<number>{
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid knowledge retention batch.');
 return db.withBoundedTransaction(async client=>{
  const result=await client.query(`DELETE FROM platform_knowledge_access_log WHERE id IN (
   SELECT id FROM platform_knowledge_access_log WHERE retention_until<=statement_timestamp()
   ORDER BY retention_until,id LIMIT $1 FOR UPDATE SKIP LOCKED)`,[limit]);
  return result.rowCount??0;
 });
}
