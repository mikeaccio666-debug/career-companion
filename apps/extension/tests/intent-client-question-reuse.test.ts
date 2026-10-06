import { beforeAll, describe, expect, it } from 'vitest';
import { questionClaimKeyForIdentityDigest } from '@edaix/contracts';

import { createIntentClient } from '../lib/intentClient';
import { createTestIntentSigner, type TestIntentSigner } from './helpers/intentSigner';
import {
  FIXTURE_HEADER,
  FIXTURE_INSTALL,
  FIXTURE_ISSUER,
  FIXTURE_NOW,
  baseClaims,
  sha,
} from './helpers/intentFixtures';

/**
 * Remembered answers on the claim path. The page says which question identities it
 * shows; the server says which of them may be reused; the claim is only ever the set
 * the signed intent named.
 */

const REF = { clientRequestId: 'req_1', missionId: 'm_1', missionStepId: 'ms_1', missionRevision: '8' };
const ORIGIN = 'https://job-boards.greenhouse.io';
const FIELD_KEYS = ['email', 'firstName', 'lastName'];
const DIGEST_A = sha('1');
const DIGEST_B = sha('2');
const KEY_A = questionClaimKeyForIdentityDigest(DIGEST_A)!;
const KEY_B = questionClaimKeyForIdentityDigest(DIGEST_B)!;

let signer: TestIntentSigner;
beforeAll(async () => {
  signer = await createTestIntentSigner('k_test_1');
});

const CLAIM_BODY = {
  schemaVersion: 1,
  claim: {
    missionId: 'm_1',
    missionStepId: 'ms_1',
    intentVersion: 1,
    executionLease: 'opaque-lease-1',
    leaseExpiresAt: '2027-01-15T00:05:00.000Z',
    allowedActions: ['FILL'],
  },
};

async function harness(
  options: {
    claimKeys?: readonly string[];
    readReusableQuestionDigests?: () => Promise<readonly string[]>;
  } = {},
) {
  const jws = await signer.sign(
    FIXTURE_HEADER,
    baseClaims({ fieldKeys: [...FIELD_KEYS, ...(options.claimKeys ?? [])].sort() }),
  );
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const diags: string[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url.endsWith('/.well-known/edaix-execution-intent-jwks.json')) {
      return { ok: true, status: 200, json: async () => ({ keys: [signer.publicJwk, signer.decoyJwk] }) };
    }
    if (url.includes('/missions/m_1/execution-intents')) {
      return {
        ok: true,
        status: 201,
        json: async () => ({ schemaVersion: 1, executionIntent: jws, expiresAt: 'x', intentVersion: 1, kid: 'k_test_1' }),
      };
    }
    if (url.endsWith('/execution-intents/claim')) {
      return { ok: true, status: 200, json: async () => CLAIM_BODY };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof fetch;

  const client = createIntentClient({
    apiBase: 'https://api.test.invalid',
    expectedIssuer: FIXTURE_ISSUER,
    getAccessToken: async () => 'tok_1',
    getUserId: async () => 'user-1',
    getInstallId: async () => FIXTURE_INSTALL,
    fetchFn,
    now: () => FIXTURE_NOW,
    onDiagnostic: (code) => diags.push(code),
    ...(options.readReusableQuestionDigests
      ? { readReusableQuestionDigests: options.readReusableQuestionDigests }
      : {}),
  });
  return { client, calls, diags };
}

const issueBody = (h: Awaited<ReturnType<typeof harness>>) =>
  h.calls.find((call) => call.url.includes('/execution-intents') && !call.url.endsWith('/claim'))!.body;
const claimBody = (h: Awaited<ReturnType<typeof harness>>) =>
  h.calls.find((call) => call.url.endsWith('/execution-intents/claim'))!.body;

describe('issuing with remembered answers', () => {
  it('offers the page question digests when a reader is wired', async () => {
    const h = await harness({ readReusableQuestionDigests: async () => [DIGEST_B, DIGEST_A] });
    expect((await h.client.acquirer.acquire(REF)).ok).toBe(true);
    expect(issueBody(h).reusableQuestionDigests).toEqual([DIGEST_A, DIGEST_B]);
  });

  it('offers nothing at all when no reader is wired', async () => {
    const h = await harness();
    expect((await h.client.acquirer.acquire(REF)).ok).toBe(true);
    expect(issueBody(h)).not.toHaveProperty('reusableQuestionDigests');
  });

  it('offers nothing when the reader fails or hands back an unusable list', async () => {
    for (const read of [
      async () => {
        throw new Error('unavailable');
      },
      async () => ['not-a-digest'],
      async () => Array.from({ length: 21 }, (_value, index) => sha(index.toString(16))),
    ]) {
      const h = await harness({ readReusableQuestionDigests: read as () => Promise<readonly string[]> });
      expect((await h.client.acquirer.acquire(REF)).ok).toBe(true);
      expect(issueBody(h)).not.toHaveProperty('reusableQuestionDigests');
    }
  });
});

describe('claiming with remembered answers', () => {
  const claim = async (h: Awaited<ReturnType<typeof harness>>, questionKeys: readonly string[] = []) => {
    const acquired = await h.client.acquirer.acquire(REF);
    if (!acquired.ok) throw new Error('acquire failed');
    return h.client.claimer.claim({
      intent: acquired.intent,
      actualOrigin: ORIGIN,
      actualFieldKeys: FIELD_KEYS,
      actualQuestionKeys: questionKeys,
      scanDigest: sha('e'),
    });
  };

  it('claims the exact set the intent named and grants the question keys separately', async () => {
    const h = await harness({ claimKeys: [KEY_A] });
    const result = await claim(h, [KEY_A, KEY_B]);
    expect(result.ok).toBe(true);
    expect(claimBody(h).actualFieldKeys).toEqual([...FIELD_KEYS, KEY_A].sort());
    if (!result.ok) throw new Error('unreachable');
    // Every existing consumer of fieldKeys — the profile read, the runtime fence, the
    // receipt — keeps seeing the profile keys alone.
    expect(result.grant.fieldKeys).toEqual(FIELD_KEYS);
    expect(result.grant.questionKeys).toEqual([KEY_A]);
  });

  it('stops when a remembered answer the intent named is no longer on the page', async () => {
    const h = await harness({ claimKeys: [KEY_A] });
    const result = await claim(h, [KEY_B]);
    expect(result).toEqual({ ok: false, code: 'RESCAN_MISMATCH' });
    expect(h.diags).toContain('CLAIM_LOCAL_QUESTION_SET_MISMATCH');
    expect(h.calls.some((call) => call.url.endsWith('/execution-intents/claim'))).toBe(false);
  });

  it('grants no question keys when the intent named none, whatever the page shows', async () => {
    const h = await harness();
    const result = await claim(h, [KEY_A, KEY_B]);
    expect(result.ok).toBe(true);
    expect(claimBody(h).actualFieldKeys).toEqual(FIELD_KEYS);
    if (!result.ok) throw new Error('unreachable');
    expect(result.grant.questionKeys).toEqual([]);
  });

  it('still stops on a profile field set that no longer matches', async () => {
    const h = await harness({ claimKeys: [KEY_A] });
    const acquired = await h.client.acquirer.acquire(REF);
    if (!acquired.ok) throw new Error('acquire failed');
    const result = await h.client.claimer.claim({
      intent: acquired.intent,
      actualOrigin: ORIGIN,
      actualFieldKeys: ['email'],
      actualQuestionKeys: [KEY_A],
      scanDigest: sha('e'),
    });
    expect(result).toEqual({ ok: false, code: 'RESCAN_MISMATCH' });
    expect(h.diags).toContain('CLAIM_LOCAL_FIELDSET_MISMATCH');
  });
});
