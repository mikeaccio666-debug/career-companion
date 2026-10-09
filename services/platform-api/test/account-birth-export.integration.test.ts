import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Database} from '../src/database.ts';
import type {PublicCompanionBirthReceipt} from '@companion/platform-contracts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {CompanionBirthOriginStore} from '../src/companion-birth-origin-store.ts';
import {createPrebirthFixture,withPrebirthLoopback} from './fixtures/companion-prebirth.ts';
import {readyBirth} from './fixtures/companion-birth.ts';
let f:Awaited<ReturnType<typeof createPrebirthFixture>>,encoded:string;
const password='Fictional-birth-export-password';
before(async()=>{f=await createPrebirthFixture();encoded=await hashPassword(password);});
after(async()=>{await f?.close();});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
async function prepare(){
 const who=await actor();let receipt!:PublicCompanionBirthReceipt;
 await withPrebirthLoopback(async(runtime,calls)=>{const ready=await readyBirth(f,runtime,{who});receipt=(await ready.service.birth(who,ready.body,ready.key)).receipt;assert.equal(calls.length,2);});
 return {who,receipt};
}
async function proof(who:FixedSessionContext){return (await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;}
const capture=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await proof(who));
const consumed=async(who:FixedSessionContext)=>(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows[0].consumed_at;
/** Fault injection changes rows only after the actual owned SQL query. It does
 * not disable the immutable-record triggers or mutate saved database bytes. */
function instrument(transform:(sql:string,rows:Record<string,any>[],client:PoolClient)=>void|Promise<void>):Database{
 return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
  if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await transform(sql,result.rows,target);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }})),options)} as Database;
}
const isOrigin=(sql:string)=>sql.startsWith('SELECT * FROM platform_companion_birth_receipts WHERE user_id=');
const isAsset=(sql:string)=>sql.startsWith('SELECT * FROM platform_companion_birth_assets WHERE id=');
function damage(bytes:Buffer){const changed=Buffer.from(bytes);changed[changed.length-1]^=1;return changed;}

test('real committed birth exports its immutable identity and reviewed provenance with verified asset metadata, never auth or ciphertext',async()=>{
 const p=await prepare(),foreign=await prepare(),token=await proof(p.who),result=await new AccountCoreExport(f.db,f.config).capture(p.who,token);
 assert.equal(result.sections.companionBirthReceipts.length,1);assert.equal(result.sections.companionBirthAssetMetadata.length,1);
 const saved=result.sections.companionBirthReceipts[0] as any,asset=result.sections.companionBirthAssetMetadata[0] as any;
 assert.deepEqual(saved.receipt,p.receipt);assert.equal(saved.source.identity.revision,p.receipt.identity.identityRevision);assert.equal(saved.source.identity.selectionRevision,p.receipt.identity.selectionRevision);
 const row=(await f.db.query('SELECT * FROM platform_companion_birth_receipts WHERE id=$1',[p.receipt.id])).rows[0];
 assert.equal(saved.source.generation.taskId,row.task_id);assert.equal(saved.source.generation.answersId,row.answers_id);assert.equal(saved.source.identity.nameSubmissionId,row.name_submission_id);
 assert.equal(saved.source.inventory.tipId,row.inventory_tip_id);assert.equal(saved.source.terms.version,row.terms_version);assert.equal(saved.source.identity.sealCandidates.length,3);
 const bytes=await f.db.transaction(client=>new CompanionBirthOriginStore(f.crypto).readSealAsset(client,p.who.userId,p.receipt.identity.sealAssetId));assert(bytes);
 assert.equal(asset.svgDigest,createHash('sha256').update(bytes.svg).digest('hex'));assert.equal(asset.pngDigest,createHash('sha256').update(bytes.png).digest('hex'));
 assert.equal(asset.svgSizeBytes,bytes.svg.length);assert.equal(asset.pngSizeBytes,bytes.png.length);assert.equal(asset.bytesVerified,true);assert.equal(asset.bytesIncluded,false);
 assert.equal(result.includedTables.length,106);assert(result.includedTables.includes('platform_companion_birth_receipts'));assert(!result.remainingTables.includes('platform_companion_birth_receipts'));
 assert(result.remainingTables.includes('platform_companion_birth_assets'));assert(result.includedTables.includes('platform_companions'));assert.equal(result.complete,false);assert.equal(result.filesIncluded,false);
 const text=JSON.stringify(result);for(const secret of [p.who.tokenHash,encoded,password,token,foreign.who.userId,foreign.receipt.id,'acceptedAuthVersion','accepted_auth_version','request_digest','request_ciphertext','snapshot_ciphertext','svgCipherDigest','pngCipherDigest',bytes.png.toString('base64'),bytes.svg.toString()])assert(!text.includes(secret));
 assert(Object.isFrozen(saved.source.identity.sealCandidates));assert(Object.isFrozen(asset));
});

test('unborn owner has empty birth sections; exporting does not create a companion or an event',async()=>{
 const who=await actor(),result=await capture(who);assert.deepEqual(result.sections.companionBirthReceipts,[]);assert.deepEqual(result.sections.companionBirthAssetMetadata,[]);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM platform_companions WHERE user_id=$1',[who.userId])).rows[0].n,0);assert.equal(result.sections.messages.length,0);
});

test('retirement, changed current identity and withdrawn model admission preserve the original birth and seal',async()=>{
 const p=await prepare();await f.db.query("UPDATE platform_companions SET name='虚构后来名字',relationship_stage='familiar',stage_changed_at=clock_timestamp(),status='retired',retired_at=clock_timestamp() WHERE id=$1",[p.receipt.identity.companionId]);
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[p.who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[p.who.userId]);
 const result=await capture(p.who);assert.deepEqual((result.sections.companionBirthReceipts[0] as any).receipt,p.receipt);assert.equal((result.sections.companions[0] as any).name,'虚构后来名字');
 assert.equal((result.sections.companionBirthAssetMetadata[0] as any).sealChar,p.receipt.identity.sealChar);
});

test('receipt cipher corruption or foreign ciphertext cannot yield any partial export and proof remains retryable',async()=>{
 const p=await prepare(),other=await prepare(),token=await proof(p.who);
 const otherRow=(await f.db.query('SELECT * FROM platform_companion_birth_receipts WHERE id=$1',[other.receipt.id])).rows[0];
 for(const column of ['request_ciphertext','snapshot_ciphertext'])for(const foreign of [false,true]){
  let reached=false;const db=instrument((sql,rows)=>{if(isOrigin(sql)&&rows.length){reached=true;rows[0][column]=foreign?otherRow[column]:damage(rows[0][column]);}});
  await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),{code:'COMPANION_BIRTH_STORAGE_UNAVAILABLE'});assert(reached);assert.equal(await consumed(p.who),null);
 }
 assert.deepEqual(((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionBirthReceipts[0] as any).receipt,p.receipt);
});

test('asset ciphertext and clear metadata must match the authenticated birth before metadata can be exported',async()=>{
 const p=await prepare(),token=await proof(p.who);
 for(const column of ['svg_ciphertext','png_base64_ciphertext','svg_digest','png_size_bytes']){
  let reached=false;const db=instrument((sql,rows)=>{if(isAsset(sql)&&rows.length){reached=true;rows[0][column]=column.endsWith('ciphertext')?damage(rows[0][column]):column==='svg_digest'?'0'.repeat(64):rows[0][column]+1;}});
  await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),{code:'COMPANION_BIRTH_STORAGE_UNAVAILABLE'});assert(reached);assert.equal(await consumed(p.who),null);
 }
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionBirthAssetMetadata.length,1);
});

test('clear receipt provenance cannot override the authenticated snapshot and runtime ownership queries stay in the same transaction',async()=>{
 const p=await prepare(),token=await proof(p.who);
 for(const column of ['born_name','request_digest','accepted_auth_version']){
  const db=instrument((sql,rows)=>{if(isOrigin(sql)&&rows.length)rows[0][column]=column==='born_name'?'伪造名字':column==='request_digest'?'0'.repeat(64):'999';});
  await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),{code:'COMPANION_BIRTH_STORAGE_UNAVAILABLE'});assert.equal(await consumed(p.who),null);
 }
 const queries:string[]=[],db=instrument(sql=>{queries.push(sql);});const result=await new AccountCoreExport(db,f.config).capture(p.who,token);
 assert.equal(result.sections.companionBirthReceipts.length,1);assert(queries.some(isOrigin));assert(queries.some(isAsset));
 assert(!queries.filter(sql=>sql.startsWith('SELECT * FROM platform_companions')||isAsset(sql)).some(sql=>sql.includes('FOR SHARE')),'Archive reads use its existing snapshot, not the interactive lock path.');
});

test('cancellation after reading an origin discards all sections and preserves the proof for retry',async()=>{
 const p=await prepare(),token=await proof(p.who),controller=new AbortController();let reached=false;
 const db=instrument(sql=>{if(isOrigin(sql)){reached=true;controller.abort();}});
 await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token,controller.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});assert(reached);assert.equal(await consumed(p.who),null);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionBirthReceipts.length,1);
});
