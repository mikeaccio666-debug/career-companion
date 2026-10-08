import type { PoolClient } from 'pg';
import { careerRecordId, careerRecordObject, KNOWLEDGE_RESULT_MAX_BYTES, KNOWLEDGE_SEARCH_MAX_RESULTS, type AgentSpeakerKey } from '@companion/platform-contracts';
import type { CareerKnowledgePort, CareerKnowledgePassage } from '@companion/career-core';
import type { OwnedKnowledgeAccess, CareerOwnerScope } from './career-run-context.ts';
import type { Database } from './database.ts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import { ApiError } from './errors.ts';
import { KnowledgeSources, parseKnowledgeSearchInput } from './knowledge-sources.ts';
import { OrgKnowledge } from './org-knowledge.ts';
import { parseOrgSearch } from './org-knowledge-values.ts';
export type FrozenCareerKnowledgeAccess = Awaited<ReturnType<OrgKnowledge['accessInTransaction']>> & {readonly orgScope:'none'|readonly string[]};
export interface BoundCareerKnowledge extends CareerKnowledgePort {
  /** Server-local snapshot. It is not a signed grant, persisted expert run or lease. */
  readonly frozen: FrozenCareerKnowledgeAccess;
  readKnowledgeAccess(context: CareerOwnerScope): Promise<Readonly<OwnedKnowledgeAccess>>;
  readKnowledgeAccessInTransaction(client:PoolClient,session:FixedSessionContext,signal?:AbortSignal):Promise<Readonly<OwnedKnowledgeAccess>>;
}
function unauthorized() { return new ApiError(401,'AUTH_REQUIRED','Sign in to read your knowledge sources.'); }
function notOwned() { return new ApiError(404,'NOT_FOUND','The knowledge access was not found.'); }
function session(value:FixedSessionContext) {
  try { const v=careerRecordObject(value,['userId','tokenHash']);
    if(typeof v.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(v.tokenHash)) throw unauthorized();
    return Object.freeze({userId:careerRecordId(v.userId),tokenHash:v.tokenHash});
  } catch { throw unauthorized(); }
}
function owner(scope:CareerOwnerScope,s:FixedSessionContext) {
  const v=careerRecordObject(scope,['ownerId'],['signal']);
  if(careerRecordId(v.ownerId)!==s.userId) throw notOwned();
  if(v.signal!==undefined&&!(v.signal instanceof AbortSignal)) throw new ApiError(400,'CAREER_KNOWLEDGE_INPUT_INVALID','Use supported knowledge coordinates.');
  const signal=v.signal as AbortSignal|undefined;signal?.throwIfAborted();
  return Object.freeze({ownerId:s.userId,signal});
}
/** Authenticated internal preparation/read adapter. No HTTP or model tool is
 * registered here. Actual run admission, leases and persisted expert records
 * must still be supplied by the future consumer before model use. */
export class CareerKnowledge {
  constructor(private readonly db:Database,private readonly privateSources:KnowledgeSources,private readonly organization:OrgKnowledge) {}
  async open(value:FixedSessionContext,options:unknown,signal?:AbortSignal):Promise<Readonly<BoundCareerKnowledge>> {
    const s=session(value), v=careerRecordObject(options,['speaker'],['organizationId','questions']);
    if(!['companion','guide','applier','interviewer'].includes(v.speaker as string)) throw new ApiError(403,'TOOL_NOT_ALLOWED','This reader is unavailable.');
    const speaker=v.speaker as AgentSpeakerKey, organizationId=v.organizationId===undefined?null:careerRecordId(v.organizationId);
    let questions:ReturnType<typeof parseOrgSearch>|null=null;
    if(v.questions!==undefined) {
      questions=parseOrgSearch(v.questions);
      if(questions.assetClass!=='question'||speaker==='companion'||organizationId===null) throw new ApiError(403,'TOOL_NOT_ALLOWED','Use the question reader in an available expert context.');
    }
    const frozen=await this.db.withBoundedTransaction(async c=>{
      signal?.throwIfAborted();const access=await this.organization.accessInTransaction(c,s,organizationId,signal);
      await authorizeFixedSession(c,s,signal);return Object.freeze({...access,orgScope:access.entitlementId===null?'none' as const:access.audienceGrants});
    });
    let terminalState: 'withdrawn' | 'stale' | null = null;
    const status=async(c:PoolClient,abort?:AbortSignal)=>{
      const actual=await this.organization.accessInTransaction(c,s,organizationId,abort);
      if(terminalState) return terminalState;
      if(frozen.entitlementId===null) return 'current' as const;
      if(actual.entitlementId===null) { terminalState='withdrawn'; return terminalState; }
      if(actual.entitlementId!==frozen.entitlementId||actual.entitlementRevision!==frozen.entitlementRevision||
          JSON.stringify(actual.audienceGrants)!==JSON.stringify(frozen.audienceGrants)) { terminalState='stale'; return terminalState; }
      return 'current' as const;
    };
    const orgRead=async(c:PoolClient,abort?:AbortSignal,limit?:number)=>{
      if(!questions||frozen.entitlementId===null||frozen.orgId===null) return [];
      // Only trusted structured question filters. Methods/patterns stay with skill loading.
      const input={assetClass:'question',...(questions.roleFamily===null?{}:{roleFamily:questions.roleFamily}),
        ...(questions.questionType===null?{}:{questionType:questions.questionType}),
        ...(questions.difficulty===null?{}:{difficulty:questions.difficulty}),topics:[...questions.topics],limit:limit??questions.limit};
      return this.organization.searchInTransaction(c,s,input,speaker,abort,{orgId:frozen.orgId,publishBatch:frozen.publishBatch});
    };
    const readAccess=async(c:PoolClient,actualSession:FixedSessionContext,abort?:AbortSignal)=>{
      const bound=session(actualSession);if(bound.userId!==s.userId||bound.tokenHash!==s.tokenHash) throw notOwned();
      const state=await status(c,abort);
      let empty=true;
      if(state==='current') {
        const count=await c.query('SELECT 1 FROM platform_knowledge_sources WHERE user_id=$1 AND deleted_at IS NULL LIMIT 1',[s.userId]);
        empty=!count.rowCount&&(await orgRead(c,abort,1)).length===0;
      }
      await authorizeFixedSession(c,s,abort);abort?.throwIfAborted();
      return Object.freeze({ownerId:s.userId,id:'knowledge-access:'+s.userId,revision:frozen.publishBatch,state,
        normalSummary:empty?'当前没有返回可用知识段落；一般建议仍需核对。':'知识依据来自本人资料与当前授权的组织目录；以实际引用为准。',empty});
    };
    return Object.freeze({
      frozen,
      readKnowledgeAccessInTransaction:readAccess,
      readKnowledgeAccess:async(scope:CareerOwnerScope)=>{
        const context=owner(scope,s);return this.db.withBoundedTransaction(c=>readAccess(c,s,context.signal));
      },
      search:async(scope:{ownerId:string;signal:AbortSignal},query:string)=>{
        const context=owner(scope,s);if(!(context.signal instanceof AbortSignal)) throw new ApiError(400,'CAREER_KNOWLEDGE_INPUT_INVALID','Use an abortable knowledge read.');const input=parseKnowledgeSearchInput({query,limit:KNOWLEDGE_SEARCH_MAX_RESULTS});
        return this.db.withBoundedTransaction(async c=>{
          const state=await status(c,context.signal);
          if(state!=='current') throw new ApiError(403,'NOT_ENTITLED','The frozen knowledge access changed. Prepare again.');
          const privateResult=await this.privateSources.searchInTransaction(c,s.userId,input,context.signal), orgResult=await orgRead(c,context.signal);
          const privatePassages:CareerKnowledgePassage[]=privateResult.matches.map(p=>Object.freeze({text:p.text,scope:'private' as const,
            provenanceLabel:'你的资料',provenance:'untrusted_knowledge' as const,citations:Object.freeze([Object.freeze({
              sourceId:p.sourceId,revision:p.revision,passageId:p.passageId,updatedAt:p.updatedAt,scope:'private' as const})])}));
          const orgPassages:CareerKnowledgePassage[]=orgResult.map(p=>Object.freeze({text:p.text,scope:'org' as const,assetClass:p.assetClass,
            provenanceLabel:p.provenanceLabel,provenance:'untrusted_knowledge' as const,citations:Object.freeze([Object.freeze({
              sourceId:p.sourceId,revision:p.revision,passageId:p.passageId,updatedAt:p.updatedAt,scope:'org' as const,assetClass:p.assetClass})])}));
          // Lexical private rank and structured organization order have different
          // meanings. Preserve each order and alternate instead of fabricating one score.
          const selected:CareerKnowledgePassage[]=[];
          for(let i=0;i<Math.max(privatePassages.length,orgPassages.length)&&selected.length<KNOWLEDGE_SEARCH_MAX_RESULTS;i++) {
            for(const p of [privatePassages[i],orgPassages[i]]) if(p&&selected.length<KNOWLEDGE_SEARCH_MAX_RESULTS) {
              selected.push(p);if(Buffer.byteLength(JSON.stringify(selected),'utf8')>KNOWLEDGE_RESULT_MAX_BYTES)selected.pop();
            }
          }
          if(await status(c,context.signal)!=='current') throw new ApiError(403,'NOT_ENTITLED','The frozen knowledge access changed. Prepare again.');
          await authorizeFixedSession(c,s,context.signal);context.signal!.throwIfAborted();return Object.freeze(selected);
        });
      },
    });
  }
}
