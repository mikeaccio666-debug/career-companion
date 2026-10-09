import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {ZipFile} from 'yazl';
import type {AccountFileArchive} from './account-file-archive.ts';
import {accountFileUnavailable} from './account-file-capture.ts';
import {ApiError} from './errors.ts';

type Capture=Awaited<ReturnType<AccountFileArchive['capture']>>;
interface Entry {path:string;size:number;sha256:string;}
const maxJsonBytes=16*1024*1024,maxFileBytes=256*1024*1024,maxFiles=10000;
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uploadPath=new RegExp('^uploads/('+uuid+')$');
const birthPath=new RegExp('^birth/('+uuid+')\\.(svg|png)$');
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function privateDirectory(directory:string){
 const stat=await fs.lstat(directory);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||await fs.realpath(directory)!==directory)throw accountFileUnavailable();
}
function entries(snapshot:Capture['snapshot']):Entry[]{
 if(snapshot.filesIncluded!==true)throw accountFileUnavailable();
 const json=Buffer.from(JSON.stringify(snapshot));
 if(json.length>maxJsonBytes)throw accountFileUnavailable();
 const rows=snapshot.sections.privateFiles;
 if(!Array.isArray(rows)||rows.length>maxFiles)throw accountFileUnavailable();
 const result:Entry[]=[{path:'account.json',size:json.length,sha256:digest(json)}],seen=new Set<string>();let total=0;
 for(const row of rows){
  if(!row||typeof row!=='object')throw accountFileUnavailable();
  const file=row as Record<string,unknown>;
  if(typeof file.path!=='string'||typeof file.sha256!=='string'||!/^[0-9a-f]{64}$/.test(file.sha256)||
   typeof file.size!=='number'||!Number.isSafeInteger(file.size)||file.size<0)throw accountFileUnavailable();
  const upload=uploadPath.exec(file.path),birth=birthPath.exec(file.path);
  if(!(upload&&file.source==='upload'&&file.sourceId===upload[1]||birth&&file.source==='companion_birth_'+birth[2]&&file.sourceId===birth[1])||
   seen.has(file.path)||(total+=file.size)>maxFileBytes)throw accountFileUnavailable();
  seen.add(file.path);result.push({path:file.path,size:file.size,sha256:file.sha256});
 }
 return result;
}

/** Internal packer for an authenticated capture, never an HTTP response or an
 * authorization boundary. Caller owns the staging directory and must dispose it.
 * Only manifest entries are packaged; the directory is never recursively walked. */
export async function packageAccountCapture(capture:Capture,signal?:AbortSignal){
 const cancellation=new AbortController(),io=signal?AbortSignal.any([signal,cancellation.signal]):cancellation.signal;
 const zip=new ZipFile(),output=zip.outputStream as Readable;
 const operations=new Set<Promise<void>>();let archivePath:string|undefined,ownsOutput=false,writing:Promise<void>|undefined;
 const fail=(error:Error)=>{cancellation.abort();output.destroy(error);};
 zip.on('error',fail);output.on('error',fail);
 // Blocking yazl's next lazy entry on cancellation prevents further file opens.
 const stop=()=>{zip.emit('error',accountFileUnavailable());};
 io.addEventListener('abort',stop,{once:true});
 try{
  io.throwIfAborted();const directory=path.resolve(capture.directory);await privateDirectory(directory);
  const files=entries(capture.snapshot),mtime=new Date(capture.snapshot.capturedAt);
  if(!Number.isFinite(mtime.getTime()))throw accountFileUnavailable();
  archivePath=path.join(directory,'account.zip');
  const handle=await fs.open(archivePath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);ownsOutput=true;
  // The file handle is handed to the writer before another cancellable await.
  const destination=handle.createWriteStream({autoClose:true});
  let bytes=0;const sha=createHash('sha256');
  const sizeLimit=maxJsonBytes+maxFileBytes+4*1024*1024;
  const checkedOutput=new Transform({transform(chunk:Buffer,_encoding,done){
   bytes+=chunk.length;if(bytes>sizeLimit)return done(accountFileUnavailable());sha.update(chunk);done(null,chunk);
  }});
  writing=pipeline(output,checkedOutput,destination,{signal:io});
  // Observe rejection immediately while lazy input streams are still running.
  void writing.catch(fail);
  for(const entry of files){
   zip.addReadStreamLazy(entry.path,{size:entry.size,mtime,mode:0o100600,compress:false},callback=>{
    const operation=(async()=>{
     let source:Readable|undefined,handed=false;
     try{
      io.throwIfAborted();const filename=path.join(directory,entry.path);
      await privateDirectory(path.dirname(filename));io.throwIfAborted();
      const input=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{
       const stat=await input.stat();
       if(!stat.isFile()||stat.size!==entry.size||stat.nlink!==1||(stat.mode&0o077)!==0)throw accountFileUnavailable();
       io.throwIfAborted();source=input.createReadStream({autoClose:true});
      }catch(error){await input.close();throw error;}
      let length=0;const hash=createHash('sha256');
      const checked=new Transform({transform(chunk:Buffer,_encoding,done){
       length+=chunk.length;if(length>entry.size)return done(accountFileUnavailable());hash.update(chunk);done(null,chunk);
      },flush(done){done(length===entry.size&&hash.digest('hex')===entry.sha256?undefined:accountFileUnavailable());}});
      // Install error handling before giving the stream to the ZIP library.
      const reading=pipeline(source,checked,{signal:io});
      handed=true;callback(null,checked);await reading;
     }catch{
      if(!handed)callback(accountFileUnavailable(),Readable.from([]));
      else zip.emit('error',accountFileUnavailable());
     }finally{source?.destroy();}
    })();
    operations.add(operation);void operation.finally(()=>operations.delete(operation));
   });
  }
  zip.end();await writing;
  while(operations.size)await Promise.all([...operations]);
  io.throwIfAborted();
  return Object.freeze({filePath:archivePath,byteSize:bytes,sha256:sha.digest('hex'),mime:'application/zip' as const});
 }catch{
  cancellation.abort();output.destroy();
  await writing?.catch(()=>{});
  while(operations.size)await Promise.allSettled([...operations]);
  if(ownsOutput&&archivePath){
   try{await fs.rm(archivePath,{force:true});}catch{throw new ApiError(503,'ACCOUNT_ARCHIVE_CLEANUP_REQUIRED','The private archive needs cleanup before retrying.');}
  }
  if(signal?.aborted)throw new ApiError(499,'ACCOUNT_EXPORT_CANCELLED','The private export was cancelled.');
  throw accountFileUnavailable();
 }finally{io.removeEventListener('abort',stop);zip.removeListener('error',fail);}
}
