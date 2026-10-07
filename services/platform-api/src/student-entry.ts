import { createHash, randomUUID } from 'node:crypto';
import type { StudentConsentStatus, TermsAcceptance, User } from '@companion/platform-contracts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import { authorizeFixedSession, hashPassword, insertSession, type FixedSessionContext } from './auth.ts';
import { ApiError, invalid, object, string } from './errors.ts';
import { assertActiveLegal, type LegalBundle, legalUnavailable } from './legal-documents.ts';

export const inviteCodeHash = (code: string) => createHash('sha256').update(code).digest('hex');
export const invitationEmailDigest = (email: string) => createHash('sha256').update(email).digest('hex');
export function parseTermsAcceptance(value: unknown): TermsAcceptance {
  const input = object(value);
  if (Object.keys(input).some(key=>!['accepted','version','digest'].includes(key)) || input.accepted !== true
    || typeof input.version !== 'string' || /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.exec(input.version)?.[0] !== input.version
    || typeof input.digest !== 'string' || /^[0-9a-f]{64}$/.exec(input.digest)?.[0] !== input.digest) throw invalid('Explicit acceptance of the displayed legal version is required.');
  return {accepted:true,version:input.version,digest:input.digest};
}
function matchAcceptance(bundle: LegalBundle, acceptance: TermsAcceptance): void {
  if (acceptance.version !== bundle.version || acceptance.digest !== bundle.digest) throw new ApiError(409,'TERMS_VERSION_CHANGED','Read and confirm the current legal documents.');
}
/** Every public write derives identity/time from the server; no administrative activation or issuance route. */
export class StudentEntry {
  constructor(readonly db: Database, readonly config: Pick<PlatformConfig,'requireInvite'|'sessionDays'>, readonly bundle: LegalBundle | null) {}
  async availableBundle(signal?: AbortSignal): Promise<LegalBundle | null> {
    try { return await this.db.withBoundedTransaction(client=>assertActiveLegal(client,this.bundle,signal)); }
    catch (error) { signal?.throwIfAborted(); if (error instanceof ApiError && error.code === 'LEGAL_DOCUMENTS_UNAVAILABLE') return null; throw legalUnavailable(); }
  }
  async register(value: unknown, signal?: AbortSignal): Promise<{user: User; session: {token:string;expires:Date}}> {
    const input = object(value);
    if (Object.keys(input).some(key=>!['email','name','password','inviteCode','consent'].includes(key))) throw invalid('Unsupported registration field.');
    const email = string(input.email,'email',254).toLowerCase(), name = string(input.name,'name',100);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof input.password !== 'string' || input.password.length < 10 || input.password.length > 256) throw invalid('Use a valid email and a password of 10 to 256 characters.');
    const acceptance = parseTermsAcceptance(input.consent);
    const code = input.inviteCode;
    if (code !== undefined && (typeof code !== 'string' || /^[A-Za-z0-9_-]{20,128}$/.exec(code)?.[0] !== code)) throw new ApiError(400,'INVITE_INVALID','Use a valid invitation for this email.');
    if (this.config.requireInvite && code === undefined) throw new ApiError(403,'INVITE_REQUIRED','An invitation is required to register.');
    signal?.throwIfAborted(); if (!this.bundle) throw legalUnavailable();
    const passwordHash = await hashPassword(input.password); signal?.throwIfAborted();
    const userId = randomUUID();
    try {
      return await this.db.withBoundedTransaction(async client => {
        const bundle = await assertActiveLegal(client,this.bundle,signal); matchAcceptance(bundle,acceptance);
        if (code !== undefined) {
          const found = await client.query(`SELECT code_hash FROM platform_invites WHERE code_hash=$1 AND email_digest=$2
            AND redeemed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`,[inviteCodeHash(code as string),invitationEmailDigest(email)]);
          signal?.throwIfAborted(); if (!found.rowCount) throw new ApiError(403,'INVITE_INVALID','Use a valid invitation for this email.');
        }
        await client.query('INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[userId,email,name,passwordHash]);
        if (code !== undefined) {
          const claimed = await client.query(`UPDATE platform_invites SET redeemed_at=clock_timestamp(),redeemed_user_id=$3
            WHERE code_hash=$1 AND email_digest=$2 AND redeemed_at IS NULL AND expires_at>clock_timestamp() RETURNING code_hash`,[inviteCodeHash(code as string),invitationEmailDigest(email),userId]);
          if (!claimed.rowCount) throw new ApiError(403,'INVITE_INVALID','Use a valid invitation for this email.');
        }
        await client.query('INSERT INTO platform_terms_consents(user_id,terms_version,content_digest) VALUES($1,$2,$3)',[userId,bundle.version,bundle.digest]);
        const session = await insertSession(client,this.config,userId,'0'); signal?.throwIfAborted();
        return {user:{id:userId,email,name,emailVerified:false},session};
      });
    } catch (error) {
      if ((error as {code?:string;constraint?:string}).code === '23505' && (error as {constraint?:string}).constraint === 'platform_users_email_key') throw new ApiError(409,'EMAIL_EXISTS','An account already exists for this email.');
      throw error;
    }
  }
  async status(context: FixedSessionContext, signal?: AbortSignal): Promise<StudentConsentStatus> {
    const session=Object.freeze({userId:context.userId,tokenHash:context.tokenHash});
    return this.db.withBoundedTransaction(async client => {
      await authorizeFixedSession(client,session,signal);
      let bundle: LegalBundle;
      try { bundle = await assertActiveLegal(client,this.bundle,signal); }
      catch (error) { if (!(error instanceof ApiError) || error.code !== 'LEGAL_DOCUMENTS_UNAVAILABLE') throw error;
        return {userId:session.userId,status:'unavailable',version:null,digest:null}; }
      const result = await client.query('SELECT user_id FROM platform_terms_consents WHERE user_id=$1 AND terms_version=$2 AND content_digest=$3',[session.userId,bundle.version,bundle.digest]);
      await authorizeFixedSession(client,session,signal);
      return {userId:session.userId,status:result.rowCount?'current':'required',version:bundle.version,digest:bundle.digest};
    });
  }
  async accept(context: FixedSessionContext, value: unknown, signal?: AbortSignal): Promise<StudentConsentStatus> {
    const session=Object.freeze({userId:context.userId,tokenHash:context.tokenHash});
    const acceptance = parseTermsAcceptance(value);
    return this.db.withBoundedTransaction(async client=>{
      await authorizeFixedSession(client,session,signal);
      const bundle = await assertActiveLegal(client,this.bundle,signal); matchAcceptance(bundle,acceptance);
      await client.query(`INSERT INTO platform_terms_consents(user_id,terms_version,content_digest) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[session.userId,bundle.version,bundle.digest]);
      await authorizeFixedSession(client,session,signal);
      return {userId:session.userId,status:'current',version:bundle.version,digest:bundle.digest};
    });
  }
}
