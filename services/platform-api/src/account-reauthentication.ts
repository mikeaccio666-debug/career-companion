import { createHash, randomBytes } from 'node:crypto';
import { accountPrivacyPurpose, parseAccountReauthentication, type AccountPrivacyPurpose, type AccountPrivacyProof } from '@companion/platform-contracts';
import type { PoolClient } from 'pg';
import type { Database } from './database.ts';
import { authorizeFixedSession, checkPassword, type FixedSessionContext } from './auth.ts';
import { ApiError } from './errors.ts';

const invalid = () => new ApiError(400, 'ACCOUNT_REAUTH_INPUT_INVALID', 'Choose the privacy action and enter your current password.');
const denied = () => new ApiError(401, 'ACCOUNT_REAUTH_REQUIRED', 'Verify your current password again for this privacy action.');
const unavailable = () => new ApiError(503, 'ACCOUNT_REAUTH_UNAVAILABLE', 'Password verification could not be confirmed. Try again.');
const digest = (token: string) => createHash('sha256').update('career-companion:privacy-proof:v1\0').update(token).digest('hex');

function sessionSnapshot(value: FixedSessionContext): Readonly<FixedSessionContext> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw denied();
  const d = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== 2 || !d.userId || !d.tokenHash || Object.values(d).some(v => !('value' in v) || !v.enumerable)
    || typeof d.userId.value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d.userId.value)
    || typeof d.tokenHash.value !== 'string' || !/^[0-9a-f]{64}$/.test(d.tokenHash.value)) throw denied();
  return Object.freeze({ userId: d.userId.value, tokenHash: d.tokenHash.value });
}
/** Only verifies account identity. The actual export/delete must consume the
 * proof inside its own database transaction and enforce its own data policy. */
export class AccountReauthentication {
  constructor(private readonly db: Database) {}
  async verify(fixed: FixedSessionContext, command: unknown, signal?: AbortSignal): Promise<Readonly<AccountPrivacyProof>> {
    fixed = sessionSnapshot(fixed);
    let input; try { input = parseAccountReauthentication(command); } catch { throw invalid(); }
    try {
      const captured = await this.db.withBoundedTransaction(async client => {
        await authorizeFixedSession(client, fixed, signal);
        return (await client.query<{ password_hash: string; auth_version: string }>('SELECT password_hash,auth_version FROM platform_users WHERE id=$1', [fixed.userId])).rows[0];
      });
      signal?.throwIfAborted();
      // Expensive password work holds no database connection or account lock.
      const valid = await checkPassword(input.password, captured.password_hash);
      signal?.throwIfAborted(); if (!valid) throw denied();
      const token = randomBytes(32).toString('base64url');
      return await this.db.withBoundedTransaction(async client => {
        await authorizeFixedSession(client, fixed, signal);
        const now = await client.query('SELECT id FROM platform_users WHERE id=$1 AND auth_version=$2 AND password_hash=$3', [fixed.userId, captured.auth_version, captured.password_hash]);
        if (now.rowCount !== 1) throw denied();
        const result = await client.query<{ expires_at: Date }>(`INSERT INTO platform_account_reauthentications
          (user_id,session_hash,purpose,proof_hash,auth_version,verified_at,expires_at)
          SELECT u.id,s.token_hash,$3,$4,u.auth_version,statement_timestamp(),statement_timestamp()+interval '5 minutes'
          FROM platform_users u JOIN platform_sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.token_hash=$2
            AND u.auth_version=$5 AND s.auth_version=u.auth_version AND s.expires_at>clock_timestamp() AND u.password_hash=$6
          ON CONFLICT(user_id,session_hash,purpose) DO UPDATE SET proof_hash=EXCLUDED.proof_hash,
            auth_version=EXCLUDED.auth_version,verified_at=EXCLUDED.verified_at,expires_at=EXCLUDED.expires_at,consumed_at=NULL
          RETURNING expires_at`, [fixed.userId, fixed.tokenHash, input.purpose, digest(token), captured.auth_version, captured.password_hash]);
        signal?.throwIfAborted(); if (result.rowCount !== 1) throw denied();
        return Object.freeze({ ownerId: fixed.userId, purpose: input.purpose, token, expiresAt: result.rows[0].expires_at.toISOString() });
      });
    } catch (error) { if (signal?.aborted) signal.throwIfAborted(); if (error instanceof ApiError) throw error; throw unavailable(); }
  }
  /** No HTTP consume endpoint: callers must couple consumption to the actual
   * operation COMMIT. Rollback leaves the proof unconsumed for a safe retry. */
  async consumeInTransaction(client: PoolClient, fixed: FixedSessionContext, purpose: AccountPrivacyPurpose, token: string, signal?: AbortSignal): Promise<void> {
    try {
      fixed = sessionSnapshot(fixed);
      accountPrivacyPurpose(purpose);
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw denied();
      await authorizeFixedSession(client, fixed, signal);
      const consumed = await client.query(`UPDATE platform_account_reauthentications p SET consumed_at=clock_timestamp()
        FROM platform_users u,platform_sessions s WHERE p.user_id=$1 AND p.session_hash=$2 AND p.purpose=$3 AND p.proof_hash=$4
        AND p.consumed_at IS NULL AND p.expires_at>clock_timestamp() AND p.verified_at<=clock_timestamp()
        AND u.id=p.user_id AND p.auth_version=u.auth_version AND s.token_hash=p.session_hash AND s.user_id=p.user_id
        AND s.auth_version=u.auth_version AND s.expires_at>clock_timestamp() RETURNING p.user_id`, [fixed.userId, fixed.tokenHash, purpose, digest(token)]);
      signal?.throwIfAborted(); if (consumed.rowCount !== 1) throw denied();
    } catch (error) { if (signal?.aborted) signal.throwIfAborted(); if (error instanceof ApiError) throw error; throw denied(); }
  }
}
