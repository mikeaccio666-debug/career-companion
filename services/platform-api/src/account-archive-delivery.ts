import fs from 'node:fs/promises';
import {constants,type BigIntStats} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {careerRecordId,careerRecordObject} from '@companion/platform-contracts';
import type {Database} from './database.ts';
import type {AccountFileArchive} from './account-file-archive.ts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import {accountFileUnavailable} from './account-file-capture.ts';
import {ApiError} from './errors.ts';

const cancelled=()=>new ApiError(499,'ACCOUNT_EXPORT_CANCELLED','The private export was cancelled.');
const cleanupRequired=()=>new ApiError(503,'ACCOUNT_ARCHIVE_CLEANUP_REQUIRED','The private archive needs cleanup before retrying.');
function fixed(who:FixedSessionContext){
 const input=careerRecordObject(who,['userId','tokenHash']);
 if(typeof input.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(input.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
 return Object.freeze({userId:careerRecordId(input.userId),tokenHash:input.tokenHash});
}
function version(stat:BigIntStats,expected:number){
 if(!stat.isFile()||stat.nlink!==1n||(stat.mode&0o077n)!==0n||stat.size!==BigInt(expected))throw accountFileUnavailable();
 return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs,stat.mode].join(':');
}

/** One-request, one-stream delivery of a freshly authenticated archive. This is
 * an internal service, not a public route: the caller must still enforce complete
 * export coverage before exposing it. It creates no reusable download URL/grant. */
export class AccountArchiveDelivery {
 constructor(private readonly db:Database,private readonly archives:AccountFileArchive){}
 async prepare(context:FixedSessionContext,proof:string,signal?:AbortSignal){
  const who=fixed(context),cancellation=new AbortController();
  const io=signal?AbortSignal.any([signal,cancellation.signal]):cancellation.signal;
  const artifact=await this.archives.captureZip(who,proof,io);
  let input:Awaited<ReturnType<typeof fs.open>>|undefined,cleaning:Promise<void>|undefined;
  let resolveClosed!:()=>void,rejectClosed!:(error:unknown)=>void;
  /** Resource completion only; successful bytes must also reach stream EOF. */
  const closed=new Promise<void>((resolve,reject)=>{resolveClosed=resolve;rejectClosed=reject;});
  void closed.catch(()=>{});
  const cleanup=()=>cleaning??=(async()=>{
   // Try both even if closing a descriptor fails; do not suppress cleanup failure.
   let failed=false;
   try{await input?.close();}catch{failed=true;}
   try{await artifact.dispose();}catch{failed=true;}
   if(failed)throw cleanupRequired();
  })().then(resolveClosed,error=>{rejectClosed(error);throw error;});
  const authorize=()=>this.db.withBoundedTransaction(async client=>{
   await authorizeFixedSession(client,who,io);
   const row=(await client.query('SELECT account_kind FROM platform_users WHERE id=$1',[who.userId])).rows[0];
   if(row?.account_kind!=='student')throw new ApiError(403,'STUDENT_ACCOUNT_REQUIRED','Use a student account.');
   io.throwIfAborted();
  });
  const safe=(error:unknown)=>error instanceof ApiError?error:io.aborted?cancelled():accountFileUnavailable();
  const read=async function*(){
   try{
    io.throwIfAborted();
    if(artifact.snapshot.ownerId!==who.userId)throw accountFileUnavailable();
    await authorize();io.throwIfAborted();
    const directory=path.resolve(artifact.directory),stat=await fs.lstat(directory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||await fs.realpath(directory)!==directory||
     artifact.filePath!==path.join(directory,'account.zip'))throw accountFileUnavailable();
    io.throwIfAborted();
    input=await fs.open(artifact.filePath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const capturedVersion=version(await input.stat({bigint:true}),artifact.byteSize);
    const checkVersion=async()=>{if(version(await input!.stat({bigint:true}),artifact.byteSize)!==capturedVersion)throw accountFileUnavailable();};
    const readChunk=async(position:number)=>{
     io.throwIfAborted();const buffer=Buffer.allocUnsafe(Math.min(64*1024,artifact.byteSize-position));
     const {bytesRead}=await input!.read(buffer,0,buffer.length,position);io.throwIfAborted();
     if(!bytesRead)throw accountFileUnavailable();return buffer.subarray(0,bytesRead);
    };
    // Verify the whole on-disk ZIP before releasing any bytes. The second pass
    // uses the same descriptor, with bounded buffers and backpressure.
    const verified=createHash('sha256');
    for(let position=0;position<artifact.byteSize;){const chunk=await readChunk(position);verified.update(chunk);position+=chunk.length;}
    if(verified.digest('hex')!==artifact.sha256)throw accountFileUnavailable();
    await checkVersion();
    // No database connection or account lock spans file verification or transfer.
    await authorize();io.throwIfAborted();await checkVersion();
    const sent=createHash('sha256');
    for(let position=0;position<artifact.byteSize;){
     const chunk=await readChunk(position);sent.update(chunk);position+=chunk.length;
     // A receiver may treat Content-Length bytes as complete before EOF. Keep
     // the final chunk until the second digest and file-version check pass.
     if(position===artifact.byteSize){
      await checkVersion();io.throwIfAborted();
      if(sent.digest('hex')!==artifact.sha256)throw accountFileUnavailable();
     }
     yield chunk;
    }
   }catch(error){throw safe(error);}
   finally{await cleanup();}
  };
  const stream=Readable.from(read(),{objectMode:false,highWaterMark:64*1024});
  // Observe safe errors even when an HTTP consumer disconnects before attaching.
  stream.on('error',()=>{});
  const aborted=()=>stream.destroy(cancelled());
  io.addEventListener('abort',aborted,{once:true});
  stream.once('close',()=>{
   io.removeEventListener('abort',aborted);
   // Readable.from may never enter the generator when discarded before reading.
   void cleanup().catch(()=>{});
  });
  if(io.aborted)aborted();
  return Object.freeze({
   metadata:Object.freeze({ownerId:who.userId,capturedAt:artifact.snapshot.capturedAt,
    complete:artifact.snapshot.complete,filesIncluded:artifact.snapshot.filesIncluded,
    remainingTables:artifact.snapshot.remainingTables,filename:'career-companion-account.zip',
    mime:artifact.mime,byteSize:artifact.byteSize,sha256:artifact.sha256}),
   stream,closed,
   async dispose(){cancellation.abort();stream.destroy();await closed;},
  });
 }
}
