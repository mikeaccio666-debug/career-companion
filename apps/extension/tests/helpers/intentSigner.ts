/** 测试专用 ES256 签发器：真实 WebCrypto 密钥对 + 压缩 JWS 组装。 */

import type { ExecutionIntentPublicJwk } from '@edaix/contracts';

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlFromJson(value: unknown): string {
  return base64UrlFromBytes(new TextEncoder().encode(JSON.stringify(value)));
}

export interface TestIntentSigner {
  readonly publicJwk: ExecutionIntentPublicJwk;
  /** 第二把合法公钥（§5.2 要求 keyset 整体 2–4 把；rotation 的 next key）。 */
  readonly decoyJwk: ExecutionIntentPublicJwk;
  /** 第三把合法公钥（组"不含签名 kid"的合法 keyset 用）。 */
  readonly decoyJwk2: ExecutionIntentPublicJwk;
  sign(header: unknown, payload: unknown): Promise<string>;
  /** 换一把没进 JWKS 的钥匙签，用于打验签失败。 */
  signWithForeignKey(header: unknown, payload: unknown): Promise<string>;
}

export async function createTestIntentSigner(kid = 'k_test_1'): Promise<TestIntentSigner> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const foreignPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const decoyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const decoyPair2 = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const exported = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;
  const decoyExported = (await crypto.subtle.exportKey('jwk', decoyPair.publicKey)) as JsonWebKey;
  const decoyExported2 = (await crypto.subtle.exportKey('jwk', decoyPair2.publicKey)) as JsonWebKey;

  const publicJwk = {
    kty: 'EC',
    crv: 'P-256',
    use: 'sig',
    alg: 'ES256',
    kid,
    x: exported.x!,
    y: exported.y!,
  } as ExecutionIntentPublicJwk;

  const decoyJwk = {
    kty: 'EC',
    crv: 'P-256',
    use: 'sig',
    alg: 'ES256',
    kid: `${kid}_next`,
    x: decoyExported.x!,
    y: decoyExported.y!,
  } as ExecutionIntentPublicJwk;

  async function signWith(key: CryptoKey, header: unknown, payload: unknown): Promise<string> {
    const h = base64UrlFromJson(header);
    const p = base64UrlFromJson(payload);
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(`${h}.${p}`),
    );
    return `${h}.${p}.${base64UrlFromBytes(new Uint8Array(signature))}`;
  }

  const decoyJwk2 = {
    kty: 'EC',
    crv: 'P-256',
    use: 'sig',
    alg: 'ES256',
    kid: `${kid}_next2`,
    x: decoyExported2.x!,
    y: decoyExported2.y!,
  } as ExecutionIntentPublicJwk;

  return {
    publicJwk,
    decoyJwk,
    decoyJwk2,
    sign: (header, payload) => signWith(keyPair.privateKey, header, payload),
    signWithForeignKey: (header, payload) => signWith(foreignPair.privateKey, header, payload),
  };
}
