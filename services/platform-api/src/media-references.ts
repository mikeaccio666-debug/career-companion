import type { Attachment, CreateJobInput, PlatformProviderRuntime } from '@companion/platform-contracts';
import { validateMediaReferenceBinding, validateMediaReferenceImages } from '@companion/ai-core';
import type { Database } from './database.ts';
import type { BlobStorage } from './storage.ts';
import { ApiError, invalid, notFound } from './errors.ts';

export const REFERENCE_IMAGE_BYTES=20*1024*1024;
const imageMimes=new Set(['image/png','image/jpeg','image/webp']);
function metadata(mime:string,size:unknown):number{
  if(!imageMimes.has(mime))throw new ApiError(415,'REFERENCE_IMAGE_UNSUPPORTED','Choose a private PNG, JPEG or WebP image as a reference.');
  const bytes=Number(size);
  if(!Number.isSafeInteger(bytes)||bytes<=0)throw invalid('The saved reference image has invalid size metadata.');
  if(bytes>REFERENCE_IMAGE_BYTES)throw new ApiError(413,'REFERENCE_IMAGE_TOO_LARGE','Reference images must be no larger than 20 MiB.');
  return bytes;
}
function imageBytes(mime:string,bytes:Uint8Array,expectedSize:number){
  if(bytes.byteLength!==expectedSize)throw new ApiError(409,'REFERENCE_IMAGE_INVALID','The saved reference image does not match its size metadata.');
  try{validateMediaReferenceImages([{name:'private-reference',mime,bytes}]);}catch{throw new ApiError(409,'REFERENCE_IMAGE_INVALID','The saved reference image does not match its media type.');}
}
export async function artifactReferenceAttachment(db:Database,storage:BlobStorage,userId:string,artifactId:string):Promise<{attachment:Attachment;source:{artifactId:string;jobId:string}}>{
  const result=await db.query('SELECT u.*,a.id AS artifact_id,a.job_id,a.mime AS artifact_mime FROM platform_artifacts a JOIN platform_uploads u ON u.id=a.upload_id JOIN platform_jobs j ON j.id=a.job_id WHERE a.id=$1 AND a.user_id=$2 AND u.user_id=$2 AND j.user_id=$2',[artifactId,userId]);
  if(!result.rowCount)throw notFound();const row=result.rows[0],size=metadata(row.mime,row.byte_size);
  if(row.artifact_mime!==row.mime)throw new ApiError(409,'REFERENCE_IMAGE_INVALID','The saved artifact and upload media types do not match.');
  imageBytes(row.mime,await storage.get(row.storage_key),size);
  return {attachment:{id:row.id,name:row.filename,mime:row.mime,size,url:`/api/platform/uploads/${row.id}`},source:{artifactId:row.artifact_id,jobId:row.job_id}};
}
export function validateReferenceImageCount(runtime:PlatformProviderRuntime,input:CreateJobInput,count:number){
  if(!count||!['image','video'].includes(input.kind))return;
  const policy=runtime.capabilities().find(provider=>provider.id===input.provider)?.referenceImages?.[input.kind as 'image'|'video'];
  if(!policy)throw new ApiError(400,'REFERENCE_IMAGES_UNSUPPORTED','The selected provider does not support private image references for this task.');
  if(!Number.isSafeInteger(policy.maxImages)||policy.maxImages<1||!Number.isSafeInteger(policy.maxTotalBytes)||policy.maxTotalBytes<1||!Array.isArray(policy.mimeTypes)||!['openai_edits','ark_video','fal_input'].includes(policy.binding))throw new ApiError(503,'REFERENCE_POLICY_INVALID','The server reference-image policy is unavailable.');
  if(count>Math.min(4,policy.maxImages))throw invalid('Choose reference images within the selected provider’s limit.');
  validateMediaReferenceBinding(input.provider,input.kind,input.options??{},count);
}
export async function validateJobImageReferences(db:Pick<Database,'query'>,storage:BlobStorage,runtime:PlatformProviderRuntime,userId:string,input:CreateJobInput,referenceCount=(input.attachmentIds??[]).length){
  const ids=input.attachmentIds??[];
  validateReferenceImageCount(runtime,input,referenceCount);
  if(!ids.length||!['image','video'].includes(input.kind))return;
  const provider=runtime.capabilities().find(provider=>provider.id===input.provider),policy=provider?.referenceImages?.[input.kind as 'image'|'video'];
  if(!policy)throw new ApiError(400,'REFERENCE_IMAGES_UNSUPPORTED','The selected provider does not support private image references for this task.');
  if(!Number.isSafeInteger(policy.maxImages)||policy.maxImages<1||!Number.isSafeInteger(policy.maxTotalBytes)||policy.maxTotalBytes<1||!Array.isArray(policy.mimeTypes)||!['openai_edits','ark_video','fal_input'].includes(policy.binding))throw new ApiError(503,'REFERENCE_POLICY_INVALID','The server reference-image policy is unavailable.');
  if(ids.length>Math.min(4,policy.maxImages)||new Set(ids).size!==ids.length)throw invalid('Choose distinct reference images within the selected provider’s limit.');
  validateMediaReferenceBinding(input.provider,input.kind,input.options??{},referenceCount);
  const found=await db.query('SELECT * FROM platform_uploads WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,ids]);
  if(found.rowCount!==ids.length)throw notFound();let total=0;
  for(const row of found.rows){
    const size=metadata(row.mime,row.byte_size);
    if(!policy.mimeTypes.includes(row.mime))throw new ApiError(415,'REFERENCE_IMAGE_UNSUPPORTED','This provider does not support the selected reference-image type.');
    if((total+=size)>Math.min(REFERENCE_IMAGE_BYTES,policy.maxTotalBytes))throw new ApiError(413,'REFERENCE_IMAGES_TOO_LARGE','The combined reference images exceed the selected provider’s limit.');
    imageBytes(row.mime,await storage.get(row.storage_key),size);
  }
}
