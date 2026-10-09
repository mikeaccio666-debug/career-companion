import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {PlatformProviderRuntime} from '@companion/platform-contracts';
import {Database} from '../../src/database.ts';
import {hashPassword,type FixedSessionContext} from '../../src/auth.ts';
import {AccountCoreExport} from '../../src/account-core-export.ts';
import {AccountReauthentication} from '../../src/account-reauthentication.ts';
import {NAME_SOURCE_EXPORT_TABLES} from '../../src/account-name-source-export.ts';
import {CompanionNameSafetyRunner} from '../../src/companion-name-safety-runner.ts';
import {createPrebirthFixture,withPrebirthLoopback,prebirthDetector,type PrebirthFixture,type ReadyPrebirthSource} from './companion-prebirth.ts';
export const password='Fictional-name-source-export-password';
export const encoded=await hashPassword(password);
export const failure={code:'ACCOUNT_NAME_SOURCE_EXPORT_UNAVAILABLE'};
export async function fixture(run:(f:PrebirthFixture,runtime:PlatformProviderRuntime,calls:Record<string,unknown>[])=>Promise<void>,level:'L0'|'L1'|'L2'='L0'){
 await withPrebirthLoopback(async(runtime,calls)=>{const f=await createPrebirthFixture();try{await run(f,runtime,calls);}finally{await f.close();}},level);
}
export async function ready(f:PrebirthFixture,runtime:PlatformProviderRuntime){const p=await f.ready(runtime);await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[p.who.userId,encoded]);return p;}
export const proof=async(f:PrebirthFixture,who:FixedSessionContext)=>(await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;
export const capture=async(f:PrebirthFixture,who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await proof(f,who));
export async function submit(p:ReadyPrebirthSource,name:string){const entry=await p.safety.read(p.who,{taskId:p.prepared.taskId}),identity=await p.names.read(p.who,{taskId:p.prepared.taskId});
 return p.safety.submit(p.who,{taskId:p.prepared.taskId,name,expectedEntryRevision:entry?.revision??0,expectedIdentityRevision:identity?.revision??0,operationId:randomUUID()});
}
export async function classify(f:PrebirthFixture,p:ReadyPrebirthSource,runtime:PlatformProviderRuntime,id:string){await new CompanionNameSafetyRunner(p.safety,{...f.config,safetyDailyModelCallLimit:200},runtime,prebirthDetector).runSubmission(p.who,{taskId:p.prepared.taskId,submissionId:id});}
export async function apply(p:ReadyPrebirthSource,id:string){return p.safety.apply(p.who,{taskId:p.prepared.taskId,submissionId:id});}
export function instrument(f:PrebirthFixture,change:(sql:string,rows:Record<string,any>[],client:PoolClient)=>void|Promise<void>):Database{
 return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
  if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await change(sql,result.rows,target);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }})),options)} as Database;
}
export const reads=(sql:string,table:string)=>sql.startsWith('SELECT * FROM '+table+' WHERE user_id=');
export const unused=async(f:PrebirthFixture,who:FixedSessionContext)=>assert((await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND session_hash=$2 AND purpose='account_export'",[who.userId,who.tokenHash])).rows.every(r=>r.consumed_at===null));
export async function snapshot(f:PrebirthFixture,who:FixedSessionContext){const rows:unknown[]=[];for(const table of NAME_SOURCE_EXPORT_TABLES)rows.push((await f.db.query(`SELECT row_to_json(t)::text AS saved FROM ${table} t WHERE user_id=$1 ORDER BY row_to_json(t)::text`,[who.userId])).rows);return rows;}
export async function named(f:PrebirthFixture,runtime:PlatformProviderRuntime){const p=await ready(f,runtime),s=await submit(p,' Juno ');await classify(f,p,runtime,s.submissionId);await apply(p,s.submissionId);return {...p,submission:s};}
