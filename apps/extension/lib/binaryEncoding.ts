/**
 * Base64 for bytes crossing the extension-internal runtime port, which only carries JSON.
 * Chunked so a multi-megabyte resume never spreads one call across the whole array.
 */

const CHUNK_BYTES = 0x8000;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_BYTES));
  }
  return btoa(binary);
}

/** Null for anything that is not canonical base64; callers treat that as no bytes at all. */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length % 4 !== 0 || !BASE64.test(text)) return null;
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}
