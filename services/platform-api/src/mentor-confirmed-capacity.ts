import { careerRecordId,careerRecordObject,mentorServiceInteger,mentorServiceText,parseMentorProfileCommand,parseMentorSlotCommand,
 type MentorProfileCommand,type MentorSlotCommand } from '@companion/platform-contracts';
export interface CapacityEvidence {readonly ref:string;readonly ownerId:string;readonly byteSize:number;readonly etag:string;}
export interface ConfirmedMentorCapacity {
 readonly profile:Readonly<MentorProfileCommand>;readonly profileRevision:number;readonly slot:Readonly<MentorSlotCommand>;readonly slotRevision:number;
 readonly profileProofDigest:string;readonly slotProofDigest:string;readonly profileEvidence:Readonly<CapacityEvidence>;readonly slotEvidence:Readonly<CapacityEvidence>;
}
export function parseConfirmedMentorCapacity(input:unknown):Readonly<ConfirmedMentorCapacity>{
 const v=careerRecordObject(input,['profile','profileRevision','slot','slotRevision','profileProofDigest','slotProofDigest','profileEvidence','slotEvidence']);
 const profile=parseMentorProfileCommand(v.profile),slot=parseMentorSlotCommand(v.slot),profileRevision=mentorServiceInteger(v.profileRevision,1),slotRevision=mentorServiceInteger(v.slotRevision,1);
 const evidence=(input:unknown)=>{const e=careerRecordObject(input,['ref','ownerId','byteSize','etag']);if(typeof e.etag!=='string'||!/^"[\x21\x23-\x7e]{1,198}"$/.test(e.etag))throw Error();return Object.freeze({ref:careerRecordId(e.ref),ownerId:careerRecordId(e.ownerId),byteSize:mentorServiceInteger(e.byteSize,1),etag:mentorServiceText(e.etag,200)});};
 const profileEvidence=evidence(v.profileEvidence),slotEvidence=evidence(v.slotEvidence);
 if(profile.expectedRevision+1!==profileRevision||slot.expectedRevision+1!==slotRevision||slot.profileId!==profile.recordId||slot.profileRevision!==profileRevision||
  !profile.services.includes(slot.service)||profileEvidence.ref!==profile.agreementEvidenceRef||slotEvidence.ref!==slot.confirmationEvidenceRef||
  typeof v.profileProofDigest!=='string'||!/^[0-9a-f]{64}$/.test(v.profileProofDigest)||typeof v.slotProofDigest!=='string'||!/^[0-9a-f]{64}$/.test(v.slotProofDigest))throw Error();
 return Object.freeze({profile,profileRevision,slot,slotRevision,profileProofDigest:v.profileProofDigest,slotProofDigest:v.slotProofDigest,profileEvidence,slotEvidence});
}
