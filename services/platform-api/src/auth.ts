import { randomBytes, scrypt as rawScrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@companion/platform-contracts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';

const scrypt = promisify(rawScrypt);
const COOKIE = 'companion_session';
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
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
export async function setSession(db: Database, config: PlatformConfig, reply: FastifyReply, userId: string) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionDays * 86400_000);
  await db.query('INSERT INTO platform_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [tokenHash(token), userId, expires]);
  reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies, expires });
}
export async function getUser(db: Database, request: FastifyRequest): Promise<User | undefined> {
  const token = request.cookies[COOKIE];
  if (!token || token.length > 128) return undefined;
  const result = await db.query('SELECT u.id,u.email,u.name FROM platform_users u JOIN platform_sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at > now()', [tokenHash(token)]);
  return result.rows[0];
}
export async function logout(db: Database, request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies[COOKIE];
  if (token) await db.query('DELETE FROM platform_sessions WHERE token_hash=$1', [tokenHash(token)]);
  reply.clearCookie(COOKIE, { path: '/', httpOnly: true, sameSite: 'lax' });
}
