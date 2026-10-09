import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Database} from '../src/database.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {McpConnections} from '../src/mcp-connections.ts';
import {mcpSchemaHash,type McpCatalogConfig} from '../src/mcp-config.ts';
import type {McpTransport} from '../src/mcp-transport-port.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,encoded:string;
const password='Fictional-mcp-export-password';
before(async()=>{f=await createCompanionNameSafetyFixture();encoded=await hashPassword(password);});
after(async()=>{await f?.close();});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
const proof=async(who:FixedSessionContext)=>(await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;
const capture=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await proof(who));
const consumed=async(who:FixedSessionContext)=>(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows[0].consumed_at;
function fixture(){
 const inputSchema={type:'object',properties:{query:{type:'string',default:'fictional-schema-default-private'}},additionalProperties:false};
 const config:McpCatalogConfig={entries:[{id:'fictional-catalog',name:'Fictional personal MCP connection',url:'https://fictional-mcp.example.invalid/private-endpoint',bearerToken:'fictional-service-key',tools:[{name:'fictional_search',schemaHash:mcpSchemaHash(inputSchema)}]}],fixtureOrigins:[]};
 let discoveries=0,calls=0;
 const transport:McpTransport={async discover(){discoveries++;return [{name:'fictional_search',description:'Fictional untrusted tool description',inputSchema}];},async call(){calls++;throw Error('No tool execution permitted by this fixture.');}};
 const service=new McpConnections(f.db,config,transport);return {service,config,counts:()=>({discoveries,calls}),connect:(who:FixedSessionContext)=>service.connect(who.userId,{catalogId:config.entries[0].id})};
}
// Explicit synthetic retained receipts, not evidence of an actual approved RPC
// or verified result body. Existing service integration tests cover execution.
async function receipt(who:FixedSessionContext,connectionId:string,status='started'){
 const job=randomUUID(),artifact=['completed','tool_error'].includes(status)?randomUUID():null;
 await f.db.query("INSERT INTO platform_jobs(id,user_id,kind,provider,prompt,status,requires_approval) VALUES($1,$2,'mcp','mcp','Fictional task body not projected here','running',true)",[job,who.userId]);
 if(artifact)await f.db.query("INSERT INTO platform_artifacts(id,user_id,job_id,kind,mime,filename,metadata) VALUES($1,$2,$3,'mcp','application/json','fictional-result.json',$4)",[artifact,who.userId,job,JSON.stringify({privateResultBody:'fictional-result-not-loaded'})]);
 await f.db.query(`INSERT INTO platform_mcp_receipts(job_id,user_id,connection_id,generation,grant_version,tool_name,schema_hash,definition_hash,arguments_hash,status,artifact_id,response_hash,error_code,finished_at)
  VALUES($1,$2,$3,1,1,'fictional_search',$4,$5,$6,$7,$8,$9,$10,CASE WHEN $7='started' THEN NULL ELSE now() END)`,[job,who.userId,connectionId,'a'.repeat(64),'b'.repeat(64),'c'.repeat(64),status,artifact,artifact?'d'.repeat(64):null,status==='tool_error'?'MCP_TOOL_ERROR':status==='uncertain'?'EXECUTION_INTERRUPTED':null]);return {job,artifact};
}
function instrument(transform:(sql:string,rows:Record<string,any>[])=>void|Promise<void>):Database{return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
 if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await transform(sql,result.rows);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}})),options)} as Database;}
const connectionRead=(sql:string)=>sql.startsWith('SELECT id,user_id,catalog_id,name,status,grant_version,tools');
const receiptRead=(sql:string)=>sql.startsWith('SELECT r.job_id,r.user_id,r.connection_id,r.generation');
async function snapshot(who:FixedSessionContext){const data:Record<string,unknown>={};for(const table of ['mcp_connections','mcp_receipts','jobs','artifacts'])data[table]=(await f.db.query(`SELECT row_to_json(t)::text AS value FROM platform_${table} t WHERE user_id=$1 ORDER BY row_to_json(t)::text`,[who.userId])).rows;return data;}

test('actual discovered connection metadata excludes service configuration, schema defaults and authorization hashes',async context=>{
 context.mock.method(globalThis,'fetch',async()=>{throw Error('No external requests are permitted.');});
 const who=await actor(),other=await actor(),m=fixture(),connection=await m.connect(who),foreign=await m.connect(other);await receipt(who,connection.connectionId!,'completed');const otherCall=await receipt(other,foreign.connectionId!,'completed');
 const counts=m.counts(),before=await snapshot(who),queries:string[]=[],result=await new AccountCoreExport(instrument(sql=>{queries.push(sql);}),f.config).capture(who,await proof(who));
 assert.equal(result.sections.mcpConnections.length,1);assert.equal(result.sections.mcpReceipts.length,1);const row=result.sections.mcpConnections[0] as any,call=result.sections.mcpReceipts[0] as any;
 assert.equal(row.id,connection.connectionId);assert.equal(row.storedStatus,'connected');assert.equal(row.grantVersion,1);assert.deepEqual(row.tools,[{name:'fictional_search',description:'Fictional untrusted tool description',authorization:'reviewed_read_only',provenance:'untrusted_mcp_definition'}]);
 assert.equal(call.storedStatus,'completed');assert.equal(call.resultIncluded,false);assert.equal(typeof call.artifactId,'string');
 assert.equal((result.sections.jobs[0] as any).definition.prompt,'Fictional task body not projected here');assert(!JSON.stringify([row,call]).includes('Fictional task body not projected here'));
 for(const secret of [who.tokenHash,password,encoded,other.userId,foreign.connectionId!,otherCall.job,'fictional-schema-default-private','fictional-service-key','fictional-mcp.example.invalid','fictional-result-not-loaded','a'.repeat(64),'b'.repeat(64),'c'.repeat(64),'d'.repeat(64)])assert(!JSON.stringify(result).includes(secret));
 assert(!queries.filter(sql=>connectionRead(sql)||receiptRead(sql)).some(sql=>/policy_hash|definition_hash|arguments_hash|response_hash|execution_policy/.test(sql)));assert.deepEqual(m.counts(),counts);assert.deepEqual(await snapshot(who),before);
 assert(Object.isFrozen(row.tools[0]));assert.equal(result.includedTables.length,95);assert.equal(result.complete,false);assert.equal(result.filesIncluded,false);assert(result.remainingTables.includes('platform_artifacts'));
});

test('revocation and removed live catalog do not rewrite historical grants or trigger discovery',async()=>{
 const who=await actor(),m=fixture(),connection=await m.connect(who);await receipt(who,connection.connectionId!,'uncertain');await m.service.revoke(who.userId,connection.connectionId!,{expectedGrantVersion:1});m.config.entries=[];
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[who.userId]);
 const counts=m.counts(),before=await snapshot(who),result=await capture(who),row=result.sections.mcpConnections[0] as any,call=result.sections.mcpReceipts[0] as any;
 assert.equal(row.storedStatus,'revoked');assert.equal(row.grantVersion,2);assert.equal(row.tools.length,1);assert.equal(call.grantVersion,1);assert.equal(call.storedStatus,'uncertain');assert.equal(call.errorCode,'EXECUTION_INTERRUPTED');assert.deepEqual(m.counts(),counts);assert.deepEqual(await snapshot(who),before);
});

test('all four stored receipt outcomes remain unchanged without result loading, recovery or retries',async()=>{
 const who=await actor(),m=fixture(),connection=await m.connect(who);for(const state of ['started','completed','tool_error','uncertain'])await receipt(who,connection.connectionId!,state);
 const before=await snapshot(who),result=await capture(who),rows=result.sections.mcpReceipts as any[];assert.deepEqual(rows.map(r=>r.storedStatus).sort(),['completed','started','tool_error','uncertain']);
 assert.equal(rows.find(r=>r.storedStatus==='started').finishedAt,null);assert.equal(rows.find(r=>r.storedStatus==='tool_error').errorCode,'MCP_TOOL_ERROR');assert(rows.every(r=>r.resultIncluded===false));assert.deepEqual(await snapshot(who),before);assert.equal(m.counts().calls,0);
});

test('105 retained historical catalogs and receipts survive independent pagination',async()=>{
 const who=await actor(),m=fixture(),ids:string[]=[];for(let i=0;i<105;i++){m.config.entries[0].id='fictional-catalog-'+i;const connection=await m.connect(who);ids.push(connection.connectionId!);await receipt(who,connection.connectionId!);}
 const queries:string[]=[],before=m.counts(),result=await new AccountCoreExport(instrument(sql=>{queries.push(sql);}),f.config).capture(who,await proof(who));assert.deepEqual((result.sections.mcpConnections as any[]).map(r=>r.id),ids.sort());assert.equal(result.sections.mcpReceipts.length,105);
 assert.equal(queries.filter(connectionRead).length,2);assert.equal(queries.filter(receiptRead).length,2);assert.deepEqual(m.counts(),before);
});

test('real foreign connection, job and artifact associations reject the entire export and preserve the proof',async()=>{
 const who=await actor(),other=await actor(),m=fixture(),connection=await m.connect(who),foreign=await m.connect(other),own=await receipt(who,connection.connectionId!,'completed'),foreignCall=await receipt(other,foreign.connectionId!,'completed'),token=await proof(who);
 const reject=async()=>{await assert.rejects(new AccountCoreExport(f.db,f.config).capture(who,token),{code:'ACCOUNT_MCP_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);};
 await f.db.query('UPDATE platform_mcp_receipts SET connection_id=$2 WHERE job_id=$1',[own.job,foreign.connectionId]);await reject();await f.db.query('UPDATE platform_mcp_receipts SET connection_id=$2 WHERE job_id=$1',[own.job,connection.connectionId]);
 await f.db.query('UPDATE platform_jobs SET user_id=$2 WHERE id=$1',[own.job,other.userId]);await reject();await f.db.query('UPDATE platform_jobs SET user_id=$2 WHERE id=$1',[own.job,who.userId]);
 await f.db.query('UPDATE platform_mcp_receipts SET artifact_id=$2 WHERE job_id=$1',[own.job,foreignCall.artifact]);await reject();await f.db.query('UPDATE platform_mcp_receipts SET artifact_id=$2 WHERE job_id=$1',[own.job,own.artifact]);
 await f.db.query('UPDATE platform_artifacts SET job_id=$2 WHERE id=$1',[own.artifact,foreignCall.job]);await reject();await f.db.query('UPDATE platform_artifacts SET job_id=$2 WHERE id=$1',[own.artifact,own.job]);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.mcpReceipts.length,1);
});

test('one MVCC snapshot preserves the prior stored grant during an actual concurrent revoke',async()=>{
 const who=await actor(),m=fixture(),connection=await m.connect(who);await receipt(who,connection.connectionId!);let revoked=false;
 const result=await new AccountCoreExport(instrument(async sql=>{if(!revoked&&connectionRead(sql)){revoked=true;await m.service.revoke(who.userId,connection.connectionId!,{expectedGrantVersion:1});}}),f.config).capture(who,await proof(who));
 assert(revoked);assert.equal((result.sections.mcpConnections[0] as any).storedStatus,'connected');assert.equal((result.sections.mcpConnections[0] as any).grantVersion,1);assert.equal((await m.service.list(who.userId))[0].status,'revoked');
});

test('unknown tool shape, malformed states and cross-owner rows fail closed without releasing partial data',async()=>{
 const who=await actor(),m=fixture(),connection=await m.connect(who);await receipt(who,connection.connectionId!);const token=await proof(who);
 const cases:[(sql:string)=>boolean,(row:any)=>void][]=[[connectionRead,r=>{r.tools[0].secret='fictional-unknown-field';}],[connectionRead,r=>{r.tools.push(r.tools[0]);}],[connectionRead,r=>{r.user_id=randomUUID();}],[receiptRead,r=>{r.job_kind='browser';}],[receiptRead,r=>{r.status='complete';}],[receiptRead,r=>{r.finished_at=new Date();}],[receiptRead,r=>{r.error_code='fictional raw error body';}]];
 for(const [match,change] of cases){let reached=false;await assert.rejects(new AccountCoreExport(instrument((sql,rows)=>{if(match(sql)&&rows.length){reached=true;change(rows[0]);}}),f.config).capture(who,token),{code:'ACCOUNT_MCP_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await consumed(who),null);}
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.mcpConnections.length,1);
});

test('empty metadata stays empty and cancellation during receipts allows a clean authenticated retry',async()=>{
 const who=await actor(),empty=await capture(who);assert.deepEqual(empty.sections.mcpConnections,[]);assert.deepEqual(empty.sections.mcpReceipts,[]);
 const m=fixture(),connection=await m.connect(who);await receipt(who,connection.connectionId!);const token=await proof(who),controller=new AbortController();
 await assert.rejects(new AccountCoreExport(instrument(sql=>{if(receiptRead(sql))controller.abort();}),f.config).capture(who,token,controller.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});assert.equal(await consumed(who),null);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.mcpReceipts.length,1);
});
