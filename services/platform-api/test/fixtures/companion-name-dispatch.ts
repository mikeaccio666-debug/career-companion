import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { CompanionNamingRequest, PlatformProviderRuntime } from '@companion/platform-contracts';
import { readConfig } from '../../src/config.ts';
import { CompanionNameSafety } from '../../src/companion-name-safety.ts';
import { CompanionNameSafetyRunner } from '../../src/companion-name-safety-runner.ts';
import { CompanionPrebirthSafety } from '../../src/companion-prebirth-safety.ts';
import { CompanionNamingEntry } from '../../src/companion-naming-entry.ts';
import type { CompanionNameSafetyResponses } from '../../src/companion-name-safety-responses.ts';
import type { SafetyDetectorProfile } from '../../src/safety-detector-profile.ts';
import { parseCompanionNameSafetyClaim } from '../../src/companion-name-safety-protocol.ts';
import { createPrebirthFixture, prebirthDetector } from './companion-prebirth.ts';
import { FICTIONAL_LEGAL } from './student-entry.ts';

/** Own schema + actual fictional approvals and persisted generation. The caller
 * provides the strictly loopback runtime; this factory never creates provider I/O. */
export async function createNamingDispatchFixture(runtime:PlatformProviderRuntime) {
  const base=await createPrebirthFixture();
  try {
    const ready=await base.ready(runtime),connection=base.db.pool.options.connectionString;
    assert.equal(typeof connection,'string');
    const databaseUrl=connection!,redisUrl=readConfig().redisUrl;
    assert(['localhost','127.0.0.1','[::1]'].includes(new URL(databaseUrl).hostname));
    assert(['localhost','127.0.0.1','[::1]'].includes(new URL(redisUrl).hostname));
    assert.match(base.schema,/^companion_name_[0-9a-f]{32}$/);
    const config={...readConfig(),...base.config,databaseUrl,redisUrl,queueName:'naming-dispatch-'+randomUUID()};
    const safety=new CompanionNameSafety(base.db,config,FICTIONAL_LEGAL,ready.background,ready.names,base.resources);
    const runner=new CompanionNameSafetyRunner(safety,config,runtime,prebirthDetector);
    const prebirth=new CompanionPrebirthSafety(base.db,config,FICTIONAL_LEGAL,ready.background,safety,ready.names);
    function namingWith(profile:SafetyDetectorProfile|null,resources:CompanionNameSafetyResponses|undefined) {
      return new CompanionNamingEntry(base.db,config,FICTIONAL_LEGAL,safety,new CompanionNameSafetyRunner(safety,config,runtime,profile),prebirth,resources);
    }
    const naming=new CompanionNamingEntry(base.db,config,FICTIONAL_LEGAL,safety,runner,prebirth,base.original);
    const command=(name='Juno',expectedEntryRevision=0,expectedIdentityRevision=0):CompanionNamingRequest=>({
      taskId:ready.prepared.taskId,expectedEntryRevision,expectedIdentityRevision,operationId:randomUUID(),name,
    });
    return {...base,config,ready,who:ready.who,taskId:ready.prepared.taskId,naming,safety,runner,prebirth,namingWith,command};
  } catch(error) {await base.close();throw error;}
}
export type NamingDispatchFixture=Awaited<ReturnType<typeof createNamingDispatchFixture>>;
export const dispatchTables=['platform_companion_name_entries','platform_companion_name_submissions','platform_companion_prebirth_heads',
  'platform_companion_prebirth_inventory','platform_companion_name_dispatches','platform_companion_name_dispatch_outbox',
  'platform_companion_name_dispatch_operations','platform_safety_model_usage','platform_companion_identity_drafts',
  'platform_companion_identity_operations','platform_companion_name_identity_receipts','platform_companion_name_identity_provenance',
  'platform_companion_name_safety_responses','platform_safety_events'] as const;
/** PostgreSQL JSON text retains microseconds; assertions never decrypt private
 * names/sessions into ordinary test output. */
export async function dispatchBytes(f:NamingDispatchFixture) {
  const result:Record<string,string[]>={};
  for(const table of dispatchTables) result[table]=(await f.db.query(`SELECT row_to_json(t)::text AS actual FROM ${table} t WHERE user_id=$1 ORDER BY row_to_json(t)::text`,[f.who.userId])).rows.map(row=>row.actual);
  return result;
}
export async function actualClaim(f:NamingDispatchFixture,sourceId:string) {
  const row=(await f.db.query('SELECT * FROM platform_companion_name_submissions WHERE id=$1 AND user_id=$2',[sourceId,f.who.userId])).rows[0];
  assert(row?.claim_ciphertext);
  return parseCompanionNameSafetyClaim(JSON.parse(f.crypto.openUtf8(row.claim_ciphertext,{table:'platform_companion_name_submissions',column:'claim_ciphertext',rowId:row.id,ownerId:row.user_id,revision:row.generation})).claim);
}
export async function waitTrueLeaseExpiry(f:NamingDispatchFixture,sourceId:string) {
  const end=Date.now()+6500;
  while(Date.now()<end) {
    const row=(await f.db.query('SELECT lease_until<=clock_timestamp() AS expired FROM platform_companion_name_submissions WHERE id=$1 AND user_id=$2',[sourceId,f.who.userId])).rows[0];
    assert(row);if(row.expired===true)return;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.fail('The real database lease did not expire within the bounded test wait.');
}
/** Actual child commits an ordinary managed claim, then stays alive without
 * process/start/provider usage. Parent kills only this child and verifies signal. */
export async function killedUnstartedClaim(f:NamingDispatchFixture,sourceId:string) {
  const path=fileURLToPath(new URL('./companion-name-dispatch-child.ts',import.meta.url));
  const child=fork(path,[],{cwd:fileURLToPath(new URL('../../',import.meta.url)),execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});
  const output:Buffer[]=[];child.stdout?.on('data',data=>output.push(Buffer.from(data)));child.stderr?.on('data',data=>output.push(Buffer.from(data)));
  let exited=false;
  const exit=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{
    child.once('error',reject);child.once('exit',(code,signal)=>{exited=true;resolve({code,signal});});
  });
  try {
    const committed=await new Promise<number>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Owned claim child did not commit in time.')),10000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('Owned claim child exited before its real commit.'));});
      child.on('message',value=>{
        if(!value||typeof value!=='object')return;const data=value as Record<string,unknown>;
        if(data.kind==='claim_committed'&&data.sourceId===sourceId&&data.generation===1){clearTimeout(timer);resolve(data.generation as number);}
        else if(data.kind==='failed'){clearTimeout(timer);reject(new Error('Owned claim child failed its actual service path.'));}
      });
      child.send({databaseUrl:f.config.databaseUrl,who:f.who,taskId:f.taskId,sourceId,asset:f.ready.authority.asset,review:f.ready.authority.review});
    });
    assert.equal(committed,1);const claim=await actualClaim(f,sourceId);
    assert.equal(child.kill('SIGKILL'),true);const terminal=await exit;
    assert.deepEqual(terminal,{code:null,signal:'SIGKILL'});
    assert.equal(Buffer.concat(output).toString(),'');
    return {claim,pid:child.pid,signal:terminal.signal};
  } finally {
    if(!exited){child.kill('SIGKILL');await exit.catch(()=>{});}
  }
}
