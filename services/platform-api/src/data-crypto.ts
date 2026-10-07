import { createCipheriv, createDecipheriv, createSecretKey, randomBytes } from 'node:crypto';

export const MAX_DATA_PLAINTEXT_BYTES = 64 * 1024;
const KEY_VERSION = 1;
const HEADER_BYTES = 1 + 12 + 16;
const configurationError = () => new Error('PLATFORM_DATA_KEY must be explicitly configured as a 32-byte hexadecimal key.');

/** Only server-owned record coordinates belong here; this is not an HTTP input. */
export interface DataBinding {
  readonly table: string;
  readonly column: string;
  readonly rowId: string;
  readonly ownerId: string;
  readonly revision: number;
}
export interface DataCrypto {
  sealUtf8(value: string, binding: DataBinding): Buffer;
  openUtf8(envelope: Buffer, binding: DataBinding): string;
}
/** One bounded failure for invalid context, payload or authenticated ciphertext. */
export class DataCryptoError extends Error {
  readonly code = 'DATA_CRYPTO_FAILED';
  constructor() { super('The protected data could not be processed.'); this.name = 'DataCryptoError'; }
}

const identifier = /^[a-z][a-z0-9_]{0,62}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function exact(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}
function associatedData(binding: DataBinding): Buffer {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || Object.keys(binding).some(field => !['table', 'column', 'rowId', 'ownerId', 'revision'].includes(field))) throw new DataCryptoError();
  // Read each coordinate once before validating and encoding it.
  const { table, column, rowId, ownerId, revision } = binding;
  if (!exact(table, identifier) || !exact(column, identifier) || !exact(rowId, uuid) || !exact(ownerId, uuid)
    || !Number.isSafeInteger(revision) || revision < 0 || Object.is(revision, -0)) throw new DataCryptoError();
  return Buffer.from(JSON.stringify(['career-companion:data:v1', KEY_VERSION, table, column, rowId, ownerId, revision]), 'utf8');
}

/**
 * Missing development configuration leaves protected storage unavailable. Production
 * always requires the dedicated key; email/provider switches do not supply one.
 * Version 1 only: replacing this key is not rotation and cannot read old ciphertext.
 * The returned frozen port closes over a KeyObject, without exposing key material.
 */
export function readDataCrypto(env: NodeJS.ProcessEnv = process.env): DataCrypto | undefined {
  const encoded = env.PLATFORM_DATA_KEY;
  if (encoded === undefined) {
    if (env.NODE_ENV === 'production') throw configurationError();
    return undefined;
  }
  if (typeof encoded !== 'string' || encoded.length !== 64 || !/^[0-9a-f]{64}$/i.test(encoded)) throw configurationError();
  const material = Buffer.from(encoded, 'hex');
  let key: ReturnType<typeof createSecretKey>;
  try { key = createSecretKey(material); }
  catch { throw configurationError(); }
  finally { material.fill(0); }

  return Object.freeze({
    sealUtf8(value: string, binding: DataBinding): Buffer {
      try {
        if (typeof value !== 'string' || value.length > MAX_DATA_PLAINTEXT_BYTES) throw new DataCryptoError();
        const plain = Buffer.from(value, 'utf8');
        if (plain.length > MAX_DATA_PLAINTEXT_BYTES || plain.toString('utf8') !== value) throw new DataCryptoError();
        const aad = associatedData(binding), iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
        return Buffer.concat([Buffer.from([KEY_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
      } catch { throw new DataCryptoError(); }
    },
    openUtf8(envelope: Buffer, binding: DataBinding): string {
      try {
        if (!Buffer.isBuffer(envelope) || envelope.length < HEADER_BYTES
          || envelope.length > HEADER_BYTES + MAX_DATA_PLAINTEXT_BYTES) throw new DataCryptoError();
        const sealed = Buffer.from(envelope);
        if (sealed[0] !== KEY_VERSION) throw new DataCryptoError();
        const aad = associatedData(binding);
        const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(1, 13), { authTagLength: 16 });
        decipher.setAAD(aad); decipher.setAuthTag(sealed.subarray(13, 29));
        // No caller receives the tentative update() output before final() authenticates it.
        const plain = Buffer.concat([decipher.update(sealed.subarray(HEADER_BYTES)), decipher.final()]);
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plain);
      } catch { throw new DataCryptoError(); }
    },
  });
}
