import type { User } from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import { ApiError } from './errors.ts';

/** Cookie authentication for an independent resource viewer. This observation
 * creates no session, consent, execution claim, or permission to continue. */
export async function readResourceSession(db: Database, context: FixedSessionContext, signal?: AbortSignal): Promise<Readonly<User>> {
  const fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash });
  return db.withBoundedTransaction(async client => {
    await authorizeFixedSession(client, fixed, signal);
    const row = (await client.query<User & { account_kind: string }>(`SELECT id,email,name,account_kind,
      (email_verified_at IS NOT NULL) AS "emailVerified" FROM platform_users WHERE id=$1 FOR NO KEY UPDATE`, [fixed.userId])).rows[0];
    if (!row || row.account_kind !== 'student') throw new ApiError(403, 'STUDENT_ACCOUNT_REQUIRED', 'Use a student account for private resources.');
    const user = Object.freeze({ id: row.id, email: row.email, name: row.name, emailVerified: row.emailVerified === true });
    await authorizeFixedSession(client, fixed, signal);
    signal?.throwIfAborted(); return user;
  });
}
