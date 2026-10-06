import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from './database.ts';

export interface AccountEmailConfig { apiKey: string; from: string; webOrigin: string; encryptionKey: Buffer; }
export interface AccountEmailPayload { from: string; to: string; subject: string; text: string; }
export interface AccountEmailProcessOptions { fetch?: typeof globalThis.fetch; limit?: number; timeoutMs?: number; }

const endpoint = 'https://api.resend.com/emails';
const aad = Buffer.from('career-companion:account-email:v1');
const invalidConfiguration = () => new Error('Account email configuration is invalid.');
const invalidPayload = () => new Error('Account email payload could not be read.');
const controls = /[\x00-\x1f\x7f]/;
const email = /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/;
function recipient(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && !controls.test(value) && email.test(value);
}
function sender(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 320 || controls.test(value) || value.trim() !== value) return false;
  if (recipient(value)) return true;
  const match = /^([^<>,;]+) <([^<>]+)>$/.exec(value);
  return !!match && match[1].trim().length > 0 && recipient(match[2]);
}
function key(config: AccountEmailConfig) {
  if (!Buffer.isBuffer(config.encryptionKey) || config.encryptionKey.length !== 32) throw invalidConfiguration();
  return config.encryptionKey;
}

/** Opt-in is server-owned. Disabled development never validates or contacts a mail service. */
export function readAccountEmailConfig(env: NodeJS.ProcessEnv, allowedOrigins: ReadonlySet<string>): AccountEmailConfig | undefined {
  const allow = env.PLATFORM_ALLOW_ACCOUNT_EMAIL;
  if (allow === undefined || allow === '0') return undefined;
  if (allow !== '1') throw invalidConfiguration();
  const apiKey = env.RESEND_API_KEY, from = env.PLATFORM_ACCOUNT_EMAIL_FROM;
  const webOrigin = env.PLATFORM_ACCOUNT_WEB_ORIGIN, encryptionKey = env.PLATFORM_ACCOUNT_EMAIL_ENCRYPTION_KEY;
  if (!apiKey || apiKey.length > 4096 || /[^\x21-\x7e]/.test(apiKey) || !sender(from) || !webOrigin || !encryptionKey || !/^[0-9a-f]{64}$/i.test(encryptionKey)) throw invalidConfiguration();
  let parsed: URL;
  try { parsed = new URL(webOrigin); } catch { throw invalidConfiguration(); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (!allowedOrigins.has(webOrigin) || parsed.origin !== webOrigin || parsed.username || parsed.password || parsed.hostname.includes('*')
    || /[\x00-\x20\x7f]/.test(webOrigin) || !(parsed.protocol === 'https:' || parsed.protocol === 'http:' && loopback)) throw invalidConfiguration();
  return { apiKey, from, webOrigin, encryptionKey: Buffer.from(encryptionKey, 'hex') };
}

function payload(value: unknown): AccountEmailPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidPayload();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== 4 || Object.keys(data).some(field => !['from','to','subject','text'].includes(field))
    || !sender(data.from) || !recipient(data.to) || typeof data.subject !== 'string' || !data.subject.length || data.subject.length > 200 || controls.test(data.subject)
    || typeof data.text !== 'string' || !data.text.length || Buffer.byteLength(data.text, 'utf8') > 16 * 1024 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(data.text)) throw invalidPayload();
  return { from: data.from, to: data.to, subject: data.subject, text: data.text };
}
export function encryptAccountEmail(config: AccountEmailConfig, value: AccountEmailPayload): Buffer {
  const canonical = payload(value), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(config), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(canonical), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
}
export function decryptAccountEmail(config: AccountEmailConfig, ciphertext: Buffer): AccountEmailPayload {
  try {
    // A valid 16 KiB body may nearly double when JSON escapes tabs, newlines or backslashes.
    if (!Buffer.isBuffer(ciphertext) || ciphertext.length < 30 || ciphertext.length > 40 * 1024 || ciphertext[0] !== 1) throw invalidPayload();
    const decipher = createDecipheriv('aes-256-gcm', key(config), ciphertext.subarray(1,13));
    decipher.setAAD(aad); decipher.setAuthTag(ciphertext.subarray(13,29));
    const plain = Buffer.concat([decipher.update(ciphertext.subarray(29)), decipher.final()]);
    return payload(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)));
  } catch { throw invalidPayload(); }
}

interface ClaimedEmail { id: string; ciphertext: Buffer; lease_token: string; attempts: number; }
async function claimEmail(db: Database): Promise<ClaimedEmail | undefined> {
  return db.transaction(async client => {
    await client.query("SELECT set_config('statement_timeout','2000',true)");
    await client.query(`WITH stale AS (
      SELECT o.id FROM platform_account_email_outbox o JOIN platform_account_actions a ON a.id=o.action_id
      JOIN platform_users u ON u.id=o.user_id
      WHERE o.status IN ('pending','sending') AND (o.expires_at <= clock_timestamp() OR a.expires_at <= clock_timestamp()
        OR a.consumed_at IS NOT NULL OR a.auth_version <> u.auth_version)
      ORDER BY o.expires_at LIMIT 128 FOR UPDATE OF o SKIP LOCKED
    ) UPDATE platform_account_email_outbox o SET status='expired',ciphertext=NULL,lease_token=NULL,lease_until=NULL,
      finished_at=clock_timestamp(),error_code=NULL FROM stale WHERE o.id=stale.id`);
    const lease = randomUUID();
    const claimed = await client.query(`WITH available AS (
      SELECT o.id FROM platform_account_email_outbox o JOIN platform_account_actions a ON a.id=o.action_id
      JOIN platform_users u ON u.id=o.user_id
      WHERE o.expires_at > clock_timestamp() AND a.expires_at > clock_timestamp() AND a.consumed_at IS NULL
        AND a.auth_version=u.auth_version AND o.next_attempt_at <= clock_timestamp()
        AND (o.status='pending' OR o.status='sending' AND o.lease_until <= clock_timestamp())
      ORDER BY o.created_at,o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED
    ) UPDATE platform_account_email_outbox o SET status='sending',lease_token=$1,lease_until=clock_timestamp()+interval '30 seconds',
      attempts=o.attempts+1 FROM available WHERE o.id=available.id RETURNING o.id,o.ciphertext,o.lease_token,o.attempts`, [lease]);
    return claimed.rows[0];
  });
}

async function receipt(response: Response): Promise<string> {
  if (!response.ok || !response.body) throw new Error('Account email delivery failed.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8192) throw new Error('Account email delivery failed.');
      chunks.push(part.value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || typeof data.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(data.id)) throw new Error('Account email delivery failed.');
    return data.id;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Returns attempted messages, not a claim that their recipients received mail. */
export async function processAccountEmails(db: Database, config?: AccountEmailConfig, options: AccountEmailProcessOptions = {}): Promise<number> {
  if (!config) return 0;
  const limit = options.limit ?? 8, timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15_000) throw invalidConfiguration();
  key(config);
  let attempted = 0;
  for (; attempted < limit; attempted++) {
    const item = await claimEmail(db); if (!item) break;
    let fixedPayload: AccountEmailPayload;
    try { fixedPayload = decryptAccountEmail(config, item.ciphertext); }
    catch {
      await db.query(`UPDATE platform_account_email_outbox SET status='failed',ciphertext=NULL,lease_token=NULL,lease_until=NULL,
        finished_at=clock_timestamp(),error_code='ACCOUNT_EMAIL_PAYLOAD_INVALID' WHERE id=$1 AND status='sending' AND lease_token=$2`, [item.id,item.lease_token]);
      continue;
    }
    // Recheck authorization immediately before dispatch. A concurrently consumed link can
    // still be in an in-flight message, but it can never authorize another account change.
    const active = await db.query(`SELECT o.id FROM platform_account_email_outbox o JOIN platform_account_actions a ON a.id=o.action_id
      JOIN platform_users u ON u.id=o.user_id WHERE o.id=$1 AND o.status='sending' AND o.lease_token=$2
      AND o.expires_at > clock_timestamp() AND o.lease_until > clock_timestamp() AND a.expires_at > clock_timestamp()
      AND a.consumed_at IS NULL AND a.auth_version=u.auth_version`, [item.id,item.lease_token]);
    if (!active.rowCount) continue;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref();
    try {
      const response = await (options.fetch ?? globalThis.fetch)(endpoint, { method:'POST', redirect:'error', signal:controller.signal,
        headers:{ 'Authorization':`Bearer ${config.apiKey}`, 'Content-Type':'application/json', 'Idempotency-Key':item.id }, body:JSON.stringify(fixedPayload) });
      const providerId = await receipt(response);
      await db.query(`UPDATE platform_account_email_outbox SET status='sent',ciphertext=NULL,lease_token=NULL,lease_until=NULL,
        finished_at=clock_timestamp(),provider_message_id=$3,error_code=NULL WHERE id=$1 AND status='sending' AND lease_token=$2`, [item.id,item.lease_token,providerId]);
    } catch {
      await db.query(`UPDATE platform_account_email_outbox SET
        status=CASE WHEN expires_at <= clock_timestamp() THEN 'expired' ELSE 'pending' END,
        ciphertext=CASE WHEN expires_at <= clock_timestamp() THEN NULL ELSE ciphertext END,
        finished_at=CASE WHEN expires_at <= clock_timestamp() THEN clock_timestamp() ELSE NULL END,
        lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+$3*interval '1 second',
        error_code='ACCOUNT_EMAIL_SEND_FAILED' WHERE id=$1 AND status='sending' AND lease_token=$2`,
      [item.id,item.lease_token,Math.min(60,2 ** Math.min(item.attempts,6))]);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  return attempted;
}

/** One local loop; PostgreSQL leases coordinate independent worker processes. */
export function startAccountEmailWorker(db: Database, config?: AccountEmailConfig, options: AccountEmailProcessOptions & { intervalMs?: number } = {}): { close(): Promise<void> } {
  if (!config) return { async close() {} };
  const intervalMs = options.intervalMs ?? 5000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60_000) throw invalidConfiguration();
  let closed = false, running: Promise<unknown> | undefined;
  const tick = () => {
    if (closed || running) return;
    running = processAccountEmails(db,config,options).catch(() => {}).finally(() => { running=undefined; });
  };
  const timer = setInterval(tick,intervalMs); timer.unref(); tick();
  return { async close() { closed=true; clearInterval(timer); await running; } };
}
