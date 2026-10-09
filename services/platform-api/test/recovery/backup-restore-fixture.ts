import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import type {PlatformProviderRuntime} from '@companion/platform-contracts';
import {PLATFORM_ACCOUNT_HEADER} from '@companion/platform-contracts';
import {Database} from '../../src/database.ts';
import {readConfig} from '../../src/config.ts';
import {buildApp} from '../../src/app.ts';
import {createRecoveryStorage,type RecoveryStorage} from './recovery-storage.ts';
import {FICTIONAL_LEGAL,fictionalRegistration,seedFictionalActiveLegal} from '../fixtures/student-entry.ts';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
/** Opt-in, synthetic-only drill. No database URL, existing container or backup
 * path is accepted. Docker must already have the PostgreSQL 17 image. */
export async function verifyRecovery(t:TestContext,mode:'local'|'s3'){
 const name='companion-recovery-'+randomUUID(),password=randomBytes(32).toString('hex'),key=randomBytes(32).toString('hex');
 const transport:NodeJS.ProcessEnv={};
 for(const k of ['PATH','HOME','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','XDG_RUNTIME_DIR','SSH_AUTH_SOCK'])if(process.env[k])transport[k]=process.env[k];
 // Generated credentials are delivered via environment, never command arguments.
 const childEnv={...transport,POSTGRES_PASSWORD:password,PGPASSWORD:password};
 let storage:RecoveryStorage|undefined;
 let container:string|undefined,admin:Database|undefined,sourceDb:Database|undefined,restoredDb:Database|undefined;
 let source:Awaited<ReturnType<typeof buildApp>>|undefined,restored:Awaited<ReturnType<typeof buildApp>>|undefined;
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'companion-recovery-'));
 await fs.chmod(dir,0o700);
 const times:Record<string,number>={},started=performance.now();let calls=0;
 const deny=async():Promise<never>=>{calls++;throw Error('External calls are forbidden in the recovery drill.');};
 const runtime:PlatformProviderRuntime={capabilities:()=>[],streamChat:async function*(){await deny();},executeJob:deny,createVoiceSession:deny,transcribe:deny,speech:deny};
 const docker=(args:string[],input?:Buffer,timeout=60_000,extraEnv:NodeJS.ProcessEnv={}):Promise<Buffer>=>new Promise((resolve,reject)=>{
  const child=spawn('docker',args,{env:{...childEnv,...extraEnv},stdio:['pipe','pipe','pipe']});
  const chunks:Buffer[]=[];let length=0,failed=false;
  const fail=()=>{if(failed)return;failed=true;child.kill('SIGKILL');};
  const timer=setTimeout(fail,timeout);
  child.on('error',()=>{failed=true;});
  child.stdout.on('data',(b:Buffer)=>{length+=b.length;if(length>64*1024*1024)fail();else chunks.push(b);});
  // PostgreSQL errors may contain private coordinates. Do not echo raw stderr.
  child.stderr.resume();child.stdin.on('error',()=>{failed=true;});
  child.on('close',code=>{clearTimeout(timer);if(failed||code!==0)reject(Error('Isolated recovery command failed; no credentials or command output are included.'));else resolve(Buffer.concat(chunks));});
  child.stdin.end(input);
 });
 const pg=(args:string[],input?:Buffer)=>docker(['exec','-i','-e','PGPASSWORD',container!,...args],input);
 function config(databaseUrl:string,storageDir:string,material=key){return readConfig({
  PLATFORM_DATABASE_URL:databaseUrl,PLATFORM_STORAGE_DIR:storageDir,PLATFORM_DATA_KEY:material,
  PLATFORM_ALLOW_PROVIDER_CALLS:'0',PLATFORM_REQUIRE_INVITE:'1',PLATFORM_REQUIRE_VERIFIED_EMAIL:'0',
  PLATFORM_ALLOWED_ORIGINS:'http://localhost:4321',PLATFORM_ENABLE_WORKBENCH:'0',
 });}
 type Actor={id:string;cookie:string;email:string};
 const headers=(actor:Actor)=>({origin:'http://localhost:4321',cookie:actor.cookie,[PLATFORM_ACCOUNT_HEADER]:actor.id});
 async function register(app:NonNullable<typeof source>,db:Database,label:string):Promise<Actor>{
  const email=randomUUID()+'@example.invalid';
  const result=await app.app.inject({method:'POST',url:'/api/platform/auth/register',headers:{origin:'http://localhost:4321'},
   payload:await fictionalRegistration(db,{name:label,email,password:'Fictional-recovery-password-123'})});
  assert.equal(result.statusCode,201);
  const cookie=result.headers['set-cookie'];assert.equal(typeof cookie,'string');
  return {id:result.json().user.id,cookie:(cookie as string).split(';')[0],email};
 }
 async function inventory(db:Database){
  const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename as string);
  assert(tables.length>100);const rows=[];
  for(const table of tables){
   assert(/^platform_[a-z0-9_]+$/.test(table));
   const r=(await db.query('SELECT count(*)::int count,md5(coalesce(string_agg(to_jsonb(t)::text,E\'\\n\' ORDER BY to_jsonb(t)::text),\'\')) digest FROM public."'+table+'" t')).rows[0];
   rows.push({table,...r});
  }
  return rows;
 }
 async function structure(db:Database){
  const queries={
   columns:"SELECT table_name,column_name,ordinal_position,data_type,udt_schema,udt_name,is_nullable,column_default,is_identity,is_generated,collation_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
   constraints:"SELECT r.relname AS table_name,c.conname,c.contype,pg_get_constraintdef(c.oid,true) AS definition FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public' ORDER BY r.relname,c.conname",
   indexes:"SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname",
   triggers:"SELECT r.relname AS table_name,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) AS definition FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY r.relname,t.tgname",
   functions:"SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.proname,args",
   enums:"SELECT t.typname,e.enumsortorder,e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' ORDER BY t.typname,e.enumsortorder",
  };
  const result:Record<string,unknown[]>={};for(const [name,query] of Object.entries(queries))result[name]=(await db.query(query)).rows;
  return result;
 }
 try{
  const imageId=(await docker(['image','inspect','postgres:17-alpine','--format','{{.Id}}'])).toString().trim();
  assert(/^sha256:[a-f0-9]{64}$/.test(imageId));
  container=(await docker(['create','--pull=never','--name',name,'--label','career-companion.recovery-drill='+name,
   '--memory','512m','--cpus','1','--pids-limit','256','--publish','127.0.0.1::5432','--env','POSTGRES_PASSWORD',imageId])).toString().trim();
  assert(/^[a-f0-9]{64}$/.test(container));
  await docker(['start',container]);
  const ports=JSON.parse((await docker(['inspect',container,'--format','{{json .NetworkSettings.Ports}}'])).toString())['5432/tcp'];
  assert.equal(ports.length,1);assert.equal(ports[0].HostIp,'127.0.0.1');assert(/^[0-9]+$/.test(ports[0].HostPort));
  const endpoint='postgresql://postgres:'+password+'@127.0.0.1:'+ports[0].HostPort+'/';
  admin=new Database(endpoint+'postgres',{max:1,connectionTimeoutMillis:500});
  const deadline=performance.now()+30_000;let ready=false;
  while(performance.now()<deadline){try{await admin.query('SELECT 1');ready=true;break;}catch{await new Promise(r=>setTimeout(r,200));}}
  assert(ready,'The isolated PostgreSQL instance did not become ready.');
  await admin.query('CREATE DATABASE recovery_source TEMPLATE template0');await admin.query('CREATE DATABASE recovery_target TEMPLATE template0');
  const sourceRoot=path.join(dir,'source-files'),targetRoot=path.join(dir,'restored-files');
  storage=await createRecoveryStorage(mode,dir,docker);
  sourceDb=new Database(endpoint+'recovery_source');await sourceDb.migrate();await seedFictionalActiveLegal(sourceDb);
  source=await buildApp({db:sourceDb,config:config(endpoint+'recovery_source',sourceRoot),storage:storage.source,runtime,legalBundle:FICTIONAL_LEGAL,enableQueue:false});
  const owner=await register(source,sourceDb,'Fictional recovery owner'),other=await register(source,sourceDb,'Fictional other owner');
  const bytes=Buffer.from('FICTIONAL RECOVERY RESUME\n中文课程项目：核对公开资料。\nOriginal contribution, no invented work.\n');
  const boundary='fixture-'+randomUUID();
  const upload=await source.app.inject({method:'POST',url:'/api/platform/uploads',headers:{...headers(owner),'content-type':'multipart/form-data; boundary='+boundary},
   payload:Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="fictional-resume.txt"\r\nContent-Type: text/plain\r\n\r\n'),bytes,Buffer.from('\r\n--'+boundary+'--\r\n')])});
  assert.equal(upload.statusCode,201);const fileId=upload.json().attachment.id;
  const created=await source.app.inject({method:'POST',url:'/api/platform/career/resume-versions/from-upload',headers:headers(owner),payload:{operationId:randomUUID(),expectedRevision:0,track:'da',label:'Fictional recovery original',uploadId:fileId,sha256:hash(bytes)}});
  assert.equal(created.statusCode,201);const original=created.json().view;
  const edited=await source.app.inject({method:'POST',url:'/api/platform/pending-items/'+original.item.id+'/revisions',headers:headers(owner),payload:{operationId:randomUUID(),expectedRevision:1,payloadDigest:original.item.payloadDigest,label:'Fictional corrected original',text:bytes.toString()+'A personally corrected line.'}});
  assert.equal(edited.statusCode,200);const revised=edited.json().view;
  const approval={operationId:randomUUID(),revision:revised.item.revision,payloadDigest:revised.item.payloadDigest,decision:'approve'};
  const approved=await source.app.inject({method:'POST',url:'/api/platform/pending-items/'+original.item.id+'/decision',headers:headers(owner),payload:approval});
  assert.equal(approved.statusCode,200);const expected=approved.json().view;
  assert.equal(expected.item.status,'approved');
  const schemaBefore=await structure(sourceDb),before=await inventory(sourceDb);
  // Quiesce this source before its database/file pair is captured.
  await source.app.close();source=undefined;await sourceDb.close();sourceDb=undefined;
  times.prepareMs=Math.round(performance.now()-started);
  const dumpStarted=performance.now();
  const dump=await pg(['pg_dump','--username=postgres','--dbname=recovery_source','--format=custom','--no-owner','--no-privileges']);
  assert(dump.subarray(0,5).equals(Buffer.from('PGDMP')));
  assert(!dump.includes(Buffer.from('FICTIONAL RECOVERY RESUME')));
  await fs.writeFile(path.join(dir,'database.dump'),dump,{mode:0o600});
  const files=await storage.backup();assert.equal(files.length,1);assert.equal(files[0].sha256,hash(bytes));
  await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify({databaseSha256:hash(dump),files}),{mode:0o600});
  times.backupMs=Math.round(performance.now()-dumpStarted);
  // Make the source unavailable. Reads after this point cannot accidentally
  // succeed by using the original database or the original blob directory.
  await admin.query('DROP DATABASE recovery_source');await storage.destroySource();
  const restoreStarted=performance.now();
  const backup=await fs.readFile(path.join(dir,'database.dump'));
  const manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'));
  assert.equal(hash(backup),manifest.databaseSha256);
  await admin.query('CREATE DATABASE recovery_broken TEMPLATE template0');
  await assert.rejects(pg(['pg_restore','--username=postgres','--dbname=recovery_broken','--no-owner','--no-privileges','--single-transaction','--exit-on-error'],backup.subarray(0,Math.floor(backup.length/2))));
  const broken=new Database(endpoint+'recovery_broken');
  try{assert.equal((await broken.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0);}finally{await broken.close();}
  await pg(['pg_restore','--username=postgres','--dbname=recovery_target','--no-owner','--no-privileges','--single-transaction','--exit-on-error'],backup);
  await storage.restore();
  assert.deepEqual(await storage.targetManifest(),manifest.files);
  restoredDb=new Database(endpoint+'recovery_target');
  assert.deepEqual(await inventory(restoredDb),before);
  assert.deepEqual(await structure(restoredDb),schemaBefore);
  // Do not run migrations on the target: restore must include the whole schema,
  // migration ledger, constraints, history and triggers on its own.
  restored=await buildApp({db:restoredDb,config:config(endpoint+'recovery_target',targetRoot),storage:storage.target,runtime,legalBundle:FICTIONAL_LEGAL,enableQueue:false});
  const read=await restored.app.inject({url:'/api/platform/pending-items/'+original.item.id,headers:headers(owner)});
  assert.equal(read.statusCode,200);assert.deepEqual(read.json().view??read.json(),expected);
  const download=await restored.app.inject({url:'/api/platform/uploads/'+fileId,headers:headers(owner)});
  assert.equal(download.statusCode,200);assert.deepEqual(download.rawPayload,bytes);assert.equal(download.headers['cache-control'],'private, no-store');
  assert.equal((await restored.app.inject({url:'/api/platform/uploads/'+fileId,headers:headers(other)})).statusCode,404);
  assert.equal((await restored.app.inject({url:'/api/platform/uploads/'+fileId})).statusCode,401);
  assert.equal((await restored.app.inject({url:'/api/platform/pending-items/'+original.item.id,headers:headers(other)})).statusCode,404);
  const replay=await restored.app.inject({method:'POST',url:'/api/platform/pending-items/'+original.item.id+'/decision',headers:headers(owner),payload:approval});
  assert.equal(replay.statusCode,200);assert.equal(replay.json().operation.replayed,true);assert.deepEqual(replay.json().view,expected);
  assert.equal((await restoredDb.query('SELECT count(*)::int n FROM platform_pending_item_decisions')).rows[0].n,1);
  const history=await restored.resumeReview.revision({userId:owner.id,tokenHash:(await restoredDb.query('SELECT token_hash FROM platform_sessions WHERE user_id=$1',[owner.id])).rows[0].token_hash},original.item.id,1);
  assert.equal(history.payload.text,original.payload.text);
  await assert.rejects(restoredDb.query("UPDATE platform_pending_item_decisions SET channel='discord'"),'The restored immutable-history trigger must still reject updates.');
  const wrongKey=config(endpoint+'recovery_target',targetRoot,randomBytes(32).toString('hex')).dataCrypto!;
  const sealed=(await restoredDb.query('SELECT record_ciphertext FROM platform_pending_items WHERE id=$1',[original.item.id])).rows[0].record_ciphertext;
  const binding={table:'platform_pending_items',column:'record_ciphertext',rowId:original.item.id,ownerId:owner.id,revision:expected.item.generation};
  assert.equal(JSON.parse(config(endpoint+'recovery_target',targetRoot).dataCrypto!.openUtf8(sealed,binding)).id,original.item.id);
  assert.throws(()=>wrongKey.openUtf8(sealed,binding));
  // Manifest detects equal-length blob corruption before reopening a recovered site.
  const corrupt=Buffer.from(bytes);corrupt[0]^=1;
  await storage.corrupt(files[0],corrupt);assert.notDeepEqual(await storage.targetManifest(),manifest.files);
  await storage.repair(files[0]);assert.deepEqual(await storage.targetManifest(),manifest.files);
  await storage.remove(files[0]);
  assert.equal((await restored.app.inject({url:'/api/platform/uploads/'+fileId,headers:headers(owner)})).statusCode,404);
  await storage.repair(files[0]);
  // Restored old sessions are valid until explicitly revoked; exercise the
  // recovery runbook step before admitting any new traffic.
  await restoredDb.transaction(async c=>{await c.query('UPDATE platform_users SET auth_version=auth_version+1');await c.query('DELETE FROM platform_sessions');});
  assert.equal((await restored.app.inject({url:'/api/platform/pending-items/'+original.item.id,headers:headers(owner)})).statusCode,401);
  const login=await restored.app.inject({method:'POST',url:'/api/platform/auth/login',headers:{origin:'http://localhost:4321'},payload:{email:owner.email,password:'Fictional-recovery-password-123'}});
  assert.equal(login.statusCode,200);
  const fresh={...owner,cookie:(login.headers['set-cookie'] as string).split(';')[0]};
  assert.equal((await restored.app.inject({url:'/api/platform/pending-items/'+original.item.id,headers:headers(fresh)})).statusCode,200);
  assert.equal(calls,0);
  times.restoreAndVerifyMs=Math.round(performance.now()-restoreStarted);
  t.diagnostic(JSON.stringify({scope:'fictional_local_postgres_and_'+mode,storage:storage.evidence,imageId,tables:before.length,rows:before.reduce((n,v)=>n+v.count,0),files:files.length,externalCalls:calls,timings:times,productionReady:false}));
 }finally{
  const failures:unknown[]=[];
  for(const close of [()=>source?.app.close(),()=>restored?.app.close(),()=>sourceDb?.close(),()=>restoredDb?.close(),()=>admin?.close()]){
   try{await close();}catch(e){failures.push(e);}
  }
  if(storage){try{await storage.close();}catch(e){failures.push(e);}}
  if(container){try{await docker(['rm','--force','--volumes',container]);}catch(e){failures.push(e);}}
  try{await fs.rm(dir,{recursive:true,force:true});}catch(e){failures.push(e);}
  assert.equal(failures.length,0,'Recovery fixture cleanup was incomplete; inspect the UUID-named drill resources before retrying.');
 }
}
