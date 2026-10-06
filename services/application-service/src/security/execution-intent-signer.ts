/**
 * Adapted from argoland 013d5128bd474f98b78df8c9878e1321712b134b.
 * Pure migration seam; importing this file grants no execution authority.
 */
import { createPrivateKey, createPublicKey, sign as signBytes, type KeyObject } from 'node:crypto';
import {
  ExecutionIntentJwksConfigurationError,
  parseExecutionIntentPublicKeySet,
} from './execution-intent-jwks.config.ts';

const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PROTECTED_TYPE = 'edaix-execution-intent+jwt';

export type ExecutionIntentSignerConfigurationInput = Readonly<{
  activeKid?: string | null;
  privateKeyPkcs8Base64?: string | null;
  publishedPublicKeys?: string | null;
}>;

export type ParsedExecutionIntentSignerConfiguration = Readonly<{
  kid: string;
  privateKey: KeyObject;
}>;

export type SignedExecutionIntent = Readonly<{
  compactJws: string;
  kid: string;
}>;

export class ExecutionIntentSignerConfigurationError extends Error {
  constructor(reason: string) {
    super(`EXECUTION_INTENT_SIGNER_INVALID: ${reason}`);
    this.name = 'ExecutionIntentSignerConfigurationError';
  }
}

export class ExecutionIntentSignerUnavailableError extends Error {
  constructor() {
    super('EXECUTION_INTENT_SIGNER_UNAVAILABLE');
    this.name = 'ExecutionIntentSignerUnavailableError';
  }
}

export class ExecutionIntentSigningError extends Error {
  constructor() {
    super('EXECUTION_INTENT_SIGNING_FAILED');
    this.name = 'ExecutionIntentSigningError';
  }
}

/**
 * Loads one active PKCS8 signer and proves that its public coordinates are
 * already published under the same kid. Empty signer fields mean the issuance
 * surface is deliberately disabled; partial or mismatched material is fatal.
 */
export function parseExecutionIntentSignerConfiguration(
  input: ExecutionIntentSignerConfigurationInput,
): ParsedExecutionIntentSignerConfiguration | null {
  const kidMissing = isMissing(input.activeKid);
  const privateKeyMissing = isMissing(input.privateKeyPkcs8Base64);
  if (kidMissing && privateKeyMissing) return null;
  if (kidMissing || privateKeyMissing) throw invalidConfiguration('configuration is incomplete');

  const kid = input.activeKid;
  if (typeof kid !== 'string' || !KEY_ID_PATTERN.test(kid)) {
    throw invalidConfiguration(
      'active kid must be 1-64 ASCII letters, digits, dot, underscore, or hyphen',
    );
  }

  const encodedPrivateKey = input.privateKeyPkcs8Base64;
  if (typeof encodedPrivateKey !== 'string') {
    throw invalidConfiguration('private key must be canonical PKCS8 DER base64');
  }
  const privateDer = decodeCanonicalBase64(encodedPrivateKey);

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' });
  } catch {
    throw invalidConfiguration('private key must be canonical PKCS8 DER');
  }

  if (
    privateKey.type !== 'private' ||
    privateKey.asymmetricKeyType !== 'ec' ||
    privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    throw invalidConfiguration('private key must be an EC P-256 key');
  }

  const canonicalDer = privateKey.export({ format: 'der', type: 'pkcs8' });
  if (!Buffer.isBuffer(canonicalDer) || !canonicalDer.equals(privateDer)) {
    throw invalidConfiguration('private key must use canonical PKCS8 DER');
  }

  const publishedConfiguration = input.publishedPublicKeys;
  if (typeof publishedConfiguration !== 'string' || !publishedConfiguration) {
    throw invalidConfiguration('published public key set is required');
  }

  let published;
  try {
    published = parseExecutionIntentPublicKeySet(publishedConfiguration);
  } catch (error) {
    if (error instanceof ExecutionIntentJwksConfigurationError) {
      throw invalidConfiguration('published public key set is invalid');
    }
    throw error;
  }

  const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const publishedKey = published.jwks.keys.find((candidate) => candidate.kid === kid);
  if (!publishedKey) {
    throw invalidConfiguration('active kid must already be present in the published key set');
  }
  if (publishedKey.x !== publicJwk.x || publishedKey.y !== publicJwk.y) {
    throw invalidConfiguration('active private key does not match its published public key');
  }

  return Object.freeze({ kid, privateKey });
}

export class ExecutionIntentSigner {
  constructor(private readonly configuration: ParsedExecutionIntentSignerConfiguration | null) {}

  sign(payload: Readonly<Record<string, unknown>>): SignedExecutionIntent {
    if (!this.configuration) throw new ExecutionIntentSignerUnavailableError();
    if (!isStrictJsonRecord(payload)) throw new ExecutionIntentSigningError();

    try {
      const encodedHeader = encodeJson({
        alg: 'ES256',
        kid: this.configuration.kid,
        typ: PROTECTED_TYPE,
      });
      const encodedPayload = encodeJson(payload);
      const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii');
      const signature = signBytes('sha256', signingInput, {
        key: this.configuration.privateKey,
        dsaEncoding: 'ieee-p1363',
      });
      if (signature.length !== 64) throw new Error('invalid ES256 signature length');

      return Object.freeze({
        compactJws: `${encodedHeader}.${encodedPayload}.${signature.toString('base64url')}`,
        kid: this.configuration.kid,
      });
    } catch (error) {
      if (error instanceof ExecutionIntentSigningError) throw error;
      throw new ExecutionIntentSigningError();
    }
  }
}

function encodeJson(value: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function isStrictJsonRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return isStrictJsonValue(value, new Set<object>()) && !Array.isArray(value) && value !== null;
}

function isStrictJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;

  const object = value as object;
  if (ancestors.has(object)) return false;
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(object)) return false;

  const keys = Reflect.ownKeys(object);
  if (keys.some((key) => typeof key !== 'string')) return false;

  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      if (keys.some((key) => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key as string)))
        return false;
      for (let index = 0; index < object.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(object, index)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
        if (
          !descriptor?.enumerable ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        ) {
          return false;
        }
        if (!isStrictJsonValue(object[index], ancestors)) return false;
      }
      return true;
    }

    const descriptors = Object.getOwnPropertyDescriptors(object);
    if (
      Object.values(descriptors).some(
        (descriptor) =>
          !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined,
      )
    ) {
      return false;
    }
    for (const key of keys as string[]) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') return false;
      if (!isStrictJsonValue((object as Record<string, unknown>)[key], ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(object);
  }
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function decodeCanonicalBase64(value: string): Buffer {
  if (!value || !CANONICAL_BASE64_PATTERN.test(value)) {
    throw invalidConfiguration('private key must be canonical PKCS8 DER base64');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw invalidConfiguration('private key must be canonical PKCS8 DER base64');
  }
  return decoded;
}

function invalidConfiguration(reason: string): ExecutionIntentSignerConfigurationError {
  return new ExecutionIntentSignerConfigurationError(reason);
}
