import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { CAREER_SKILLS,type CareerSkillId,type CareerRunContext } from '@companion/career-core';
import { careerRecordObject,careerRecordId } from '@companion/platform-contracts';
import { authorizeFixedSession,type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { CareerTargets } from './career-targets.ts';
import type { CareerStories } from './career-stories.ts';
import type { ResumeOriginalReview } from './resume-original-review.ts';
import { buildCareerRunContext,type OwnedCareerTarget,type OwnedCareerResume,type OwnedCareerEvidence,type OwnedCareerInput,type CareerInputSelection } from './career-run-context.ts';
import { ApiError } from './errors.ts';

export interface CareerPreparationSourceIndex {
 readonly kind:'owned_career_preparation_source_index'; readonly ownerId:string;
 /** Content address of actual current metadata, not a persisted expert run. */
 readonly indexId:string;
 readonly targets:readonly Readonly<OwnedCareerTarget>[];
 readonly projects:readonly Readonly<OwnedCareerEvidence>[];
 readonly stories:readonly Readonly<OwnedCareerInput>[];
 /** null means no actual adapter, not an invented empty collection. */
 readonly resumes:readonly Readonly<OwnedCareerResume>[]|null;
}
const bad=()=>new ApiError(400,'CAREER_PREPARATION_INPUT_INVALID','Use saved preparation coordinates.');
function fixed(value:FixedSessionContext){
 try{const v=careerRecordObject(value,['userId','tokenHash']);if(typeof v.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(v.tokenHash))throw bad();return Object.freeze({userId:careerRecordId(v.userId),tokenHash:v.tokenHash});}
 catch{throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');}
}
const canonical=(value:unknown)=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
function request(value:unknown):{skillId:CareerSkillId;selection:CareerInputSelection}{
 try{
  const r=careerRecordObject(value,['skillId'],['selection']);if(!CAREER_SKILLS.some(s=>s.id===r.skillId))throw bad();
  const selection:CareerInputSelection={};
  if(Object.hasOwn(r,'selection')){
   const s=careerRecordObject(r.selection,[],['targetId','projectId','resumeId']);
   for(const key of ['targetId','projectId','resumeId'] as const)if(Object.hasOwn(s,key))selection[key]=careerRecordId(s[key]);
  }
  return {skillId:r.skillId as CareerSkillId,selection:Object.freeze(selection)};
 }catch{throw bad();}
}
/** Actual owned source composition shared by application assembly. No student
 * endpoint, capability registration, fake profile, knowledge batch, turn,
 * source safety grade, model use, review or execution lease is created here. */
export class CareerPreparationSources {
 constructor(private readonly db:Database,private readonly targets:Pick<CareerTargets,'readForPreparationInTransaction'>,
  private readonly library:Pick<CareerStories,'readPreparationIndexInTransaction'>,
  private readonly resumeVersions?:Pick<ResumeOriginalReview,'readForPreparationInTransaction'>){}
 async readInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):Promise<Readonly<CareerPreparationSourceIndex>>{
  const context=fixed(value);await authorizeFixedSession(client,context,signal);
  // Sequential reads share this exact bounded transaction and owner lock.
  const targets=await this.targets.readForPreparationInTransaction(client,context,signal);
  const {projects,stories}=await this.library.readPreparationIndexInTransaction(client,context,signal);
  const resumes=this.resumeVersions?await this.resumeVersions.readForPreparationInTransaction(client,context,signal):null;
  await authorizeFixedSession(client,context,signal);signal?.throwIfAborted();
  const content={kind:'owned_career_preparation_source_index' as const,ownerId:context.userId,targets,projects,stories,resumes};
  return Object.freeze({...content,indexId:'career_index_'+createHash('sha256').update(canonical(content)).digest('hex')});
 }
 async read(value:FixedSessionContext,signal?:AbortSignal){
  const context=fixed(value);return this.db.withBoundedTransaction(client=>this.readInTransaction(client,context,signal));
 }
 /** Current coordinate comparison only. Must be in the real consumer's
  * bounded transaction; callers still need actual source-body admission. */
 async assertCurrentInTransaction(client:PoolClient,value:FixedSessionContext,expected:unknown,signal?:AbortSignal){
  const context=fixed(value);let e:Record<string,unknown>;
  try{e=careerRecordObject(expected,['ownerId','indexId']);careerRecordId(e.ownerId);if(typeof e.indexId!=='string'||!/^career_index_[0-9a-f]{64}$/.test(e.indexId))throw bad();}catch{throw bad();}
  if(e.ownerId!==context.userId)throw new ApiError(404,'NOT_FOUND','The preparation source was not found.');
  const current=await this.readInTransaction(client,context,signal);
  if(current.indexId!==e.indexId)throw new ApiError(409,'CAREER_PREPARATION_SOURCE_CHANGED','Read the current saved facts before continuing.');
  return current;
 }
 async buildInTransaction(client:PoolClient,value:FixedSessionContext,input:unknown,
  tools:CareerRunContext['tools'],signal?:AbortSignal){
  const context=fixed(value),r=request(input),sourceIndex=await this.readInTransaction(client,context,signal);
  const assertScope=(scope:{ownerId:string})=>{if(scope.ownerId!==context.userId)throw new ApiError(404,'NOT_FOUND','The preparation source was not found.');signal?.throwIfAborted();};
  const built=await buildCareerRunContext({ownerId:context.userId,skillId:r.skillId,selection:r.selection,signal,tools,ports:{
   listTargets:async scope=>{assertScope(scope);return sourceIndex.targets;},
   listEvidence:async scope=>{assertScope(scope);return sourceIndex.projects;},
   ...(sourceIndex.resumes===null?{}:{listResumeVersions:async (scope:{ownerId:string})=>{assertScope(scope);return sourceIndex.resumes!;}}),
  }});
  await authorizeFixedSession(client,context,signal);signal?.throwIfAborted();
  return Object.freeze({sourceIndex,built});
 }
 /** Safe inspection with no executors. Missing profile, tool implementations
  * and other true ports stay missing; source availability is not skill readiness. */
 async prepare(value:FixedSessionContext,input:unknown,signal?:AbortSignal){
  const context=fixed(value);request(input);
  return this.db.withBoundedTransaction(client=>this.buildInTransaction(client,context,input,{},signal));
 }
}
