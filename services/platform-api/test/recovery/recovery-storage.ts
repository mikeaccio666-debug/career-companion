import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {CreateBucketCommand,DeleteBucketCommand,DeleteObjectCommand,GetObjectCommand,HeadObjectCommand,
 ListObjectsV2Command,ListObjectVersionsCommand,PutBucketVersioningCommand,S3Client} from '@aws-sdk/client-s3';
import {LocalBlobStorage,S3BlobStorage,type BlobStorage} from '../../src/storage.ts';
type Docker=(args:string[],input?:Buffer,timeout?:number,extraEnv?:NodeJS.ProcessEnv)=>Promise<Buffer>;
export interface RecoveryFile {key:string;size:number;sha256:string;}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export interface RecoveryStorage {
 source:BlobStorage;target:BlobStorage;
 backup():Promise<RecoveryFile[]>;destroySource():Promise<void>;restore():Promise<void>;
 targetManifest():Promise<RecoveryFile[]>;corrupt(file:RecoveryFile,bytes:Buffer):Promise<void>;
 remove(file:RecoveryFile):Promise<void>;repair(file:RecoveryFile):Promise<void>;close():Promise<void>;
 evidence:Record<string,unknown>;
}
async function localManifest(root:string):Promise<RecoveryFile[]>{
 const result:RecoveryFile[]=[];
 async function visit(relative:string){
  for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
   const key=path.join(relative,entry.name);assert(!entry.isSymbolicLink());
   if(entry.isDirectory())await visit(key);
   else{assert(entry.isFile());const bytes=await fs.readFile(path.join(root,key));result.push({key,size:bytes.length,sha256:hash(bytes)});}
  }
 }
 await visit('');return result.sort((a,b)=>a.key.localeCompare(b.key));
}
export async function createRecoveryStorage(mode:'local'|'s3',dir:string,docker:Docker):Promise<RecoveryStorage>{
 const sourceRoot=path.join(dir,'source-files'),backupRoot=path.join(dir,'backup-files'),targetRoot=path.join(dir,'restored-files');
 if(mode==='local')return {
  source:new LocalBlobStorage(sourceRoot),target:new LocalBlobStorage(targetRoot),evidence:{kind:'local_files'},
  async backup(){const files=await localManifest(sourceRoot);await fs.cp(sourceRoot,backupRoot,{recursive:true,errorOnExist:true,force:false});return files;},
  async destroySource(){await fs.rm(sourceRoot,{recursive:true});},
  async restore(){await fs.cp(backupRoot,targetRoot,{recursive:true,errorOnExist:true,force:false});},
  targetManifest:()=>localManifest(targetRoot),
  async corrupt(file,bytes){await fs.writeFile(path.join(targetRoot,file.key),bytes);},
  async remove(file){await fs.rm(path.join(targetRoot,file.key));},
  async repair(file){await fs.copyFile(path.join(backupRoot,file.key),path.join(targetRoot,file.key));},
  async close(){},
 };
 const name='companion-recovery-s3-'+randomUUID(),user='fixture-'+randomBytes(8).toString('hex'),secret=randomBytes(32).toString('hex');
 let container:string|undefined,sdk:S3Client|undefined;
 const sourceBucket='source-'+randomUUID(),targetBucket='restored-'+randomUUID();
 const evidence:Record<string,unknown>={kind:'local_s3',versionPinning:false,sourceRemoved:false,anonymousDenied:false,deletedObjectAbsent:false};
 const saved:{file:RecoveryFile;mime:string;version:string;etag:string;backupPath:string}[]=[];
 const close=async()=>{sdk?.destroy();if(container){await docker(['rm','--force','--volumes',container]);container=undefined;}};
 try{
  const image=(await docker(['image','inspect','minio/minio:RELEASE.2025-04-22T22-12-26Z','--format','{{.Id}}'])).toString().trim();
  assert(/^sha256:[a-f0-9]{64}$/.test(image));evidence.imageId=image;
  container=(await docker(['create','--pull=never','--name',name,'--label','career-companion.recovery-drill='+name,'--memory','512m','--cpus','1',
   '--pids-limit','256','--publish','127.0.0.1::9000','--env','MINIO_ROOT_USER','--env','MINIO_ROOT_PASSWORD',image,'server','/data'],undefined,60_000,
   {MINIO_ROOT_USER:user,MINIO_ROOT_PASSWORD:secret})).toString().trim();
  assert(/^[a-f0-9]{64}$/.test(container));await docker(['start',container]);
  const ports=JSON.parse((await docker(['inspect',container,'--format','{{json .NetworkSettings.Ports}}'])).toString())['9000/tcp'];
  assert.equal(ports.length,1);assert.equal(ports[0].HostIp,'127.0.0.1');assert(/^[0-9]+$/.test(ports[0].HostPort));
  const endpoint='http://127.0.0.1:'+ports[0].HostPort;
  let ready=false;const deadline=Date.now()+30_000;
  while(Date.now()<deadline){try{const response=await fetch(endpoint+'/minio/health/ready',{signal:AbortSignal.timeout(1000)});await response.arrayBuffer();if(response.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}
  assert(ready,'The isolated object store did not become ready.');
  const credentials={accessKeyId:user,secretAccessKey:secret};
  sdk=new S3Client({endpoint,region:'us-east-1',forcePathStyle:true,credentials,maxAttempts:1,requestHandler:{connectionTimeout:2000,requestTimeout:5000}});
  const client=sdk;
  for(const Bucket of [sourceBucket,targetBucket]){
   await client.send(new CreateBucketCommand({Bucket}));
   await client.send(new PutBucketVersioningCommand({Bucket,VersioningConfiguration:{Status:'Enabled'}}));
  }
  const source=new S3BlobStorage({endpoint,region:'us-east-1',bucket:sourceBucket,...credentials},client);
  const target=new S3BlobStorage({endpoint,region:'us-east-1',bucket:targetBucket,...credentials},client);
  // A deleted object and its retained version predate the snapshot. A backup of
  // current live files must not resurrect it by copying all retained versions.
  const deletedKey='fictional-deleted-before-snapshot';
  await source.put(deletedKey,Buffer.from('Fictional already removed object.'),'text/plain');await source.delete(deletedKey);
  async function currentFiles(Bucket:string){
   const keys:string[]=[];let ContinuationToken:string|undefined;
   do{
    const page=await client.send(new ListObjectsV2Command({Bucket,ContinuationToken,MaxKeys:100}));
    for(const item of page.Contents??[]){assert(item.Key);keys.push(item.Key);assert(keys.length<=1000);}
    if(page.IsTruncated){assert(page.NextContinuationToken&&page.NextContinuationToken!==ContinuationToken);ContinuationToken=page.NextContinuationToken;}else ContinuationToken=undefined;
   }while(ContinuationToken);
   return keys.sort();
  }
  async function denied(Bucket:string,Key:string){
   const response=await fetch(endpoint+'/'+Bucket+'/'+Key.split('/').map(encodeURIComponent).join('/'),{signal:AbortSignal.timeout(3000)});
   await response.arrayBuffer();assert.equal(response.status,403);
  }
  async function removeBucket(Bucket:string){
   let KeyMarker:string|undefined,VersionIdMarker:string|undefined;
   const entries:{Key:string;VersionId:string}[]=[];
   do{
    const page=await client.send(new ListObjectVersionsCommand({Bucket,KeyMarker,VersionIdMarker,MaxKeys:100}));
    for(const row of [...(page.Versions??[]),...(page.DeleteMarkers??[])]){assert(row.Key&&row.VersionId);entries.push({Key:row.Key,VersionId:row.VersionId});assert(entries.length<=1000);}
    if(page.IsTruncated){
     assert(page.NextKeyMarker);
     assert(page.NextKeyMarker!==KeyMarker||page.NextVersionIdMarker!==VersionIdMarker,'Version listing must advance.');
     KeyMarker=page.NextKeyMarker;VersionIdMarker=page.NextVersionIdMarker;
    }else KeyMarker=undefined;
   }while(KeyMarker);
   for(const entry of entries)await client.send(new DeleteObjectCommand({Bucket,...entry}));
   await client.send(new DeleteBucketCommand({Bucket}));
  }
  async function repair(file:RecoveryFile){
   const record=saved.find(v=>v.file.key===file.key);assert(record);
   const bytes=await fs.readFile(record.backupPath);assert.equal(bytes.length,file.size);assert.equal(hash(bytes),file.sha256);
   await target.put(file.key,bytes,record.mime);
  }
  return {source,target,evidence,close,
   async backup(){
    await fs.mkdir(backupRoot,{mode:0o700});
    for(const key of await currentFiles(sourceBucket)){
     assert.notEqual(key,deletedKey);
     const head=await client.send(new HeadObjectCommand({Bucket:sourceBucket,Key:key}));
     assert(head.VersionId&&head.VersionId!=='null'&&head.ETag&&head.ContentType&&Number.isSafeInteger(head.ContentLength));
     const result=await client.send(new GetObjectCommand({Bucket:sourceBucket,Key:key,VersionId:head.VersionId,IfMatch:head.ETag}));
     assert.equal(result.VersionId,head.VersionId);assert(result.Body);
     const bytes=Buffer.from(await result.Body.transformToByteArray());assert.equal(bytes.length,head.ContentLength);
     const file={key,size:bytes.length,sha256:hash(bytes)},backupPath=path.join(backupRoot,String(saved.length)+'.bin');
     await fs.writeFile(backupPath,bytes,{mode:0o600});
     saved.push({file,mime:head.ContentType,version:head.VersionId,etag:head.ETag,backupPath});
     await denied(sourceBucket,key);
    }
    assert(saved.length>0);
    await fs.writeFile(path.join(backupRoot,'versions.json'),JSON.stringify(saved.map(({backupPath,...record})=>record)),{mode:0o600});
    return saved.map(v=>v.file);
   },
   async destroySource(){
    const record=saved[0],replacement=Buffer.alloc(record.file.size,88);
    await source.put(record.file.key,replacement,record.mime);
    await assert.rejects(source.openRead(record.file.key,{expected:{size:record.file.size,etag:record.etag}}),{code:'STORAGE_CHANGED'});
    await source.delete(record.file.key);await assert.rejects(source.stat(record.file.key),{code:'STORAGE_NOT_FOUND'});
    const old=await client.send(new GetObjectCommand({Bucket:sourceBucket,Key:record.file.key,VersionId:record.version}));assert(old.Body);
    assert.equal(hash(await old.Body.transformToByteArray()),record.file.sha256);evidence.versionPinning=true;
    await removeBucket(sourceBucket);
    await assert.rejects(client.send(new GetObjectCommand({Bucket:sourceBucket,Key:record.file.key,VersionId:record.version})),{name:'NoSuchBucket'});
    evidence.sourceRemoved=true;
   },
   async restore(){
    for(const record of saved)await repair(record.file);
    for(const record of saved){
     await denied(targetBucket,record.file.key);
     const head=await client.send(new HeadObjectCommand({Bucket:targetBucket,Key:record.file.key}));
     assert(head.VersionId&&head.VersionId!=='null');assert.notEqual(head.VersionId,record.version);
     assert.equal(head.ContentType,record.mime);
    }
    await assert.rejects(target.stat(deletedKey),{code:'STORAGE_NOT_FOUND'});
    evidence.anonymousDenied=true;evidence.deletedObjectAbsent=true;
    assert.notEqual(source.scope,target.scope);
   },
   async targetManifest(){
    const records:RecoveryFile[]=[];
    for(const key of await currentFiles(targetBucket)){const bytes=await target.get(key);records.push({key,size:bytes.length,sha256:hash(bytes)});}
    return records;
   },
   async corrupt(file,bytes){await target.put(file.key,bytes,'text/plain');},
   async remove(file){await target.delete(file.key);},
   repair,
  };
 }catch(error){await close();throw error;}
}
