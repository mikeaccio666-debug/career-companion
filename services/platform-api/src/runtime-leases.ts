import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from './database.ts';
import { ApiError } from './errors.ts';
import { recoverChatUsage } from './chat-usage.ts';

export async function acquireRuntimeLease(client:PoolClient,userId:string,kind:'chat'|'voice'|'background',id=randomUUID(),seconds=120){
  // Serialize runtime limits without blocking child rows' user FK KEY SHARE.
  await client.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[userId]);
  await client.query('DELETE FROM platform_runtime_leases WHERE user_id=$1 AND expires_at <= now()',[userId]);
  const active=await client.query('SELECT count(*)::integer AS count FROM platform_runtime_leases WHERE user_id=$1 AND kind=$2',[userId,kind]);
  if(active.rows[0].count >= (kind==='chat'?2:1))throw new ApiError(429,'RUNTIME_CONCURRENCY_LIMIT','Wait for an active conversation or voice request to finish.');
  await client.query("INSERT INTO platform_runtime_leases(id,user_id,kind,expires_at) VALUES($1,$2,$3,now()+($4 * interval '1 second'))",[id,userId,kind,seconds]);
  return id;
}
export async function withVoiceLease<T>(db:Database,userId:string,run:()=>Promise<T>):Promise<T>{
  const id=await db.transaction(client=>acquireRuntimeLease(client,userId,'voice'));
  const heartbeat=setInterval(()=>void db.query("UPDATE platform_runtime_leases SET expires_at=now()+interval '120 seconds' WHERE id=$1",[id]).catch(()=>{}),15_000);heartbeat.unref();
  try{return await run();}finally{clearInterval(heartbeat);await db.query('DELETE FROM platform_runtime_leases WHERE id=$1',[id]);}
}
export async function recoverStaleStreams(db:Database){
  await db.transaction(async client=>{
    await recoverChatUsage(client);
    await client.query("UPDATE platform_messages SET status='failed',lease_until=NULL WHERE status='streaming' AND lease_until < now()");
    await client.query('DELETE FROM platform_runtime_leases WHERE expires_at < now()');
  });
}
