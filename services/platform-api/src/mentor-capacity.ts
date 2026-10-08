import { authorizeMentorStaffSource } from './mentor-staff-source.ts';
import { MentorSlotReservations } from './mentor-slot-reservations.ts';
import { parseConfirmedMentorCapacity } from './mentor-confirmed-capacity.ts';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerRecordId,careerRecordObject,mentorServiceInteger,mentorServiceTime,mentorServiceText,
  parseMentorProfileCommand,parseMentorSlotCommand,parseMentorCapacityWithdrawal,type MentorProfileCommand,type MentorSlotCommand,
  type MentorCapacityWithdrawal,type MentorCapacityKind } from '@companion/platform-contracts';
import type { Database } from './database.ts';
import type { FixedSessionContext } from './auth.ts';
import type { PlatformConfig } from './config.ts';
import type { LegalBundle } from './legal-documents.ts';
import type { BlobStorage } from './storage.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { StaffAccess } from './staff-access.ts';
import { ApiError } from './errors.ts';
const unavailable=()=>new ApiError(503,'MENTOR_CAPACITY_STORAGE_UNAVAILABLE','暂时无法确认真人导师与时段。');
const invalid=()=>new ApiError(400,'MENTOR_CAPACITY_INPUT_INVALID','请提供真实导师资料、签署凭据和确认时段。');
const changed=()=>new ApiError(409,'MENTOR_CAPACITY_REVISION_CHANGED','请先查看最新导师与时段资料。');
const missing=()=>new ApiError(404,'NOT_FOUND','没有找到这份导师与时段资料。');
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)
  ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x)).digest('hex');
type Command=Readonly<MentorProfileCommand>|Readonly<MentorSlotCommand>|Readonly<MentorCapacityWithdrawal>;
type Action=MentorCapacityKind|'withdraw';
interface Evidence {ref:string;ownerId:string;byteSize:number;etag:string;}
interface State {id:string;orgId:string;mentorId:string;kind:MentorCapacityKind;revision:number;status:'active'|'withdrawn';updatedAt:string;
  lastOperationId:string;command:Readonly<MentorProfileCommand>|Readonly<MentorSlotCommand>;evidence:Evidence;withdrawalReason:string|null;}
interface Row {id:string;org_id:string;mentor_id:string;record_kind:MentorCapacityKind;revision:number;status:string;updated_at:Date;last_operation_id:string;
  profile_id:string|null;profile_revision:number|null;profile_kind:string|null;service_kind:string|null;starts_at:Date|null;ends_at:Date|null;payload_ciphertext:Buffer;}
interface ProofRow {org_id:string;record_id:string;revision:number;operation_id:string;action:Action;created_at:Date;proof_ciphertext:Buffer;}
interface Proof {schemaVersion:1;orgId:string;recordId:string;kind:MentorCapacityKind;revision:number;operationId:string;action:Action;
  command:Command;commandDigest:string;stateDigest:string;operatedBy:string;createdAt:string;}
export interface MentorCapacityReceipt {readonly recordId:string;readonly kind:MentorCapacityKind;readonly revision:number;readonly status:'active'|'withdrawn';readonly appliedRevision:number;readonly replayed:boolean;}
/** Private operator-confirmed capacity sources, not a booking grant or a public mentor directory. */
export class MentorCapacity {
  private readonly store:OnboardingStorage;private readonly staff:StaffAccess;private readonly reservations:MentorSlotReservations;
  constructor(private readonly db:Database,config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>,legal:LegalBundle|null,
    private readonly blobs:Pick<BlobStorage,'stat'>,staff?:StaffAccess){this.store=new OnboardingStorage(config,legal);this.staff=staff??new StaffAccess(db);this.reservations=new MentorSlotReservations(config);}
  private seal(table:string,id:string,org:string,revision:number,value:unknown){
    try{if(!this.store.crypto)throw Error();return this.store.crypto.sealUtf8(JSON.stringify(value),{table,column:'payload',rowId:id,ownerId:org,revision});}catch{throw unavailable();}
  }
  private open(table:string,id:string,org:string,revision:number,cipher:Buffer):unknown {
    try{if(!this.store.crypto)throw Error();return JSON.parse(this.store.crypto.openUtf8(cipher,{table,column:'payload',rowId:id,ownerId:org,revision}));}catch{throw unavailable();}
  }
  private parse(action:Action,input:unknown):Command {
    try{return action==='profile'?parseMentorProfileCommand(input):action==='slot'?parseMentorSlotCommand(input):parseMentorCapacityWithdrawal(input);}catch{throw invalid();}
  }
  private proof(row:ProofRow):Proof {
    try{
      const p=careerRecordObject(this.open('mentor_capacity_proof',row.record_id,row.org_id,row.revision,row.proof_ciphertext),
        ['schemaVersion','orgId','recordId','kind','revision','operationId','action','command','commandDigest','stateDigest','operatedBy','createdAt']);
      if(p.schemaVersion!==1||p.orgId!==row.org_id||p.recordId!==row.record_id||p.revision!==row.revision||p.operationId!==row.operation_id||
        p.action!==row.action||p.createdAt!==row.created_at.toISOString()||!['profile','slot'].includes(p.kind as string)||
        row.action!=='withdraw'&&p.kind!==row.action||typeof p.stateDigest!=='string'||!/^[0-9a-f]{64}$/.test(p.stateDigest))throw Error();
      const command=this.parse(row.action,p.command);
      if(command.operationId!==row.operation_id||command.recordId!==row.record_id||command.expectedRevision+1!==row.revision||digest(command)!==p.commandDigest)throw Error();
      return {...p,operatedBy:careerRecordId(p.operatedBy),command} as unknown as Proof;
    }catch{throw unavailable();}
  }
  private async decode(c:PoolClient,row:Row):Promise<State>{
    try{
      const v=careerRecordObject(this.open('mentor_capacity',row.id,row.org_id,row.revision,row.payload_ciphertext),
        ['id','orgId','mentorId','kind','revision','status','updatedAt','lastOperationId','command','evidence','withdrawalReason']);
      const e=careerRecordObject(v.evidence,['ref','ownerId','byteSize','etag']);
      const command=v.kind==='profile'?parseMentorProfileCommand(v.command):v.kind==='slot'?parseMentorSlotCommand(v.command):null;
      if(!command)throw Error();
      const s:State={id:careerRecordId(v.id),orgId:careerRecordId(v.orgId),mentorId:careerRecordId(v.mentorId),kind:v.kind as MentorCapacityKind,
        revision:mentorServiceInteger(v.revision,1),status:v.status as State['status'],updatedAt:mentorServiceTime(v.updatedAt),lastOperationId:careerRecordId(v.lastOperationId),command,
        evidence:{ref:careerRecordId(e.ref),ownerId:careerRecordId(e.ownerId),byteSize:mentorServiceInteger(e.byteSize,1),etag:mentorServiceText(e.etag,200)},
        withdrawalReason:v.withdrawalReason===null?null:mentorServiceText(v.withdrawalReason,500)};
      if(s.id!==row.id||s.orgId!==row.org_id||s.mentorId!==row.mentor_id||s.kind!==row.record_kind||s.revision!==row.revision||s.status!==row.status||
        s.updatedAt!==row.updated_at.toISOString()||s.lastOperationId!==row.last_operation_id||!['active','withdrawn'].includes(s.status)||
        (s.status==='withdrawn')!==(s.withdrawalReason!==null)||command.recordId!==s.id||command.expectedRevision+1>s.revision)throw Error();
      if(s.kind==='profile'){
        const cmd=command as MentorProfileCommand;
        if(cmd.mentorId!==s.mentorId||cmd.signedAt>s.updatedAt||cmd.agreementEvidenceRef!==s.evidence.ref||
          [row.profile_id,row.profile_revision,row.profile_kind,row.service_kind,row.starts_at,row.ends_at].some(v=>v!==null))throw Error();
      }else{
        const cmd=command as MentorSlotCommand;
        if(cmd.profileId!==row.profile_id||cmd.profileRevision!==row.profile_revision||row.profile_kind!=='profile'||cmd.service!==row.service_kind||
          cmd.startsAt!==row.starts_at?.toISOString()||cmd.endsAt!==row.ends_at?.toISOString()||cmd.confirmedAt>s.updatedAt||cmd.confirmationEvidenceRef!==s.evidence.ref)throw Error();
      }
      const proofs=(await c.query<ProofRow>('SELECT * FROM platform_mentor_capacity_proofs WHERE org_id=$1 AND record_id=$2 ORDER BY revision DESC LIMIT 1 FOR SHARE',[s.orgId,s.id])).rows;
      const latest=proofs[0];if(!latest||latest.revision!==s.revision)throw Error();const p=this.proof(latest);
      if(p.stateDigest!==digest(s)||p.operationId!==s.lastOperationId||p.createdAt!==s.updatedAt||p.kind!==s.kind||
        (p.action==='withdraw')!==(s.status==='withdrawn')||p.action!=='withdraw'&&digest(p.command)!==digest(s.command))throw Error();
      return s;
    }catch{throw unavailable();}
  }
  private async read(c:PoolClient,org:string,id:string){
    const row=(await c.query<Row>('SELECT * FROM platform_mentor_capacity_records WHERE org_id=$1 AND id=$2 FOR SHARE',[org,id])).rows[0];
    if(!row)throw missing();return this.decode(c,row);
  }
  private async at(c:PoolClient){return (await c.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();}
  private async role(c:PoolClient,org:string,mentor:string){
    const r=await c.query(`SELECT r.user_id FROM platform_org_roles r JOIN platform_users u ON u.id=r.user_id
      WHERE r.org_id=$1 AND r.user_id=$2 AND r.role='mentor' AND r.status='active' AND u.account_kind='staff' AND u.email_verified_at IS NOT NULL FOR SHARE OF r,u`,[org,mentor]);
    return !!r.rowCount;
  }
  private async evidence(c:PoolClient,ref:string,owner:string,signal?:AbortSignal):Promise<Evidence>{
    const row=(await c.query('SELECT storage_key,byte_size FROM platform_uploads WHERE id=$1 AND user_id=$2 AND byte_size>0 FOR SHARE',[ref,owner])).rows[0];
    if(!row)throw missing();const actual=await this.blobs.stat(row.storage_key,signal).catch(()=>{throw unavailable();});
    const byteSize=Number(row.byte_size);
    if(!Number.isSafeInteger(byteSize)||actual.size!==byteSize||typeof actual.etag!=='string'||!/^"[\x21\x23-\x7e]{1,198}"$/.test(actual.etag))throw unavailable();
    return {ref,ownerId:owner,byteSize,etag:actual.etag};
  }
  private async validEvidence(c:PoolClient,e:Evidence,signal?:AbortSignal){
    const row=(await c.query('SELECT storage_key,byte_size FROM platform_uploads WHERE id=$1 AND user_id=$2 FOR SHARE',[e.ref,e.ownerId])).rows[0];
    if(!row)return false;
    let actual;try{actual=await this.blobs.stat(row.storage_key,signal);}catch(err){if(err instanceof ApiError&&err.status===404)return false;throw unavailable();}
    if(Number(row.byte_size)!==e.byteSize||actual.size!==e.byteSize||actual.etag!==e.etag)throw unavailable();return true;
  }
  private async eligibleProfile(c:PoolClient,s:State,signal?:AbortSignal){
    return s.kind==='profile'&&s.status==='active'&&await this.role(c,s.orgId,s.mentorId)&&await this.validEvidence(c,s.evidence,signal);
  }
  private summary(s:State){return Object.freeze({recordId:s.id,kind:s.kind,revision:s.revision,status:s.status});}
  async setProfile(session:FixedSessionContext,org:string,input:unknown,signal?:AbortSignal){return this.mutate(session,org,'profile',this.parse('profile',input),signal);}
  async setSlot(session:FixedSessionContext,org:string,input:unknown,signal?:AbortSignal){return this.mutate(session,org,'slot',this.parse('slot',input),signal);}
  async withdraw(session:FixedSessionContext,org:string,input:unknown,signal?:AbortSignal){return this.mutate(session,org,'withdraw',this.parse('withdraw',input),signal);}
  private async mutate(session:FixedSessionContext,organizationId:string,action:Action,command:Command,signal?:AbortSignal){
    const context=Object.freeze({...session}),org=careerRecordId(organizationId);
    return this.staff.readWithAccess<MentorCapacityReceipt>(context,org,{roles:['ops','org_admin'],action:action==='withdraw'?'mentor_capacity_withdrawn':'mentor_capacity_set',
      targetId:command.recordId,exclusiveOrganization:true},async c=>{
      const original=(await c.query<ProofRow>('SELECT * FROM platform_mentor_capacity_proofs WHERE org_id=$1 AND operation_id=$2 FOR SHARE',[org,command.operationId])).rows[0];
      if(original){
        const p=this.proof(original);
        if(p.action!==action||p.commandDigest!==digest(command))throw new ApiError(409,'MENTOR_CAPACITY_OPERATION_CONFLICT','操作编号已用于其他资料。');
        const current=await this.read(c,org,p.recordId);
        return {value:Object.freeze({...this.summary(current),appliedRevision:p.revision,replayed:true}),recordCount:1};
      }
      const row=(await c.query<Row>('SELECT * FROM platform_mentor_capacity_records WHERE org_id=$1 AND id=$2 FOR UPDATE',[org,command.recordId])).rows[0];
      const old=row?await this.decode(c,row):null;
      if((old?.revision??0)!==command.expectedRevision||action==='withdraw'&&!old||action!=='withdraw'&&old?.kind!==undefined&&old.kind!==action)throw changed();
      let state:State;
      if(action==='withdraw'){
        if(!old||old.status!=='active')throw changed();
        state={...old,status:'withdrawn',revision:old.revision+1,lastOperationId:command.operationId,updatedAt:await this.at(c),withdrawalReason:(command as MentorCapacityWithdrawal).reason};
      }else{
        let mentorId:string,evidence:Evidence;
        if(action==='profile'){
          const cmd=command as MentorProfileCommand;mentorId=cmd.mentorId;
          if(old&&old.mentorId!==mentorId)throw changed();
          if(!await this.role(c,org,mentorId))throw new ApiError(409,'MENTOR_CAPACITY_MENTOR_UNAVAILABLE','需要本机构已验证的真人导师员工账号。');
          if(cmd.signedAt>await this.at(c))throw invalid();
          const duplicate=await c.query("SELECT id FROM platform_mentor_capacity_records WHERE org_id=$1 AND mentor_id=$2 AND record_kind='profile' AND id<>$3 FOR SHARE",[org,mentorId,command.recordId]);
          if(duplicate.rowCount)throw new ApiError(409,'MENTOR_CAPACITY_PROFILE_CONFLICT','请更新这个导师已有的资料。');
          evidence=await this.evidence(c,cmd.agreementEvidenceRef,context.userId,signal);
        }else{
          const cmd=command as MentorSlotCommand,profile=await this.read(c,org,cmd.profileId);
          if(profile.kind!=='profile'||profile.revision!==cmd.profileRevision||!await this.eligibleProfile(c,profile,signal)||
            !(profile.command as MentorProfileCommand).services.includes(cmd.service))throw new ApiError(409,'MENTOR_CAPACITY_PROFILE_UNAVAILABLE','请先确认当前导师与服务资料。');
          mentorId=profile.mentorId;if(old&&old.mentorId!==mentorId)throw changed();
          if(cmd.confirmedAt>await this.at(c))throw invalid();
          evidence=await this.evidence(c,cmd.confirmationEvidenceRef,context.userId,signal);
          // A mentor can belong to several organizations. Serialize their source windows
          // without returning any other organization's private schedule.
          await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['mentor_capacity:'+mentorId]);
          if(await this.reservations.overlapInTransaction(c,mentorId,cmd.startsAt,cmd.endsAt,signal))throw new ApiError(409,'MENTOR_SLOT_RESERVED','这个时段已有预约，请重新核对。');
          // Authenticate source projections before comparing windows: a changed
          // SQL status/time must not make an encrypted committed window disappear.
          const windows=(await c.query<Row>(`SELECT * FROM platform_mentor_capacity_records
            WHERE mentor_id=$1 AND record_kind='slot' AND id<>$2 ORDER BY id`,[mentorId,command.recordId])).rows;
          for(const row of windows){
            signal?.throwIfAborted();const other=await this.decode(c,row),window=other.command as MentorSlotCommand;
            const source=await this.read(c,other.orgId,window.profileId);
            if(other.status==='active'&&source.status==='active'&&source.revision===window.profileRevision&&
              window.startsAt<cmd.endsAt&&window.endsAt>cmd.startsAt)
              throw new ApiError(409,'MENTOR_CAPACITY_SLOT_CONFLICT','这个导师的时段有重叠，请先重新核对。');
          }
        }
        const at=await this.at(c);
        if(action==='slot'&&(command as MentorSlotCommand).startsAt<=at)throw new ApiError(409,'MENTOR_CAPACITY_SLOT_EXPIRED','这个时段已开始，请重新确认。');
        state={id:command.recordId,orgId:org,mentorId,kind:action,revision:command.expectedRevision+1,status:'active',updatedAt:at,
          lastOperationId:command.operationId,command:command as MentorProfileCommand|MentorSlotCommand,evidence,withdrawalReason:null};
      }
      const proof:Proof={schemaVersion:1,orgId:org,recordId:state.id,kind:state.kind,revision:state.revision,operationId:command.operationId,action,command,
        commandDigest:digest(command),stateDigest:digest(state),operatedBy:careerRecordId(context.userId),createdAt:state.updatedAt};
      await c.query(`INSERT INTO platform_mentor_capacity_proofs(org_id,record_id,revision,operation_id,action,created_at,proof_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [org,state.id,state.revision,command.operationId,action,state.updatedAt,this.seal('mentor_capacity_proof',state.id,org,state.revision,proof)]);
      const slot=state.kind==='slot'?state.command as MentorSlotCommand:null;
      const saved=await c.query(`INSERT INTO platform_mentor_capacity_records(id,org_id,mentor_id,record_kind,status,revision,last_operation_id,updated_at,
        profile_id,profile_revision,profile_kind,service_kind,starts_at,ends_at,payload_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,revision=EXCLUDED.revision,last_operation_id=EXCLUDED.last_operation_id,updated_at=EXCLUDED.updated_at,
          profile_id=EXCLUDED.profile_id,profile_revision=EXCLUDED.profile_revision,profile_kind=EXCLUDED.profile_kind,service_kind=EXCLUDED.service_kind,
          starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,payload_ciphertext=EXCLUDED.payload_ciphertext
        WHERE platform_mentor_capacity_records.org_id=EXCLUDED.org_id AND platform_mentor_capacity_records.mentor_id=EXCLUDED.mentor_id
          AND platform_mentor_capacity_records.record_kind=EXCLUDED.record_kind AND platform_mentor_capacity_records.revision=EXCLUDED.revision-1 RETURNING id`,
        [state.id,org,state.mentorId,state.kind,state.status,state.revision,state.lastOperationId,state.updatedAt,slot?.profileId??null,slot?.profileRevision??null,
          slot?'profile':null,slot?.service??null,slot?.startsAt??null,slot?.endsAt??null,this.seal('mentor_capacity',state.id,org,state.revision,state)]);
      if(saved.rowCount!==1)throw changed();
      signal?.throwIfAborted();
      return {value:Object.freeze({...this.summary(state),appliedRevision:state.revision,replayed:false}),recordCount:1};
    },signal);
  }
  /** Staff-authorized source capture in the matching caller's transaction; no standalone issuer. */
  async confirmedInTransaction(c:PoolClient,session:FixedSessionContext,organizationId:string,slotId:string,revision:number,signal?:AbortSignal){
    const org=careerRecordId(organizationId),context=Object.freeze({...session});await authorizeMentorStaffSource(c,context,org,signal);
    const slot=await this.read(c,org,careerRecordId(slotId));
    if(slot.kind!=='slot'||slot.status!=='active'||slot.revision!==revision)throw changed();
    const cmd=slot.command as MentorSlotCommand,profile=await this.read(c,org,cmd.profileId);
    if(profile.revision!==cmd.profileRevision||!await this.eligibleProfile(c,profile,signal)||!await this.validEvidence(c,slot.evidence,signal))
      throw new ApiError(409,'MENTOR_CAPACITY_PROFILE_UNAVAILABLE','请先确认当前导师与服务资料。');
    if(cmd.startsAt<=await this.at(c))throw new ApiError(409,'MENTOR_CAPACITY_SLOT_EXPIRED','这个时段已开始，请重新确认。');
    await authorizeMentorStaffSource(c,context,org,signal);signal?.throwIfAborted();
    return parseConfirmedMentorCapacity({profile:profile.command,profileRevision:profile.revision,slot:slot.command,slotRevision:slot.revision,
      profileProofDigest:digest(profile),slotProofDigest:digest(slot),profileEvidence:profile.evidence,slotEvidence:slot.evidence});
  }
  async observe(session:FixedSessionContext,organizationId:string,operationId:string,signal?:AbortSignal){
    const org=careerRecordId(organizationId),op=careerRecordId(operationId);
    return this.staff.readWithAccess(session,org,{roles:['ops','org_admin'],action:'mentor_capacity_viewed'},async c=>{
      const row=(await c.query<ProofRow>('SELECT * FROM platform_mentor_capacity_proofs WHERE org_id=$1 AND operation_id=$2 FOR SHARE',[org,op])).rows[0];
      if(!row)throw missing();const p=this.proof(row),state=await this.read(c,org,p.recordId);
      return {value:Object.freeze({...this.summary(state),appliedRevision:p.revision,replayed:true}),recordCount:1};
    },signal);
  }
  async list(session:FixedSessionContext,organizationId:string,kind:MentorCapacityKind,input:unknown={},signal?:AbortSignal){
    const org=careerRecordId(organizationId);let after:string|null;
    try{if(!['profile','slot'].includes(kind))throw Error();const v=careerRecordObject(input,[],['after']);after=v.after===undefined?null:careerRecordId(v.after);}catch{throw invalid();}
    return this.staff.readWithAccess(session,org,{roles:['ops','org_admin'],action:'mentor_capacity_viewed'},async c=>{
      if(after){const anchor=await this.read(c,org,after);if(anchor.kind!==kind)throw missing();}
      const rows=(await c.query<Row>(`SELECT * FROM platform_mentor_capacity_records WHERE org_id=$1 AND record_kind=$2 AND ($3::uuid IS NULL OR id>$3)
        ORDER BY id LIMIT 51 FOR SHARE`,[org,kind,after])).rows;
      const records=[];
      for(const row of rows.slice(0,50)){
        signal?.throwIfAborted();const s=await this.decode(c,row);
        if(kind==='profile'){
          const cmd=s.command as MentorProfileCommand,eligible=await this.eligibleProfile(c,s,signal);
          records.push(Object.freeze({...this.summary(s),mentorId:s.mentorId,displayName:cmd.displayName,timeZone:cmd.timeZone,languages:cmd.languages,
            services:cmd.services,signedAt:cmd.signedAt,conductVersion:cmd.conductVersion,eligible}));
        }else{
          const cmd=s.command as MentorSlotCommand,profile=await this.read(c,org,cmd.profileId);
          const eligible=s.status==='active'&&profile.revision===cmd.profileRevision&&await this.eligibleProfile(c,profile,signal)&&
            await this.validEvidence(c,s.evidence,signal)&&!await this.reservations.overlapInTransaction(c,s.mentorId,cmd.startsAt,cmd.endsAt,signal);
          records.push(Object.freeze({...this.summary(s),mentorId:s.mentorId,profileId:cmd.profileId,profileRevision:cmd.profileRevision,service:cmd.service,
            startsAt:cmd.startsAt,endsAt:cmd.endsAt,timeZone:cmd.timeZone,confirmedAt:cmd.confirmedAt,eligible}));
        }
      }
      const at=await this.at(c),finalRecords=kind==='slot'?records.map(r=>Object.freeze({...r,eligible:r.eligible&&'startsAt' in r&&typeof r.startsAt==='string'&&r.startsAt>at})):records;
      signal?.throwIfAborted();return {value:Object.freeze({records:Object.freeze(finalRecords),nextCursor:rows.length>50?records.at(-1)!.recordId:null}),recordCount:records.length};
    },signal);
  }
}
