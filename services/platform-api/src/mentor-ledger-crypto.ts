import { createHash } from 'node:crypto';
import type { PlatformConfig } from './config.ts';
import { ApiError } from './errors.ts';
export const mentorLedgerDigest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)
 ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x)).digest('hex');
export class MentorLedgerCrypto {
 private readonly crypto:PlatformConfig['dataCrypto'];
 constructor(config:Pick<PlatformConfig,'dataCrypto'>){this.crypto=config.dataCrypto;}
 seal(table:string,id:string,owner:string,revision:number,value:unknown){
  try{if(!this.crypto)throw Error();return this.crypto.sealUtf8(JSON.stringify(value),{table,column:'payload',rowId:id,ownerId:owner,revision});}
  catch{throw new ApiError(503,'MENTOR_ORDER_STORAGE_UNAVAILABLE','暂时无法确认真人预约与订单。');}
 }
 open(table:string,id:string,owner:string,revision:number,cipher:Buffer):unknown{
  try{if(!this.crypto)throw Error();return JSON.parse(this.crypto.openUtf8(cipher,{table,column:'payload',rowId:id,ownerId:owner,revision}));}
  catch{throw new ApiError(503,'MENTOR_ORDER_STORAGE_UNAVAILABLE','暂时无法确认真人预约与订单。');}
 }
}
