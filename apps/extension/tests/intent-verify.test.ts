import { beforeAll, describe, expect, it } from 'vitest';

import {
  INTENT_VERIFY_ERROR_CODES,
  validateIntentClaims,
  verifyExecutionIntent,
} from '../lib/intentVerify';
import { base64UrlFromJson, createTestIntentSigner, type TestIntentSigner } from './helpers/intentSigner';
import {
  FIXTURE_HEADER as HEADER,
  FIXTURE_INSTALL as INSTALL,
  FIXTURE_ISSUER as ISSUER,
  FIXTURE_NOW as NOW,
  baseClaims,
} from './helpers/intentFixtures';

/**
 * 刀六a 特征测试：Intent 验签与载荷校验（契约 §5.2/§5.3，RFC 8725）。
 * 真实 WebCrypto 密钥对签真 JWS——不 mock 验签本身。
 */

function validate(overrides: Record<string, unknown> = {}) {
  return validateIntentClaims({
    payload: baseClaims(overrides),
    expectedIssuer: ISSUER,
    expectedInstallId: INSTALL,
    expectedSubject: 'user-1',
    nowSeconds: NOW,
  });
}

let signer: TestIntentSigner;
beforeAll(async () => {
  signer = await createTestIntentSigner('k_test_1');
});

function verify(jws: string, keys = [signer.publicJwk]) {
  return verifyExecutionIntent({
    jws,
    keys,
    expectedIssuer: ISSUER,
    expectedInstallId: INSTALL,
    expectedSubject: 'user-1',
    nowSeconds: NOW,
  });
}

describe('JWS 验签（RFC 8725 收口）', () => {
  it('合法签名 + 合法载荷 → ok，claims 原样交付', async () => {
    const jws = await signer.sign(HEADER, baseClaims());
    const result = await verify(jws);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.missionId).toBe('m_1');
    expect(result.claims.fieldKeys).toEqual(['email', 'firstName', 'lastName']);
  });

  it('载荷被篡改 → INTENT_SIGNATURE_INVALID（签名盖不住新载荷）', async () => {
    const jws = await signer.sign(HEADER, baseClaims());
    const [h, , s] = jws.split('.');
    const tampered = `${h}.${base64UrlFromJson(baseClaims({ missionId: 'm_EVIL' }))}.${s}`;
    expect(await verify(tampered)).toEqual({ ok: false, code: 'INTENT_SIGNATURE_INVALID' });
  });

  it('陌生钥匙签的票 → INTENT_SIGNATURE_INVALID', async () => {
    const jws = await signer.signWithForeignKey(HEADER, baseClaims());
    expect(await verify(jws)).toEqual({ ok: false, code: 'INTENT_SIGNATURE_INVALID' });
  });

  it('alg=none / HS256 / typ 不符 / 带 jku → INTENT_HEADER_REJECTED', async () => {
    for (const header of [
      { alg: 'none', kid: 'k_test_1', typ: 'edaix-execution-intent+jwt' },
      { alg: 'HS256', kid: 'k_test_1', typ: 'edaix-execution-intent+jwt' },
      { alg: 'ES256', kid: 'k_test_1', typ: 'JWT' },
      { ...HEADER, jku: 'https://evil.test/jwks.json' },
      { ...HEADER, crit: ['exp'] },
    ]) {
      const jws = await signer.sign(header, baseClaims());
      expect(await verify(jws)).toEqual({ ok: false, code: 'INTENT_HEADER_REJECTED' });
    }
  });

  it('kid 不在受信 JWKS → INTENT_KID_UNKNOWN；JWK 带私钥标量 d → 不受信', async () => {
    const jws = await signer.sign(HEADER, baseClaims());
    expect(await verify(jws, [])).toEqual({ ok: false, code: 'INTENT_KID_UNKNOWN' });
    const poisoned = { ...signer.publicJwk, d: 'secret-scalar' } as never;
    expect(await verify(jws, [poisoned])).toEqual({ ok: false, code: 'INTENT_KID_UNKNOWN' });
  });

  it('段数不对 / base64url 外字符 → INTENT_MALFORMED', async () => {
    expect(await verify('a.b')).toEqual({ ok: false, code: 'INTENT_MALFORMED' });
    expect(await verify('!!!.@@@.###')).toEqual({ ok: false, code: 'INTENT_MALFORMED' });
  });
});

describe('载荷校验（§5.3 逐条）', () => {
  it('时间窗：过期 / 未生效 / TTL 超 120s 分码', () => {
    // §5.3 公式 nbf <= now+skew < exp+skew：exp 侧 skew 相消 = 到点即死。
    expect(validate({ iat: NOW - 100, nbf: NOW - 100, exp: NOW })).toEqual({ ok: false, code: 'INTENT_EXPIRED' });
    expect(validate({ iat: NOW - 100, nbf: NOW - 100, exp: NOW + 1 }).ok).toBe(true);
    expect(validate({ iat: NOW + 31, nbf: NOW + 31, exp: NOW + 131 })).toEqual({ ok: false, code: 'INTENT_NOT_YET_VALID' });
    // skew 只救 nbf 侧：30s 内"未生效"的票放行（时钟漂移不误伤）。
    expect(validate({ iat: NOW + 20, nbf: NOW + 20, exp: NOW + 120 }).ok).toBe(true);
    expect(validate({ iat: NOW - 10, nbf: NOW - 10, exp: NOW + 111 })).toEqual({ ok: false, code: 'INTENT_TTL_TOO_LONG' });
  });

  it('iss / aud / sub / install 各自分码（§5.5.1 五必查全覆盖）', () => {
    expect(validate({ iss: 'https://evil.test' })).toEqual({ ok: false, code: 'INTENT_ISSUER_MISMATCH' });
    expect(validate({ aud: 'someone-else' })).toEqual({ ok: false, code: 'INTENT_AUDIENCE_MISMATCH' });
    expect(validate({ sub: 'user-2' })).toEqual({ ok: false, code: 'INTENT_SUBJECT_MISMATCH' });
    expect(validate({ extensionInstallId: 'other-install' })).toEqual({ ok: false, code: 'INTENT_INSTALL_MISMATCH' });
  });

  it('Data-L1 绊线：载荷携带值类容器 → INTENT_FIELD_VALUE_SMUGGLED 整份拒收', () => {
    expect(validate({ values: { email: 'a@b.test' } })).toEqual({ ok: false, code: 'INTENT_FIELD_VALUE_SMUGGLED' });
    expect(validate({ resumeText: '…' })).toEqual({ ok: false, code: 'INTENT_FIELD_VALUE_SMUGGLED' });
    // 字段"清单"里塞"内容"（空白/超长）同样按走私处理。
    expect(validate({ fieldKeys: ['email', 'my answer is yes'] })).toEqual({ ok: false, code: 'INTENT_FIELD_VALUE_SMUGGLED' });
    // 嵌套层同样有绊线：target/profile/resume 里出现值类容器名也整份拒收。
    expect(
      validate({ target: { ...(baseClaims()['target'] as object), cookie: 'session=…' } }),
    ).toEqual({ ok: false, code: 'INTENT_FIELD_VALUE_SMUGGLED' });
    expect(
      validate({ profile: { ...(baseClaims()['profile'] as object), values: {} } }),
    ).toEqual({ ok: false, code: 'INTENT_FIELD_VALUE_SMUGGLED' });
  });

  it('闭集与形状：乱序 fieldKeys、L0 档、未知 action、坏 origin 都是畸形', () => {
    expect(validate({ fieldKeys: ['firstName', 'email'] })).toEqual({ ok: false, code: 'INTENT_MALFORMED' });
    expect(validate({ fieldKeys: ['email', 'email'] })).toEqual({ ok: false, code: 'INTENT_MALFORMED' });
    expect(validate({ automationLevel: 'L0_PREVIEW_ONLY' })).toEqual({ ok: false, code: 'INTENT_MALFORMED' });
    expect(validate({ allowedActions: ['FILL', 'DELETE_ACCOUNT'] })).toEqual({ ok: false, code: 'INTENT_MALFORMED' });
    expect(
      validate({ target: { ...(baseClaims()['target'] as object), canonicalOrigin: 'https://host.test/path' } }),
    ).toEqual({ ok: false, code: 'INTENT_MALFORMED' });
    expect(validate({ surprise: 1 })).toEqual({ ok: false, code: 'INTENT_MALFORMED' });
  });

  it('审计补锁：动作乱序/重复、档位 L1 带 SUBMIT、野 ATS 枚举、野 fieldSchemaVersion、缺必填子字段', () => {
    // §5.3 对 fieldKeys 与 allowedActions 同句要求"排序、去重"。
    expect(validate({ allowedActions: ['SUBMIT', 'FILL'] })).toEqual({ ok: false, code: 'INTENT_MALFORMED' });
    expect(validate({ allowedActions: ['FILL', 'FILL'] })).toEqual({ ok: false, code: 'INTENT_MALFORMED' });
    // 档位 L1 只能 FILL 停在提交前——带 SUBMIT 的档位 L1 票拒收。
    expect(
      validate({ automationLevel: 'L1_FILL_STOP_BEFORE_SUBMIT', allowedActions: ['FILL', 'SUBMIT'] }),
    ).toEqual({ ok: false, code: 'INTENT_MALFORMED' });
    // sourcePlatform/atsProvider v1 闭集：任意 string 不静默放行。
    expect(
      validate({ target: { ...(baseClaims()['target'] as object), sourcePlatform: 'MYSTERY_ATS' } }),
    ).toEqual({ ok: false, code: 'INTENT_MALFORMED' });
    expect(
      validate({ target: { ...(baseClaims()['target'] as object), atsProvider: 'INDEED' } }),
    ).toEqual({ ok: false, code: 'INTENT_MALFORMED' });
    // 未知 fieldSchemaVersion fail-closed（§1.1）。
    expect(validate({ fieldSchemaVersion: 999 })).toEqual({ ok: false, code: 'INTENT_MALFORMED' });
    // profile/resume 必填子字段缺失即拒（deletionEpoch 是防复活世代号）。
    expect(
      validate({ profile: { revision: '1', snapshotDigest: (baseClaims()['profile'] as { snapshotDigest: string }).snapshotDigest } }),
    ).toEqual({ ok: false, code: 'INTENT_MALFORMED' });
    expect(
      validate({ resume: { versionId: 'rv-1', contentHash: (baseClaims()['resume'] as { contentHash: string }).contentHash, contentRevision: '1' } }),
    ).toEqual({ ok: false, code: 'INTENT_MALFORMED' });
  });

  it('档位 L2 票据可以带 SUBMIT（耦合规则只锁档位 L1）', () => {
    expect(
      validate({ automationLevel: 'L2_CONFIRM_EACH_SUBMISSION', allowedActions: ['FILL', 'SUBMIT'] }).ok,
    ).toBe(true);
  });

  it('错误码全部来自导出闭集（诊断出口的白名单前提）', () => {
    const bads = [
      validate({ iss: 'x' }),
      validate({ values: {} }),
      validate({ fieldKeys: [] }),
      validate({ iat: NOW - 100, nbf: NOW - 100, exp: NOW - 31 }),
    ];
    for (const bad of bads) {
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(INTENT_VERIFY_ERROR_CODES).toContain(bad.code);
    }
  });
});
