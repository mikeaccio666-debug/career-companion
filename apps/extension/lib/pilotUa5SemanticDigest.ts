import { sha256 } from '@noble/hashes/sha256';

/**
 * Synchronous browser implementation of the semantic compiler's digest port.
 * The framing is intentionally identical to the API/kernel implementation:
 * UTF-8 SHA-256 over the arguments joined by one ASCII space, with raw hex.
 */
export function pilotUa5SemanticDigest(...parts: readonly string[]): string {
  const digest = sha256(new TextEncoder().encode(parts.join(' ')));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
