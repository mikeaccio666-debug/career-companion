import { seedFictionalConsent } from './fixtures/student-entry.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal } from './fixtures/student-entry.ts';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Worker } from 'bullmq';
import type { CreateJobInput, JobExecutionContext, PlatformProviderRuntime } from '@companion/platform-contracts';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { LocalBlobStorage } from '../src/storage.ts';
import { ApiError } from '../src/errors.ts';
import { JobService, TaskQueue, connectionFromUrl, createWorker, jobDefinitionHash, processJob, recoverInterrupted } from '../src/jobs.ts';
import { ProducerQueue, QUEUE_DISPATCH_TIMEOUT_MS } from '../src/queue-connection.ts';

const base=readConfig({ ...process.env, PLATFORM_ENABLE_WORKBENCH: '1' ,PLATFORM_REQUIRE_INVITE:'1'}),schema=`queue_recovery_${randomUUID().replaceAll('-','')}`,admin=new Database(base.databaseUrl);
const url=new URL(base.databaseUrl);url.searchParams.set('options',`-c search_path=${schema}`);
const db=new Database(url.toString());let directory:string;
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await db.migrate(); await seedFictionalActiveLegal(db);directory=await fs.mkdtemp(path.join(os.tmpdir(),'queue-recovery-fixtures-'));});
after(async()=>{await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();if(directory)await fs.rm(directory,{recursive:true,force:true});});
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function eventually(check:()=>Promise<boolean>|boolean,message:string,ms=5_000){const until=Date.now()+ms;while(!await check()){if(Date.now()>until)assert.fail(message);await delay(25);}}
function code(name:string){return (error:unknown)=>error instanceof ApiError&&error.code===name;}
function fixture(redisUrl=base.redisUrl){
  const calls:{input:CreateJobInput;context:JobExecutionContext}[]=[],users:string[]=[],queueName=`queue-recovery-${randomUUID()}`;
  let execute:((input:CreateJobInput,context:JobExecutionContext)=>Promise<any>)|undefined;
  const runtime:PlatformProviderRuntime={
    capabilities:()=>[{id:'fixture',name:'Fictional queue runtime',keyConfigured:true,enabled:true,capabilities:['chat','image','cli'],models:['fictional'],modelsByCapability:{chat:['fictional']},envVariables:[]},{id:'workflow',name:'Fictional workflow runtime',keyConfigured:true,enabled:true,capabilities:['workflow'],models:[],envVariables:[]},{id:'fal',name:'Fictional asynchronous runtime',keyConfigured:true,enabled:true,capabilities:['video'],models:['fictional'],envVariables:[]}],
    async *streamChat(){throw new Error('The queue fixture never calls a model.');},
    async executeJob(input,context){calls.push({input,context});return execute?execute(input,context):{text:'Fictional queue result; no model was called.',artifacts:[]};},
    createVoiceSession:async()=>{throw new Error('unused');},transcribe:async()=>({text:''}),speech:async()=>{throw new Error('unused');},
  };
  const jobs=new JobService(db,{...base,databaseUrl:url.toString(),redisUrl,storageDir:directory,queueName},runtime,new LocalBlobStorage(directory),undefined,undefined,FICTIONAL_LEGAL);
  const queue=new TaskQueue(jobs),control=new ProducerQueue(queueName,base.redisUrl);const workers:Worker[]=[];
  return {jobs,queue,control,calls,queueName,setExecute(value:typeof execute){execute=value;},
    async user(){const id=randomUUID();users.push(id);await db.query('INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[id,`${id}@example.invalid`,'Fictional queue owner','not-a-real-password-hash']); await seedFictionalConsent(db,id);return id;},
    async create(kind:CreateJobInput['kind']='image',provider='fixture'){const uid=await this.user(),result=await jobs.create(uid,{kind,provider,prompt:'Fictional execution input',...(kind==='workflow'?{options:{steps:[{kind:'chat',provider:'fixture',prompt:'Fictional step'}]}}:{})});if(result.approval)await jobs.decide(uid,result.approval.id,'approved');return {uid,...result};},
    worker(){const worker=createWorker(jobs);worker.on('error',()=>{});workers.push(worker);return worker;},
    track(worker:Worker){worker.on('error',()=>{});workers.push(worker);return worker;},
    async loss(){// Delete EVERY key of this fictional queue, never FLUSHDB or another task's namespace.
      await control.obliterate({force:true});await db.query("UPDATE platform_job_outbox SET dispatched_at=now()-interval '1 minute'");
    },
    async close(){for(const worker of workers)await worker.close();await queue.close();await control.obliterate({force:true});await control.close();if(users.length)await db.query('DELETE FROM platform_users WHERE id=ANY($1::uuid[])',[users]);},
  };
}
async function row(id:string){return (await db.query('SELECT * FROM platform_jobs WHERE id=$1',[id])).rows[0];}
async function age(id:string){await db.query("UPDATE platform_job_outbox SET dispatched_at=now()-interval '1 minute' WHERE job_id=$1",[id]);}

/** Actual TCP transport to the local Redis fixture, with controllable stalls/latency and physical socket tracking. */
async function proxy(){
  const target=new URL(base.redisUrl),sockets=new Set<net.Socket>(),timers=new Set<NodeJS.Timeout>();let drop=false,latency=0,connections=0;
  const server=net.createServer(client=>{
    connections++;const upstream=net.connect({host:target.hostname,port:Number(target.port||6379)});sockets.add(client);sockets.add(upstream);
    client.on('error',()=>{});upstream.on('error',()=>client.destroy());
    client.on('data',bytes=>{if(!drop&&!upstream.destroyed)upstream.write(bytes);});
    upstream.on('data',bytes=>{
      if(!latency){if(!client.destroyed)client.write(bytes);return;}
      const timer=setTimeout(()=>{timers.delete(timer);if(!client.destroyed)client.write(bytes);},latency);timers.add(timer);
    });
    client.on('close',()=>{sockets.delete(client);upstream.destroy();});upstream.on('close',()=>{sockets.delete(upstream);client.destroy();});
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');
  const endpoint=new URL(base.redisUrl);endpoint.hostname='127.0.0.1';endpoint.port=String(address.port);
  return {url:endpoint.toString(),sockets,connections:()=>connections,setDrop:(value:boolean)=>{drop=value;},setLatency:(value:number)=>{latency=value;},
    async close(){for(const timer of timers)clearTimeout(timer);timers.clear();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));},
  };
}

test('producer and blocking worker have separate finite/infinite reconnect policies',()=>{
  const producer=connectionFromUrl(base.redisUrl,'producer'),worker=connectionFromUrl(base.redisUrl,'worker');
  assert.equal(producer.maxRetriesPerRequest,1);assert.equal(producer.enableOfflineQueue,false);assert.equal(producer.autoResendUnfulfilledCommands,false);
  assert.equal(producer.commandTimeout,1500);assert.equal(worker.maxRetriesPerRequest,null);assert.equal(worker.commandTimeout,undefined);
});

test('lost Redis namespace reconstructs only authorized unstarted notifications and executes once under duplicate deliveries',async()=>{
  const f=fixture();try{
    const item=await f.create();await f.queue.dispatch();const original=(await db.query('SELECT definition_hash,dispatched_at FROM platform_job_outbox WHERE job_id=$1',[item.job.id])).rows[0];assert(original.dispatched_at);assert.match(original.definition_hash,/^[a-f0-9]{64}$/);
    await f.loss();assert.equal(await f.control.getJob(`${item.job.id}-1`),undefined);
    await f.queue.dispatch();await age(item.job.id);await Promise.all([f.queue.dispatch(),f.queue.dispatch(),f.queue.dispatch()]);assert.equal(await f.control.getWaitingCount(),1);
    const notification=await f.control.getJob(`${item.job.id}-1`);assert.equal(notification?.data.definitionHash,original.definition_hash);assert(!JSON.stringify(notification?.data).includes('Fictional execution input'));
    f.worker();await eventually(async()=>(await f.jobs.get(item.uid,item.job.id)).status==='succeeded','Recovered task did not complete');
    await processJob(f.jobs,item.job.id,1,original.definition_hash);assert.equal(f.calls.length,1);assert.equal((await db.query('SELECT id FROM platform_job_attempts WHERE job_id=$1',[item.job.id])).rowCount,1);
  }finally{await f.close();}
});

test('reconciliation keeps an existing waiting or active-before-claim notification and does not steal its BullMQ lock',async()=>{
  const f=fixture();let release:()=>void=()=>{};try{
    const item=await f.create();await f.queue.dispatch();await age(item.job.id);await f.queue.dispatch();assert.equal(await f.control.getWaitingCount(),1);
    const gate=new Promise<void>(resolve=>{release=resolve;});
    f.track(new Worker(f.queueName,async job=>{await gate;await processJob(f.jobs,job.data.jobId,job.data.generation,job.data.definitionHash);},{connection:connectionFromUrl(base.redisUrl),maxStalledCount:0}));
    await eventually(async()=>(await f.control.getJob(`${item.job.id}-1`))?.getState().then(state=>state==='active')??false,'Notification never became active');
    assert.equal((await row(item.job.id)).status,'queued');await age(item.job.id);await f.queue.dispatch();assert.equal(await f.control.getActiveCount(),1);assert.equal(f.calls.length,0);
    release();await eventually(async()=>(await row(item.job.id)).status==='succeeded','Active notification did not complete');assert.equal(f.calls.length,1);
  }finally{release();await f.close();}
});

test('a terminal notification failed before a database claim can be safely rebuilt with the same generation and digest',async()=>{
  const f=fixture();try{
    const item=await f.create();await f.queue.dispatch();const worker=f.track(new Worker<any,any>(f.queueName,async()=>{throw new Error('Fictional pre-claim worker failure');},{connection:connectionFromUrl(base.redisUrl),maxStalledCount:0}));
    await eventually(async()=>(await f.control.getJob(`${item.job.id}-1`))?.getState().then(state=>state==='failed')??false,'Pre-claim notification did not fail');await worker.close();
    assert.equal((await db.query('SELECT id FROM platform_job_attempts WHERE job_id=$1',[item.job.id])).rowCount,0);
    await age(item.job.id);await f.queue.dispatch();assert.equal(await (await f.control.getJob(`${item.job.id}-1`))?.getState(),'waiting');f.worker();await eventually(async()=>(await row(item.job.id)).status==='succeeded','Rebuilt pre-claim task did not finish');assert.equal(f.calls.length,1);
  }finally{await f.close();}
});

test('Redis loss rejects revoked/wrong-owner approval, changed frozen input, unknown workflow and any current-generation execution evidence',async()=>{
  const f=fixture();try{
    const revoked=await f.create('cli'),foreign=await f.create('cli'),changed=await f.create(),unknown=await f.create('workflow','workflow'),attempt=await f.create(),lease=await f.create(),relay=await f.create('cli'),held=await f.create();
    await f.queue.dispatch();await f.loss();
    await db.query("UPDATE platform_approvals SET status='rejected' WHERE job_id=$1",[revoked.job.id]);await db.query('UPDATE platform_approvals SET user_id=$2 WHERE job_id=$1',[foreign.job.id,revoked.uid]);await db.query("UPDATE platform_jobs SET prompt='Changed unreviewed input' WHERE id=$1",[changed.job.id]);
    await db.query('UPDATE platform_workflow_checkpoints SET revision=1,steps=$2 WHERE job_id=$1',[unknown.job.id,JSON.stringify([{index:0,inputHash:'a'.repeat(64),state:'uncertain',errorCode:'EXECUTION_INTERRUPTED'}])]);
    await db.query("INSERT INTO platform_job_attempts(id,job_id,generation,attempt,status) VALUES($1,$2,1,1,'uncertain')",[randomUUID(),attempt.job.id]);
    await db.query("UPDATE platform_jobs SET lease_token=$2,lease_until=now()+interval '1 minute' WHERE id=$1",[lease.job.id,randomUUID()]);
    await db.query("INSERT INTO platform_model_relay_requests(id,user_id,job_id,generation,request_id,model,reserved_tokens,status) VALUES($1,$2,$3,1,'fictional-reservation','fictional',1,'reserved')",[randomUUID(),relay.uid,relay.job.id]);
    await db.query("UPDATE platform_jobs SET status='uncertain' WHERE id=$1",[held.job.id]);
    await f.queue.dispatch();assert.equal(await f.control.getWaitingCount(),0);assert.equal(f.calls.length,0);
    assert.equal((await row(revoked.job.id)).status,'needs_approval');assert.equal((await row(foreign.job.id)).status,'needs_approval');assert.equal((await row(changed.job.id)).error_code,'JOB_DEFINITION_CHANGED');
    for(const item of [unknown,attempt,lease,relay,held])assert.equal((await row(item.job.id)).status,'uncertain');assert((await row(lease.job.id)).lease_token,'Unconfirmed lease must not be silently discarded.');
  }finally{await f.close();}
});

test('worker claim rechecks frozen digest, generation and full current approval before any runtime call',async()=>{
  const f=fixture();try{
    const mutated=await f.create('cli');await db.query("UPDATE platform_approvals SET args=jsonb_set(args,'{prompt}','\"Unreviewed approval input\"') WHERE job_id=$1",[mutated.job.id]);await processJob(f.jobs,mutated.job.id,1);assert.equal(f.calls.length,0);
    const wrong=await f.create();await processJob(f.jobs,wrong.job.id,1,'f'.repeat(64));assert.equal((await row(wrong.job.id)).error_code,'JOB_DEFINITION_CHANGED');assert.equal(f.calls.length,0);
    const retried=await f.create();const first=jobDefinitionHash(await row(retried.job.id));await db.query("UPDATE platform_jobs SET status='failed' WHERE id=$1",[retried.job.id]);await f.jobs.retry(retried.uid,retried.job.id);const second=jobDefinitionHash(await row(retried.job.id));assert.notEqual(first,second);
    await processJob(f.jobs,retried.job.id,1,first);assert.equal(f.calls.length,0);assert.equal((await row(retried.job.id)).status,'queued');await processJob(f.jobs,retried.job.id,2,second);assert.equal(f.calls.length,1);
  }finally{await f.close();}
});

test('legacy NULL digest is fixed only from an authorized generation with no execution evidence',async()=>{
  const f=fixture();try{
    const fresh=await f.create('cli'),unsafe=await f.create();await db.query('UPDATE platform_job_outbox SET definition_hash=NULL');
    await db.query("INSERT INTO platform_job_attempts(id,job_id,generation,attempt,status) VALUES($1,$2,1,1,'uncertain')",[randomUUID(),unsafe.job.id]);
    await f.queue.dispatch();const result=await db.query('SELECT job_id,definition_hash FROM platform_job_outbox');assert.equal(result.rows.find(entry=>entry.job_id===fresh.job.id).definition_hash,jobDefinitionHash(await row(fresh.job.id)));assert.equal(result.rows.find(entry=>entry.job_id===unsafe.job.id).definition_hash,null);assert.equal(await f.control.getWaitingCount(),1);
  }finally{await f.close();}
});

test('an approved prior-generation known provider handle resumes by polling after Redis loss without another submission',async()=>{
  const f=fixture();try{
    const item=await f.create('video','fal');let submissions=0,polls=0;
    f.setExecute(async(_input,ctx)=>{if(!ctx.previousProviderTaskId){submissions++;await ctx.onProviderTask?.('fictional-saved-handle');throw new ApiError(503,'PROVIDER_UNREACHABLE','Fictional interrupted poll.');}polls++;assert.equal(ctx.previousProviderTaskId,'fictional-saved-handle');return {text:'Fictional completed polling result',artifacts:[]};});
    await processJob(f.jobs,item.job.id,1);assert.equal(submissions,1);await db.query("UPDATE platform_jobs SET status='running',requires_approval=true,lease_token=$2,lease_until=now()-interval '1 second' WHERE id=$1",[item.job.id,randomUUID()]);
    await recoverInterrupted(f.jobs);const approval=(await db.query('SELECT id FROM platform_approvals WHERE job_id=$1 AND generation=2',[item.job.id])).rows[0];await f.jobs.decide(item.uid,approval.id,'approved');
    await f.queue.dispatch();await f.loss();await f.queue.dispatch();f.worker();await eventually(async()=>(await row(item.job.id)).status==='succeeded','Known provider handle did not resume');assert.equal(submissions,1);assert.equal(polls,1);
  }finally{await f.close();}
});

test('a stalled real Redis socket rejects in finite time, drains its PG transaction and cannot replay commands on reconnect',async()=>{
  const wire=await proxy(),f=fixture(wire.url);try{
    const item=await f.create();await f.queue.queue.waitUntilReady();await f.queue.queue.getWaitingCount();wire.setDrop(true);
    const started=Date.now(),dispatch=f.queue.dispatch();assert.equal(f.queue.dispatch(),dispatch);await assert.rejects(dispatch,code('QUEUE_UNAVAILABLE'));assert(Date.now()-started<4_000);
    await eventually(()=>wire.sockets.size===0,'Timed-out producer left real TCP sockets open');assert.equal(db.pool.totalCount-db.pool.idleCount,0);
    assert.equal((await db.query('SELECT dispatched_at FROM platform_job_outbox WHERE job_id=$1',[item.job.id])).rows[0].dispatched_at,null);wire.setDrop(false);await delay(300);assert.equal(await f.control.getWaitingCount(),0,'A failed producer must not replay its buffered command later.');
    await f.queue.dispatch();assert.equal(await f.control.getWaitingCount(),1);assert.equal(wire.connections(),2);
  }finally{await f.close();await wire.close();}
});

test('the whole-batch deadline physically closes a slow producer and single-flight prevents timer/pool stampede',async()=>{
  const wire=await proxy(),f=fixture(wire.url);try{
    for(let i=0;i<14;i++)await f.create();await f.queue.queue.waitUntilReady();await f.queue.queue.getWaitingCount();wire.setLatency(350);
    const started=Date.now(),dispatch=f.queue.dispatch();const duplicates=Array.from({length:40},()=>f.queue.dispatch());assert(duplicates.every(value=>value===dispatch));
    await assert.rejects(dispatch,code('QUEUE_UNAVAILABLE'));assert(Date.now()-started>=QUEUE_DISPATCH_TIMEOUT_MS-150);assert(Date.now()-started<QUEUE_DISPATCH_TIMEOUT_MS+2_000);
    await eventually(()=>wire.sockets.size===0,'Batch timeout left Redis sockets open');assert.equal(db.pool.totalCount-db.pool.idleCount,0);assert.equal(wire.connections(),1);
    const count=await f.control.getWaitingCount();assert(count>0&&count<14,'The fixture must include an acknowledged/ambiguous partial publish.');await delay(800);assert.equal(await f.control.getWaitingCount(),count,'Publishing continued after dispatch returned.');
    assert.equal((await db.query('SELECT count(*)::integer AS count FROM platform_job_outbox WHERE dispatched_at IS NOT NULL')).rows[0].count,0);
    wire.setLatency(0);await f.queue.dispatch();assert.equal(await f.control.getWaitingCount(),14,'Stable notification IDs must reconcile a lost acknowledgement without duplicates.');
  }finally{await f.close();await wire.close();}
});

test('two dispatchers share the database advisory gate and close aborts a stalled dispatch before pool release',async()=>{
  const wire=await proxy(),f=fixture(wire.url),second=new TaskQueue(f.jobs);try{
    await f.create();await Promise.all([f.queue.dispatch(),second.dispatch()]);assert.equal(await f.control.getWaitingCount(),1);await second.close();
    await f.loss();await f.queue.queue.waitUntilReady();wire.setDrop(true);const dispatch=f.queue.dispatch();const rejection=assert.rejects(dispatch,code('QUEUE_UNAVAILABLE'));await delay(75);const started=Date.now();await f.queue.close();await rejection;assert(Date.now()-started<2_000);
    await eventually(()=>wire.sockets.size===0,'Producer close did not terminate actual TCP connections');assert.equal(db.pool.totalCount-db.pool.idleCount,0);await assert.rejects(f.queue.dispatch(),code('QUEUE_CLOSED'));
  }finally{await second.close();await f.close();await wire.close();}
});
