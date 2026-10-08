import type { PoolClient } from 'pg';
import { careerRecordObject,careerRecordId,mentorServiceInteger } from '@companion/platform-contracts';
import type { BlobStorage } from './storage.ts';
import { ApiError } from './errors.ts';
export interface MentorReceiptEvidence {readonly ref:string;readonly ownerId:string;readonly byteSize:number;readonly etag:string;}
export function parseMentorReceiptEvidence(input:unknown):Readonly<MentorReceiptEvidence>{
 const v=careerRecordObject(input,['ref','ownerId','byteSize','etag']);
 if(typeof v.etag!=='string'||!/^"[\x21\x23-\x7e]{1,198}"$/.test(v.etag))throw Error();
 return Object.freeze({ref:careerRecordId(v.ref),ownerId:careerRecordId(v.ownerId),byteSize:mentorServiceInteger(v.byteSize,1),etag:v.etag});
}
export async function captureMentorReceiptEvidence(c:PoolClient,blobs:Pick<BlobStorage,'stat'>,owner:string,ref:string,signal?:AbortSignal,purpose:'payment'|'scheduling'='payment'){
 const code=purpose==='scheduling'?'MENTOR_SCHEDULING_EVIDENCE_UNAVAILABLE':'MENTOR_PAYMENT_EVIDENCE_UNAVAILABLE';
 const row=(await c.query('SELECT storage_key,byte_size FROM platform_uploads WHERE user_id=$1 AND id=$2 AND byte_size>0 FOR SHARE',[owner,ref])).rows[0];
 if(!row)throw new ApiError(409,code,purpose==='scheduling'?'需要运营本人保存的实际双方确认或取消凭据。':'需要本人保存的实际收款、退款或保留政策凭据。');
 const actual=await blobs.stat(row.storage_key,signal).catch(()=>{throw new ApiError(503,code,'暂时无法确认凭据文件。');});
 if(actual.size!==Number(row.byte_size))throw new ApiError(503,code,'暂时无法确认凭据文件。');
 signal?.throwIfAborted();return parseMentorReceiptEvidence({ref,ownerId:owner,byteSize:Number(row.byte_size),etag:actual.etag});
}
