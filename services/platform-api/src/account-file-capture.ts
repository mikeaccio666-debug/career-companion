import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object} from '@companion/platform-contracts';
import type {FixedSessionContext} from './auth.ts';
import {authorizeFixedSession} from './auth.ts';
import type {BlobStorage,BlobStat} from './storage.ts';
import type {PlatformConfig} from './config.ts';
import {CompanionBirthOriginStore} from './companion-birth-origin-store.ts';
import {ApiError} from './errors.ts';

export const ACCOUNT_FILE_TABLES=Object.freeze(['platform_uploads','platform_artifacts','platform_companion_birth_assets'] as const);
export type AccountFileSection='uploads'|'artifacts'|'privateFiles';
export interface ArchiveFile {path:string;source:'upload'|'companion_birth_svg'|'companion_birth_png';sourceId:string;size:number;sha256:string;}
type Item={section:AccountFileSection;record:unknown};
interface UploadRow {id:string;user_id:string;filename:string;mime:string;byte_size:string;storage_key:string;created_at:Date;}
interface ArtifactRow {id:string;user_id:string;job_id:string|null;kind:string;mime:string|null;filename:string|null;upload_id:string|null;external_url:string|null;metadata:unknown;created_at:Date;}
export const accountFileUnavailable=()=>new ApiError(503,'ACCOUNT_FILE_EXPORT_UNAVAILABLE','The private files could not be captured completely.');
const full=()=>new ApiError(503,'ACCOUNT_FILE_EXPORT_TOO_LARGE','This export requires the archive worker. No partial archive was returned.');
function text(v:unknown,max:number){if(typeof v!=='string'||!v.length||v.length>max||/[\x00-\x1f\x7f]/.test(v))throw accountFileUnavailable();return v;}
function integer(v:unknown,min=0){if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min)throw accountFileUnavailable();return v;}
function hash(v:unknown){if(typeof v!=='string'||!/^[0-9a-f]{64}$/.test(v))throw accountFileUnavailable();return v;}
function timestamp(v:Date){if(!(v instanceof Date)||!Number.isFinite(v.getTime()))throw accountFileUnavailable();return v.toISOString();}
/** Saved public provenance only; never execution policy, grants or arbitrary
 * provider metadata. Unknown legacy shapes block the archive, not disappear. */
function artifactMetadata(input:unknown){
 const v=object(input,[],['workflowStep','definitionHash','partialCompleted','browserGeneration','browserObservation','browserAction','mcpGeneration','mcpDefinitionHash','mcp']);
 if(!Object.keys(v).length)return {};
 if(v.workflowStep!==undefined){object(v,['workflowStep','definitionHash','partialCompleted']);if(v.partialCompleted!==true)throw accountFileUnavailable();return {workflowStep:integer(v.workflowStep),definitionHash:hash(v.definitionHash),partialCompleted:true};}
 if(v.browserGeneration!==undefined){
  object(v,['browserGeneration','definitionHash','browserObservation'],['browserAction','partialCompleted']);if(typeof v.browserObservation!=='boolean')throw accountFileUnavailable();
  if((v.browserAction===undefined)!==(v.partialCompleted===undefined)||v.partialCompleted!==undefined&&v.partialCompleted!==true)throw accountFileUnavailable();
  return {browserGeneration:integer(v.browserGeneration,1),definitionHash:hash(v.definitionHash),browserObservation:v.browserObservation,
   ...(v.browserAction===undefined?{}:{browserAction:integer(v.browserAction),partialCompleted:true})};
 }
 object(v,['mcpGeneration','mcpDefinitionHash','mcp']);const m=object(v.mcp,['connectionId','connectionName','catalogId','grantVersion','toolName','schemaHash']);
 return {mcpGeneration:integer(v.mcpGeneration,1),mcpDefinitionHash:hash(v.mcpDefinitionHash),mcp:{connectionId:id(m.connectionId),connectionName:text(m.connectionName,200),
  catalogId:text(m.catalogId,200),grantVersion:integer(m.grantVersion,1),toolName:text(m.toolName,200),schemaHash:hash(m.schemaHash)}};
}

/** One private staging directory per capture. No path or storage coordinate is
 * serialized into the account snapshot. The wrapper owns cleanup and delivery. */
export class AccountFileCapture {
 readonly tables=ACCOUNT_FILE_TABLES;
 private readonly origins:CompanionBirthOriginStore;
 private readonly operations=new Set<Promise<unknown>>();
 private readonly versions:{key:string;stat:BlobStat}[]=[];
 private count=0;private bytes=0;private started=false;
 constructor(private readonly directory:string,private readonly storage:BlobStorage,config:Pick<PlatformConfig,'dataCrypto'>,
  private readonly maxBytes=256*1024*1024,private readonly maxFiles=10000){
  this.origins=new CompanionBirthOriginStore(config.dataCrypto);
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>256*1024*1024||!Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>10000)throw accountFileUnavailable();
 }
 private track<T>(operation:Promise<T>):Promise<T>{this.operations.add(operation);void operation.finally(()=>this.operations.delete(operation)).catch(()=>{});return operation;}
 async drain(){while(this.operations.size)await Promise.allSettled([...this.operations]);}
 private reserve(size:number){integer(size);if(++this.count>this.maxFiles||size>this.maxBytes-this.bytes)throw full();this.bytes+=size;}
 private async copy(relative:string,stream:Readable,size:number,signal?:AbortSignal):Promise<string>{
  let transferred=0;const digest=createHash('sha256');
  try{
   const check=new Transform({transform(chunk:Buffer,_encoding,done){
    if(!(chunk instanceof Uint8Array)||(transferred+=chunk.byteLength)>size)return done(accountFileUnavailable());digest.update(chunk);done(null,chunk);
   },flush(done){done(transferred===size?undefined:accountFileUnavailable());}});
   const output=createWriteStream(path.join(this.directory,relative),{flags:'wx',mode:0o600});
   await pipeline(stream,check,output,{signal});signal?.throwIfAborted();return digest.digest('hex');
  }finally{stream.destroy();}
 }
 captureInTransaction(c:PoolClient,who:FixedSessionContext,signal?:AbortSignal){return this.track(this.capture(c,who,signal));}
 private async capture(c:PoolClient,who:FixedSessionContext,signal?:AbortSignal):Promise<Item[]>{
  if(this.started)throw accountFileUnavailable();this.started=true;
  try{
   await authorizeFixedSession(c,who,signal);signal?.throwIfAborted();
   await fs.mkdir(path.join(this.directory,'uploads'),{mode:0o700});await fs.mkdir(path.join(this.directory,'birth'),{mode:0o700});
   const items:Item[]=[];let metadataBytes=0;const append=(...values:Item[])=>{for(const v of values){metadataBytes+=Buffer.byteLength(JSON.stringify(v));if(metadataBytes>16*1024*1024)throw full();items.push(v);}};
   const uploads=new Map<string,{path:string;filename:string;mime:string}>();let after:string|null=null;
   for(;;){
    signal?.throwIfAborted();const rows:UploadRow[]=(await c.query<UploadRow>(`SELECT id,user_id,filename,mime,byte_size,storage_key,created_at FROM platform_uploads
     WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100`,[who.userId,after])).rows;
    for(const row of rows){
     signal?.throwIfAborted();if(row.user_id!==who.userId||uploads.has(row.id)||typeof row.storage_key!=='string'||!/^[A-Za-z0-9_-]{1,240}$/.test(row.storage_key))throw accountFileUnavailable();
     const uploadId=id(row.id),filename=text(row.filename,200),mime=text(row.mime,150),size=Number(row.byte_size),createdAt=timestamp(row.created_at);
     if(!/^(0|[1-9][0-9]*)$/.test(String(row.byte_size)))throw accountFileUnavailable();this.reserve(size);
     if((await c.query('SELECT 1 FROM platform_upload_removals WHERE upload_id=$1',[uploadId])).rowCount)throw accountFileUnavailable();
     const stat=await this.storage.stat(row.storage_key,signal);
     if(stat.size!==size||typeof stat.etag!=='string'||!/^"[\x21\x23-\x7e]{1,200}"$/.test(stat.etag))throw accountFileUnavailable();
     const relative='uploads/'+uploadId,opened=await this.storage.openRead(row.storage_key,{expected:stat,signal});
     if(opened.length!==size){opened.stream.destroy();throw accountFileUnavailable();}
     const sha256=await this.copy(relative,opened.stream,size,signal);this.versions.push({key:row.storage_key,stat:{...stat}});
     uploads.set(uploadId,{path:relative,filename,mime});
     append({section:'uploads',record:{id:uploadId,ownerId:who.userId,filename,mime,byteSize:size,createdAt,filePath:relative}},
      {section:'privateFiles',record:{path:relative,source:'upload',sourceId:uploadId,size,sha256} satisfies ArchiveFile});
    }
    if(rows.length<100)break;after=id(rows.at(-1)!.id);
   }
   after=null;
   for(;;){
    signal?.throwIfAborted();const rows:ArtifactRow[]=(await c.query<ArtifactRow>(`SELECT id,user_id,job_id,kind,mime,filename,upload_id,external_url,metadata,created_at FROM platform_artifacts
     WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100`,[who.userId,after])).rows;
    for(const row of rows){
     signal?.throwIfAborted();if(row.user_id!==who.userId||row.external_url!==null)throw accountFileUnavailable();
     const artifactId=id(row.id),jobId=row.job_id===null?null:id(row.job_id),uploadId=row.upload_id===null?null:id(row.upload_id);
     if(jobId){const job=(await c.query('SELECT id,user_id FROM platform_jobs WHERE id=$1',[jobId])).rows[0];if(!job||job.id!==jobId||job.user_id!==who.userId)throw accountFileUnavailable();}
     const file=uploadId?uploads.get(uploadId):null;if(uploadId&&!file)throw accountFileUnavailable();
     append({section:'artifacts',record:{id:artifactId,ownerId:who.userId,jobId,kind:text(row.kind,100),mime:row.mime===null?null:text(row.mime,150),
      filename:row.filename===null?null:text(row.filename,200),uploadId,metadata:artifactMetadata(row.metadata),createdAt:timestamp(row.created_at),
      file:file?{status:'included',path:file.path}:{status:'not_attached'}}});
    }
    if(rows.length<100)break;after=id(rows.at(-1)!.id);
   }
   after=null;
   for(;;){
    signal?.throwIfAborted();const rows:{id:string;user_id:string}[]=(await c.query(`SELECT id,user_id FROM platform_companion_birth_assets
     WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100`,[who.userId,after])).rows;
    for(const row of rows){signal?.throwIfAborted();if(row.user_id!==who.userId)throw accountFileUnavailable();const assetId=id(row.id),asset=await this.origins.readSealAsset(c,who.userId,assetId);if(!asset)throw accountFileUnavailable();
     for(const format of ['svg','png'] as const){const bytes=asset[format],relative='birth/'+assetId+'.'+format;this.reserve(bytes.length);
      const sha256=await this.copy(relative,Readable.from([bytes]),bytes.length,signal);
      append({section:'privateFiles',record:{path:relative,source:format==='svg'?'companion_birth_svg':'companion_birth_png',sourceId:assetId,size:bytes.length,sha256} satisfies ArchiveFile});
     }
    }
    if(rows.length<100)break;after=id(rows.at(-1)!.id);
   }
   await authorizeFixedSession(c,who,signal);signal?.throwIfAborted();return items;
  }catch(error){if(signal?.aborted)throw error;if(error instanceof ApiError&&error.code==='ACCOUNT_FILE_EXPORT_TOO_LARGE')throw error;throw accountFileUnavailable();}
 }
 finish(snapshot:unknown,signal?:AbortSignal){return this.track(this.finalize(snapshot,signal));}
 private async finalize(snapshot:unknown,signal?:AbortSignal){
  try{
   for(const saved of this.versions){signal?.throwIfAborted();const now=await this.storage.stat(saved.key,signal);if(now.size!==saved.stat.size||now.etag!==saved.stat.etag)throw accountFileUnavailable();}
   signal?.throwIfAborted();await fs.writeFile(path.join(this.directory,'account.json'),JSON.stringify(snapshot),{flag:'wx',mode:0o600,signal});signal?.throwIfAborted();
  }catch(error){if(signal?.aborted)throw error;throw accountFileUnavailable();}
 }
}
