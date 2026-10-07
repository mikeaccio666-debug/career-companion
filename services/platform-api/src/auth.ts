import { randomBytes, scrypt as rawScrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@companion/platform-contracts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import type { PoolClient } from 'pg';
import { ApiError } from './errors.ts';

const scrypt = promisify(rawScrypt);
const COOKIE = 'companion_session';
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
/** Server-captured identity for one HTTP request; never reconstructed from later window state. */
export interface FixedSessionContext { readonly userId: string; readonly tokenHash: string; }
export function fixedRequestSession(request: FastifyRequest, userId: string): FixedSessionContext {
  const token = request.cookies[COOKIE];
  if (!token || token.length > 128) throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
  return Object.freeze({userId,tokenHash:tokenHash(token)});
}
/** Match password reset's account -> session order. Recheck database time after lock waits. */
export async function authorizeFixedSession(client: PoolClient, context: FixedSessionContext, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const account = await client.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[context.userId]);
  signal?.throwIfAborted();if (!account.rowCount) throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
  const session = await client.query('SELECT token_hash FROM platform_sessions WHERE token_hash=$1 AND user_id=$2 FOR UPDATE',[context.tokenHash,context.userId]);
  signal?.throwIfAborted();if (!session.rowCount) throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
  const current = await client.query(`SELECT s.token_hash FROM platform_sessions s JOIN platform_users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.user_id=$2 AND s.auth_version=u.auth_version AND s.expires_at>clock_timestamp()`,[context.tokenHash,context.userId]);
  signal?.throwIfAborted();if (!current.rowCount) throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${hash.toString('hex')}`;
}
export async function checkPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, salt, hex] = encoded.split(':');
  if (algorithm !== 'scrypt' || !salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = await scrypt(password, salt, 64) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function insertSession(db: Pick<Database,'query'>, config: Pick<PlatformConfig,'sessionDays'>, userId: string, authVersion: string | number = '0') {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionDays * 86400_000);
  // Bind the session to the version used for password verification, never a version
  // freshly read after the check. A concurrent password reset must invalidate it.
  const inserted = await db.query(`INSERT INTO platform_sessions(token_hash,user_id,expires_at,auth_version)
    SELECT $1,id,$3,auth_version FROM platform_users WHERE id=$2 AND auth_version=$4 RETURNING token_hash`, [tokenHash(token), userId, expires, authVersion]);
  if (!inserted.rowCount) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  return {token,expires};
}
export function setSessionCookie(config: Pick<PlatformConfig,'secureCookies'>, reply: FastifyReply, session: {token:string;expires:Date}): void {
  reply.setCookie(COOKIE, session.token, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies, expires:session.expires });
}
export async function setSession(db: Database, config: PlatformConfig, reply: FastifyReply, userId: string, authVersion: string | number = '0') {
  setSessionCookie(config,reply,await insertSession(db,config,userId,authVersion));
}
export async function getUser(db: Database, request: FastifyRequest): Promise<User | undefined> {
  const token = request.cookies[COOKIE];
  if (!token || token.length > 128) return undefined;
  const result = await db.query(`SELECT u.id,u.email,u.name,(u.email_verified_at IS NOT NULL) AS "emailVerified"
    FROM platform_users u JOIN platform_sessions s ON s.user_id=u.id AND s.auth_version=u.auth_version
    WHERE s.token_hash=$1 AND s.expires_at > now()`, [tokenHash(token)]);
  return result.rows[0];
}
export async function logout(db: Database, request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies[COOKIE];
  if (token) await db.query('DELETE FROM platform_sessions WHERE token_hash=$1', [tokenHash(token)]);
  reply.clearCookie(COOKIE, { path: '/', httpOnly: true, sameSite: 'lax' });
}
