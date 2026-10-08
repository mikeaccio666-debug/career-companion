import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { BlobStorage } from './storage.ts';
import { ApiError } from './errors.ts';
import { careerLibraryText,parseResumeUploadSnapshot,type ResumeUploadSnapshot } from '@companion/platform-contracts';
export const RESUME_FILE_MAX_BYTES=20*1024*1024;
const failure=(code='RESUME_TEXT_UNAVAILABLE',status=422)=>new ApiError(status,code,'这份文件暂时读不出完整文字，请另存为有文字的 PDF，或直接粘贴。');
const executorFailure=(code='RESUME_TEXT_EXECUTOR_UNAVAILABLE')=>new ApiError(503,code,'文字读取服务暂时不可用，请稍后重试，或直接粘贴简历全文。');
const aborted=(signal?:AbortSignal)=>{if(signal?.aborted)throw new ApiError(499,'RESUME_TEXT_CANCELLED','已停止读取这份文件。');};
/** Only server-chosen programs and arguments call this port. No command/path
 * comes from a file name or HTTP input. Await physical close even after kill. */
export async function runResumeTextProcess(program:string,args:readonly string[],input:Uint8Array,signal?:AbortSignal,limits:{milliseconds:number;outputBytes:number}={milliseconds:10000,outputBytes:220000}):Promise<Buffer>{
 aborted(signal);
 const child=spawn(program,[...args],{stdio:['pipe','pipe','pipe'],env:{LANG:'C.UTF-8',LC_ALL:'C.UTF-8'}});
 let error:ApiError|undefined,bytes=0;const chunks:Buffer[]=[];
 const stop=(e:ApiError)=>{error??=e;child.kill('SIGKILL');};
 const abort=()=>stop(new ApiError(499,'RESUME_TEXT_CANCELLED','已停止读取这份文件。'));
 const timer=setTimeout(()=>stop(failure('RESUME_TEXT_TIMEOUT',503)),limits.milliseconds);
 signal?.addEventListener('abort',abort,{once:true});
 const finished=new Promise<Buffer>((resolve,reject)=>{
  child.once('error',()=>{error??=executorFailure();});
  child.stdin.on('error',()=>{/* Early parser exit is handled by its final code. */});
  child.stderr.on('data',()=>{/* Never retain or log parser diagnostics or private PDF fragments. */});
  child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>limits.outputBytes)stop(failure('RESUME_TEXT_TOO_LARGE',413));else chunks.push(chunk);});
  child.once('close',(code,terminationSignal)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error)reject(error);else if(terminationSignal!==null)reject(executorFailure('RESUME_TEXT_EXECUTOR_INTERRUPTED'));else if(code===126||code===127)reject(executorFailure());else if(code!==0)reject(failure());else resolve(Buffer.concat(chunks,bytes));});
 });
 if(signal?.aborted)abort();else child.stdin.end(input);
 return finished;
}
/** Poppler is invoked with stdin/stdout only. No resume temp files, shell,
 * passwords, model calls, URLs, or scripts from the PDF are executed here. */
let activePdfReads=0;
export async function extractPdfResume(bytes:Uint8Array,signal?:AbortSignal){
 if(activePdfReads>=2)throw failure('RESUME_TEXT_BUSY',503);activePdfReads++;try{
 const command='/usr/bin/prlimit',base=['--as=402653184','--cpu=6','--nofile=64','--','/usr/bin/pdftotext'];
 // Verify the fixed tool chain without passing private PDF bytes first.
 // A missing or unusable runtime must not accuse the owner's file of damage.
 const engineVersion=await pdfEngineVersion(signal);
 const output=await runResumeTextProcess(command,[...base,'-q','-layout','-enc','UTF-8','-eol','unix','-','-'],bytes,signal);
 let raw:string;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(output);}catch{throw failure();}
 const pages=raw.split('\f');if(!pages.at(-1)?.trim())pages.pop();
 if(!pages.length||pages.length>100||pages.some(p=>!p.trim()))throw failure('RESUME_TEXT_INCOMPLETE');
 const text=pages.join('\n\n');try{careerLibraryText(text,50000,true);}catch{throw failure('RESUME_TEXT_TOO_LARGE',413);}
 return {text,engineVersion};
 }finally{activePdfReads--;}
}
async function pdfEngineVersion(signal?:AbortSignal):Promise<string>{
 aborted(signal);const child=spawn('/usr/bin/prlimit',['--as=402653184','--cpu=2','--nofile=64','--','/usr/bin/pdftotext','-v'],{stdio:['ignore','pipe','pipe'],env:{LANG:'C.UTF-8',LC_ALL:'C.UTF-8'}});let raw='',error:ApiError|undefined;
 const stop=(e:ApiError)=>{error??=e;child.kill('SIGKILL');};const abort=()=>stop(new ApiError(499,'RESUME_TEXT_CANCELLED','已停止读取这份文件。'));const timer=setTimeout(()=>stop(executorFailure()),3000);signal?.addEventListener('abort',abort,{once:true});
 return new Promise((resolve,reject)=>{child.once('error',()=>{error??=executorFailure();});const read=(v:Buffer)=>{raw+=v.toString('utf8');if(raw.length>4096)stop(executorFailure());};child.stdout.on('data',read);child.stderr.on('data',read);child.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);const version=/^pdftotext version ([0-9]+\.[0-9]+\.[0-9]+[a-z0-9.-]*)/m.exec(raw)?.[1];if(error)reject(error);else if(code!==0||!version)reject(executorFailure());else resolve(version);});if(signal?.aborted)abort();});
}
export interface OwnedResumeFile {readonly id:string;readonly userId:string;readonly storageKey:string;readonly filename:string;readonly mime:'application/pdf'|'text/plain'|'text/markdown';readonly size:number;readonly createdAt:string;}
/** Caller must verify this owned descriptor before and after I/O; source bytes
 * are version-checked, bounded and complete, never a first-page truncation. */
let activeFileReads=0;
export async function readResumeFileText(storage:BlobStorage,file:OwnedResumeFile,expectedSha256:string|undefined,signal?:AbortSignal):Promise<{text:string;source:Readonly<ResumeUploadSnapshot>}>{
 aborted(signal);if(activeFileReads>=2)throw failure('RESUME_TEXT_BUSY',503);activeFileReads++;try{if(!Number.isSafeInteger(file.size)||file.size<1||file.size>RESUME_FILE_MAX_BYTES)throw failure('RESUME_FILE_TOO_LARGE',413);
 const stat=await storage.stat(file.storageKey,signal);if(stat.size!==file.size||typeof stat.etag!=='string'||!/^"[\x21\x23-\x7e]{0,200}"$/.test(stat.etag))throw failure('RESUME_UPLOAD_CHANGED',409);
 const opened=await storage.openRead(file.storageKey,{expected:stat,signal}),stream=opened.stream;let cleanup:unknown,readFailed=false;const onError=(e:unknown)=>{cleanup=e;};stream.on('error',onError);const closed=stream.closed?Promise.resolve():new Promise<void>(r=>stream.once('close',r));let bytes:Buffer;
 try{if(opened.length!==file.size)throw failure('RESUME_UPLOAD_CHANGED',409);const chunks:Buffer[]=[];let count=0;for await(const value of stream){aborted(signal);if(!(value instanceof Uint8Array)||(count+=value.byteLength)>file.size)throw failure('RESUME_UPLOAD_CHANGED',409);chunks.push(Buffer.from(value));}if(count!==file.size)throw failure('RESUME_UPLOAD_CHANGED',409);bytes=Buffer.concat(chunks,count);}
 catch(e){readFailed=true;aborted(signal);throw e instanceof ApiError?e:failure('RESUME_FILE_READ_FAILED',503);}
 finally{stream.destroy();await closed;stream.removeListener('error',onError);aborted(signal);if(!readFailed&&cleanup)throw failure('RESUME_FILE_READ_FAILED',503);}
 const sha256=createHash('sha256').update(bytes).digest('hex');if(expectedSha256!==undefined&&sha256!==expectedSha256)throw failure('RESUME_UPLOAD_CHANGED',409);
 let text:string,engineVersion:string,parser:ResumeUploadSnapshot['parser'];
 if(file.mime==='application/pdf'){if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw failure();const result=await extractPdfResume(bytes,signal);text=result.text;engineVersion=result.engineVersion;parser='pdftotext';}
 else{if(['%PDF-','PK','GIF8','RIFF'].some(v=>bytes.subarray(0,v.length).equals(Buffer.from(v)))||bytes[0]===0x1f&&bytes[1]===0x8b)throw failure();try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);careerLibraryText(text,50000,true);}catch{throw failure('RESUME_TEXT_INVALID');}engineVersion=process.versions.node;parser='utf8';}
 const after=await storage.stat(file.storageKey,signal);if(after.size!==stat.size||after.etag!==stat.etag)throw failure('RESUME_UPLOAD_CHANGED',409);aborted(signal);
 return {text,source:parseResumeUploadSnapshot({uploadId:file.id,storageVersion:stat.etag,byteSize:file.size,sha256,textSha256:createHash('sha256').update(text).digest('hex'),parser,engineVersion})};
 }finally{activeFileReads--;}
}
