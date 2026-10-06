/**
 * Adapted from argoland 013d5128bd474f98b78df8c9878e1321712b134b.
 * Pure migration seam; importing this file grants no execution authority.
 */
import { createHash, createPublicKey } from 'node:crypto';

const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CANONICAL_BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MIN_PUBLISHED_KEYS = 2;
const MAX_PUBLISHED_KEYS = 4;

export type ExecutionIntentPublicJwk = Readonly<{
  kty: 'EC';
  crv: 'P-256';
  use: 'sig';
  alg: 'ES256';
  kid: string;
  x: string;
  y: string;
}>;

export type ExecutionIntentPublicJwks = Readonly<{
  keys: readonly ExecutionIntentPublicJwk[];
}>;

export type ParsedExecutionIntentPublicKeySet = Readonly<{
  jwks: ExecutionIntentPublicJwks;
  etag: string;
}>;

export class ExecutionIntentJwksConfigurationError extends Error {
  constructor(reason: string) {
    super(`EXECUTION_INTENT_JWKS_INVALID: ${reason}`);
    this.name = 'ExecutionIntentJwksConfigurationError';
  }
}

/**
 * Parse the deployment-only public key list used by the RFC 7517 endpoint.
 *
 * The configuration deliberately carries canonical SPKI DER instead of JWK
 * objects. That leaves no input-controlled JWK metadata (`d`, `jku`, `key_ops`,
 * etc.) to accidentally spread into the response. The route reconstructs the
 * seven allowed public fields from Node's verified P-256 KeyObject.
 */
export function parseExecutionIntentPublicKeySet(
  configuredKeys: string,
): ParsedExecutionIntentPublicKeySet {
  if (!configuredKeys || configuredKeys !== configuredKeys.trim()) {
    throw invalid('public key configuration must be non-empty and have no outer whitespace');
  }

  const entries = configuredKeys.split(',');
  if (entries.length < MIN_PUBLISHED_KEYS) {
    throw invalid('at least two public keys are required for rotation overlap');
  }
  if (entries.length > MAX_PUBLISHED_KEYS) {
    throw invalid('no more than four public keys may be published');
  }

  const kids = new Set<string>();
  const publicMaterials = new Set<string>();
  const keys = entries.map((entry) => {
    const separator = entry.indexOf(':');
    if (separator <= 0 || separator !== entry.lastIndexOf(':')) {
      throw invalid('each public key entry must contain one kid separator');
    }

    const kid = entry.slice(0, separator);
    const encodedSpki = entry.slice(separator + 1);
    if (!KEY_ID_PATTERN.test(kid)) {
      throw invalid('kid must be 1-64 ASCII letters, digits, dot, underscore, or hyphen');
    }
    if (kids.has(kid)) throw invalid('kid values must be unique');
    kids.add(kid);

    const spki = decodeCanonicalBase64(encodedSpki);
    let publicKey;
    try {
      publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    } catch {
      throw invalid('public key material must be canonical SPKI DER');
    }

    if (
      publicKey.type !== 'public' ||
      publicKey.asymmetricKeyType !== 'ec' ||
      publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    ) {
      throw invalid('public key material must be an EC P-256 public key');
    }

    const canonicalSpki = publicKey.export({ format: 'der', type: 'spki' });
    if (!Buffer.isBuffer(canonicalSpki) || !canonicalSpki.equals(spki)) {
      throw invalid('public key material must use canonical SPKI DER');
    }

    const exported = publicKey.export({ format: 'jwk' });
    if (
      exported.kty !== 'EC' ||
      exported.crv !== 'P-256' ||
      !isCanonicalCoordinate(exported.x) ||
      !isCanonicalCoordinate(exported.y)
    ) {
      throw invalid('public key material must export as canonical P-256 coordinates');
    }

    const materialIdentity = `${exported.x}.${exported.y}`;
    if (publicMaterials.has(materialIdentity)) {
      throw invalid('the same public key material cannot be published under multiple kid values');
    }
    publicMaterials.add(materialIdentity);

    return Object.freeze({
      kty: 'EC' as const,
      crv: 'P-256' as const,
      use: 'sig' as const,
      alg: 'ES256' as const,
      kid,
      x: exported.x,
      y: exported.y,
    });
  });

  // Bytewise ASCII order keeps response bytes/ETag stable across hosts with
  // different ICU locales.
  keys.sort((left, right) => (left.kid < right.kid ? -1 : left.kid > right.kid ? 1 : 0));
  const jwks = Object.freeze({ keys: Object.freeze(keys) });
  const digest = createHash('sha256').update(JSON.stringify(jwks), 'utf8').digest('base64url');

  return Object.freeze({ jwks, etag: `"sha256-${digest}"` });
}

function decodeCanonicalBase64(value: string): Buffer {
  if (!value || !CANONICAL_BASE64_PATTERN.test(value)) {
    throw invalid('public key material must be canonical base64');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw invalid('public key material must be canonical base64');
  }
  return decoded;
}

function isCanonicalCoordinate(value: string | undefined): value is string {
  if (!value || !CANONICAL_BASE64URL_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === 32 && decoded.toString('base64url') === value;
}

function invalid(reason: string): ExecutionIntentJwksConfigurationError {
  return new ExecutionIntentJwksConfigurationError(reason);
}
