import {enabledExpertRoster} from '@companion/career-core';
import {careerRecordObject,type ExpertKey} from '@companion/platform-contracts';
export interface ExpertRelease {readonly schemaVersion:1;readonly revision:number;readonly enabledExperts:readonly ExpertKey[];}
/** Operator-owned release declaration, not a tool, model, or entitlement grant. */
export function parseExpertRelease(value:unknown):Readonly<ExpertRelease>{
 try{
  const r=careerRecordObject(value,['schemaVersion','revision','enabledExperts']);
  if(r.schemaVersion!==1||!Array.isArray(r.enabledExperts)||!Number.isSafeInteger(r.revision)||(r.revision as number)<1)throw Error();
  const members=enabledExpertRoster(r.enabledExperts as readonly ExpertKey[]);
  return Object.freeze({schemaVersion:1,revision:r.revision as number,enabledExperts:Object.freeze(members.map(m=>m.key))});
 }catch{throw Error('The server expert release configuration is invalid.');}
}
export function readExpertRelease(value:string|undefined){
 if(value===undefined)return undefined;
 try{if(Buffer.byteLength(value)>2048)throw Error();return parseExpertRelease(JSON.parse(value));}
 catch{throw Error('PLATFORM_EXPERT_ROSTER_JSON must contain an explicit revision and released expert list.');}
}
