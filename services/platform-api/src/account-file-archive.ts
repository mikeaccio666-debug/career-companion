import {careerRecordId,careerRecordObject} from '@companion/platform-contracts';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {Database} from './database.ts';
import type {PlatformConfig} from './config.ts';
import type {BlobStorage} from './storage.ts';
import type {FixedSessionContext} from './auth.ts';
import {AccountCoreExport} from './account-core-export.ts';
import {AccountFileCapture,accountFileUnavailable} from './account-file-capture.ts';
import {ApiError} from './errors.ts';

/** Internal archive parts, not a public download. The caller must dispose after
 * packaging/delivery. A later HTTP/worker layer must recheck delivery authority. */
export class AccountFileArchive {
 constructor(private readonly db:Database,private readonly config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>,
  private readonly storage:BlobStorage,private readonly workspaceDirectory:string,
  private readonly limits:{maxFileBytes?:number;maxFiles?:number;maxJsonBytes?:number}={}){}
 async capture(who:FixedSessionContext,proof:string,signal?:AbortSignal){
  let directory:string|undefined,files:AccountFileCapture|undefined;const cancellation=new AbortController();
  const io=signal?AbortSignal.any([signal,cancellation.signal]):cancellation.signal;
  try{
   const input=careerRecordObject(who,['userId','tokenHash']);if(typeof input.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(input.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
   const captured=Object.freeze({userId:careerRecordId(input.userId),tokenHash:input.tokenHash});
   io.throwIfAborted();const root=path.resolve(this.workspaceDirectory);
   await fs.mkdir(root,{recursive:true,mode:0o700});const stat=await fs.lstat(root);
   if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||await fs.realpath(root)!==root)throw accountFileUnavailable();
   directory=await fs.mkdtemp(path.join(root,'account-archive-'));await fs.chmod(directory,0o700);
   files=new AccountFileCapture(directory,this.storage,this.config,this.limits.maxFileBytes,this.limits.maxFiles);
   const snapshot=await new AccountCoreExport(this.db,this.config,{maxBytes:this.limits.maxJsonBytes,fileCapture:files}).capture(captured,proof,io);
   io.throwIfAborted();const saved=directory;let disposed=false;
   return Object.freeze({snapshot,directory:saved,async dispose(){if(!disposed){await fs.rm(saved,{recursive:true,force:true});disposed=true;}}});
  }catch(error){
   cancellation.abort();await files?.drain();
   if(directory){try{await fs.rm(directory,{recursive:true,force:true});}catch{throw new ApiError(503,'ACCOUNT_ARCHIVE_CLEANUP_REQUIRED','The private archive needs cleanup before retrying.');}}
   if(signal?.aborted)throw new ApiError(499,'ACCOUNT_EXPORT_CANCELLED','The private export was cancelled.');
   if(error instanceof ApiError)throw error;throw accountFileUnavailable();
  }
 }
}
