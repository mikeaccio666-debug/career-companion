import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import type {FixedSessionContext} from '../src/auth.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {NAME_SOURCE_EXPORT_TABLES} from '../src/account-name-source-export.ts';
import {fixture,ready,submit,classify,apply,instrument,proof,reads} from './fixtures/account-name-source-export.ts';

// Explicit stress entry: excluded from the normal test/*.test.ts glob.
// Run with tsx --test test/account-name-source-export-pagination.stress.ts.
test('105 adopted sources paginate submissions, receipts and composite identity provenance without losing earlier versions',async()=>fixture(async(f,runtime,calls)=>{
 const p=await ready(f,runtime);
 // Bulk fixture setup exercises real persistence, not classifier/transaction SLAs.
 // Extend setup clocks and use the supported 60-second lease. Restore every
 // override before capture so the archive keeps its real 5-second deadline.
 const originalTimeout=AbortSignal.timeout.bind(AbortSignal),deadline=mock.method(AbortSignal,'timeout',(ms:number)=>originalTimeout(ms<=5000?30000:ms));
 const originalTimer=globalThis.setTimeout,requestDeadline=mock.method(globalThis,'setTimeout',((callback:any,ms?:number,...args:any[])=>originalTimer(callback,ms!==undefined&&ms<=5000?30000:ms,...args)) as typeof setTimeout);
 const originalClaim=p.safety.claimSubmission.bind(p.safety),lease=mock.method(p.safety,'claimSubmission',(who:FixedSessionContext,request:Parameters<typeof originalClaim>[1],signal?:AbortSignal)=>originalClaim(who,{...request,leaseMs:60000},signal));
 try{for(let i=0;i<105;i++){try{const s=await submit(p,i%2?'舟':'Juno');await classify(f,p,runtime,s.submissionId);await apply(p,s.submissionId);}catch(cause){throw new Error('Bulk naming fixture failed at revision '+(i+1),{cause});}}}
 finally{deadline.mock.restore();requestDeadline.mock.restore();lease.mock.restore();}
 const queries:string[]=[],n=calls.length,data=await new AccountCoreExport(instrument(f,sql=>{queries.push(sql);}),f.config).capture(p.who,await proof(f,p.who));
 assert.equal(data.sections.companionNameSubmissions.length,105);assert.equal(data.sections.companionNameIdentityReceipts.length,105);assert.equal(data.sections.companionNameIdentityProvenance.length,105);
 assert.deepEqual((data.sections.companionNameIdentityProvenance as any[]).map(r=>r.identityRevision),Array.from({length:105},(_,i)=>i+1));
 for(const table of NAME_SOURCE_EXPORT_TABLES.slice(1))assert.equal(queries.filter(sql=>reads(sql,table)&&sql.includes('LIMIT 100')).length,2);
 assert.equal((data.sections.companionNameIdentityReceipts as any[]).filter(r=>r.currentForIdentity).length,1);assert.equal(calls.length,n);
}));
