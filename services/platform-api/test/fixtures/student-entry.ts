import { randomBytes } from 'node:crypto';
import type { Database } from '../../src/database.ts';
import { parseLegalBundle, legalContentDigest, type LegalBundle } from '../../src/legal-documents.ts';
import { invitationEmailDigest, inviteCodeHash } from '../../src/student-entry.ts';

/** Fictional test content, never a legally reviewed or production-active document. */
export function fictionalLegalBundle(version='fictional-v1'):LegalBundle {
  const content={version,terms:{title:'Fictional test terms',body:'Synthetic integration fixture only. This is not an approved product agreement.'},privacy:{title:'Fictional test privacy',body:'Synthetic integration fixture only. No production privacy claim.'},dataNotice:'Fictional provider disclosure used only in isolated tests.'};
  const bundle=parseLegalBundle({...content,digest:legalContentDigest(content),review:{reference:'fictional-test-review-not-legal-approval',approvedAt:'2026-01-01T00:00:00.000Z'}});
  if(!bundle)throw new Error('Fictional bundle is invalid.');return bundle;
}
export const FICTIONAL_LEGAL=fictionalLegalBundle();
export const fictionalAcceptance=(bundle:LegalBundle=FICTIONAL_LEGAL)=>({accepted:true as const,version:bundle.version,digest:bundle.digest});
/** Call explicitly only after creating a dedicated fictional schema; not an auth bypass. */
export async function seedFictionalActiveLegal(db:Pick<Database,'query'>,bundle:LegalBundle=FICTIONAL_LEGAL):Promise<void> {
  await db.query(`INSERT INTO platform_terms_policy(singleton,terms_version,content_digest,review_digest,activated_at)
    VALUES(true,$1,$2,$3,clock_timestamp()) ON CONFLICT(singleton) DO UPDATE SET terms_version=EXCLUDED.terms_version,content_digest=EXCLUDED.content_digest,review_digest=EXCLUDED.review_digest,activated_at=EXCLUDED.activated_at`,[bundle.version,bundle.digest,bundle.reviewDigest]);
}
export async function seedFictionalConsent(db:Pick<Database,'query'>,userId:string,bundle:LegalBundle=FICTIONAL_LEGAL):Promise<void> {
  await db.query('INSERT INTO platform_terms_consents(user_id,terms_version,content_digest) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[userId,bundle.version,bundle.digest]);
}
export async function seedFictionalInvite(db:Pick<Database,'query'>,email:string,code:string,expiresAt:Date=new Date(Date.now()+3600000)):Promise<void> {
  await db.query("INSERT INTO platform_invites(code_hash,email_digest,batch,expires_at) VALUES($1,$2,'B0',$3)",[inviteCodeHash(code),invitationEmailDigest(email.trim().toLowerCase()),expiresAt]);
}

/** Explicit consent on positive registration fixtures only. Negative O0 cases do not use this helper. */
export async function fictionalRegistration<T extends Record<string,unknown>>(db:Pick<Database,'query'>,input:T):Promise<T & {inviteCode:string;consent:ReturnType<typeof fictionalAcceptance>}> {
  if(typeof input.email!=='string')throw new Error('Explicit fictional registration email required.');
  const inviteCode=randomBytes(24).toString('base64url');await seedFictionalInvite(db,input.email,inviteCode);
  return {...input,inviteCode,consent:fictionalAcceptance()};
}
