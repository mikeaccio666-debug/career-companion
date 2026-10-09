import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from './database.ts';
import { hashPassword, tokenHash } from './auth.ts';
import { ApiError, identifier, invalid } from './errors.ts';
import { encryptAccountEmail, type AccountEmailConfig, type AccountEmailPayload } from './account-mail.ts';

export type AccountActionPurpose = 'password-reset' | 'verify-email';
const actionInvalid = () => new ApiError(400,'ACCOUNT_ACTION_INVALID','This account link is invalid or has expired. Request a new email.');
const unavailable = () => new ApiError(503,'ACCOUNT_EMAIL_UNAVAILABLE','Account email is not configured or enabled. No email has been sent.');
async function confirmed<T>(run:()=>Promise<T>):Promise<T> {
  try { return await run(); }
  catch(cause) {
    if(cause instanceof ApiError)throw cause;
    throw new ApiError(503,'ACCOUNT_ACTION_UNAVAILABLE','The account action could not be confirmed. Please try again.');
  }
}
function normalizedEmail(value: string): string {
  if (typeof value !== 'string' || value.length > 254 || /[\x00-\x20\x7f<>;,]/.test(value) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw invalid('Use a valid email address.');
  return value.toLowerCase();
}
function targetHash(email: string) { return createHash('sha256').update('career-companion:account-email-target:v1\0').update(email).digest('hex'); }
async function targetAllowed(client: PoolClient, user: {id:string;email:string}, purpose: AccountActionPurpose): Promise<boolean> {
  const result = await client.query(`INSERT INTO platform_account_action_limits AS current(target_hash,purpose,request_count,expires_at,user_id)
    VALUES($1,$2,1,clock_timestamp()+interval '1 hour',$3) ON CONFLICT(target_hash,purpose) DO UPDATE SET
      request_count=CASE WHEN current.expires_at <= clock_timestamp() THEN 1 ELSE current.request_count+1 END,
      expires_at=CASE WHEN current.expires_at <= clock_timestamp() THEN clock_timestamp()+interval '1 hour' ELSE current.expires_at END
    WHERE current.user_id=EXCLUDED.user_id AND (current.expires_at <= clock_timestamp() OR current.request_count < 3) RETURNING request_count`, [targetHash(user.email),purpose,user.id]);
  return result.rowCount === 1;
}
async function revoke(client: PoolClient, userId: string, purpose?: AccountActionPurpose) {
  await client.query(`UPDATE platform_account_actions SET consumed_at=clock_timestamp() WHERE user_id=$1 AND consumed_at IS NULL${purpose?' AND purpose=$2':''}`,purpose?[userId,purpose]:[userId]);
  await client.query(`UPDATE platform_account_email_outbox o SET status='revoked',ciphertext=NULL,lease_token=NULL,lease_until=NULL,
    finished_at=clock_timestamp(),error_code=NULL WHERE o.user_id=$1 AND o.status IN ('pending','sending')${purpose?' AND EXISTS(SELECT 1 FROM platform_account_actions a WHERE a.id=o.action_id AND a.purpose=$2)':''}`,purpose?[userId,purpose]:[userId]);
}

/** Mailbox ownership changes account state; preparing a request never grants identity. */
export class AccountActions {
  constructor(private readonly db: Database, private readonly accountEmail?: AccountEmailConfig) {}

  async requestPasswordReset(email: string): Promise<void> {
    const address = normalizedEmail(email);
    if (!this.accountEmail) throw unavailable();
    await confirmed(()=>this.db.transaction(async client => {
      await client.query("SELECT set_config('statement_timeout','2000',true)");
      const result = await client.query('SELECT id,email,auth_version FROM platform_users WHERE email=$1 FOR UPDATE',[address]);
      // Unknown/deleted accounts get the same accepted response but no email
      // digest counter. Socket-IP admission still protects the public route.
      const row=result.rows[0];if(!row)return;
      const allowed = await targetAllowed(client,row,'password-reset');
      if (allowed) await this.enqueue(client,row,'password-reset');
    }));
  }

  async requestEmailVerification(userId: string): Promise<void> {
    const id = identifier(userId);
    if (!this.accountEmail) throw unavailable();
    await confirmed(()=>this.db.transaction(async client => {
      await client.query("SELECT set_config('statement_timeout','2000',true)");
      const result = await client.query('SELECT id,email,auth_version,email_verified_at FROM platform_users WHERE id=$1 FOR UPDATE',[id]);
      const row = result.rows[0]; if (!row) return;
      const allowed = await targetAllowed(client,row,'verify-email');
      if (allowed && !row.email_verified_at) await this.enqueue(client,row,'verify-email');
    }));
  }

  private async enqueue(client: PoolClient, user: {id:string;email:string;auth_version:string}, purpose: AccountActionPurpose) {
    const config = this.accountEmail!, token = randomBytes(32).toString('base64url'), id = randomUUID();
    const link = `${config.webOrigin}/#account-action=${purpose}&token=${token}`;
    const mail: AccountEmailPayload = { from:config.from,to:user.email,
      subject:purpose==='password-reset'?'Reset your Career Companion password':'Verify your Career Companion email',
      text:purpose==='password-reset'
        ? `You requested a password reset for Career Companion.\n\nOpen this link and explicitly confirm a new password:\n${link}\n\nThis link expires in 15 minutes and can be used once. If you did not request this change, ignore this email. Opening a link alone does not change your password.`
        : `You requested email verification for Career Companion.\n\nSign in to the account that requested this email, then explicitly confirm verification:\n${link}\n\nThis link expires in 15 minutes and can be used once. If you did not create or request this account, ignore this email. Opening a link alone does not verify an account.` };
    const encrypted = encryptAccountEmail(config,mail);
    const action = await client.query(`INSERT INTO platform_account_actions(id,token_hash,user_id,purpose,auth_version,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,statement_timestamp(),statement_timestamp()+interval '15 minutes') RETURNING created_at,expires_at`,[id,tokenHash(token),user.id,purpose,user.auth_version]);
    await client.query(`INSERT INTO platform_account_email_outbox(id,action_id,user_id,ciphertext,created_at,expires_at)
      VALUES($1,$1,$2,$3,$4,$5)`,[id,user.id,encrypted,action.rows[0].created_at,action.rows[0].expires_at]);
  }

  async consume(purpose: AccountActionPurpose, token: string, password?: string, verificationUserId?: string): Promise<void> {
    if (!['password-reset','verify-email'].includes(purpose) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw actionInvalid();
    if (purpose==='password-reset' && (typeof password!=='string' || password.length<10 || password.length>256)) throw new ApiError(400,'INVALID_REQUEST','Use a password from 10 to 256 characters.');
    if (purpose==='verify-email' && (password!==undefined || !verificationUserId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(verificationUserId))) throw actionInvalid();
    const digest = tokenHash(token);
    // The initial lookup conveys no authority; every condition is checked again under locks.
    const initial = await confirmed(()=>this.db.query('SELECT user_id FROM platform_account_actions WHERE token_hash=$1 AND purpose=$2',[digest,purpose]));
    const owner = initial.rows[0]?.user_id;
    if (!owner || purpose==='verify-email' && owner!==verificationUserId) throw actionInvalid();
    const encoded = purpose==='password-reset'?await confirmed(()=>hashPassword(password!)):undefined;
    await confirmed(()=>this.db.transaction(async client => {
      await client.query("SELECT set_config('statement_timeout','2000',true)");
      const user = await client.query('SELECT id,auth_version FROM platform_users WHERE id=$1 FOR UPDATE',[owner]);
      if (!user.rowCount) throw actionInvalid();
      const action = await client.query(`SELECT id FROM platform_account_actions WHERE token_hash=$1 AND purpose=$2 AND user_id=$3
        AND auth_version=$4 AND consumed_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`,[digest,purpose,owner,user.rows[0].auth_version]);
      if (!action.rowCount) throw actionInvalid();
      if (purpose==='password-reset') {
        await client.query('UPDATE platform_users SET password_hash=$2,auth_version=auth_version+1 WHERE id=$1',[owner,encoded]);
        await client.query('DELETE FROM platform_sessions WHERE user_id=$1',[owner]);
        await revoke(client,owner);
      } else {
        await client.query('UPDATE platform_users SET email_verified_at=coalesce(email_verified_at,clock_timestamp()) WHERE id=$1',[owner]);
        await revoke(client,owner,'verify-email');
      }
    }));
  }
}
