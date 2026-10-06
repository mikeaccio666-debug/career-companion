import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  ExecutionIntentSigner,
  ExecutionIntentVerifier,
  ExecutionIntentVerificationError,
  parseExecutionIntentSignerConfiguration,
  parseExecutionIntentVerifierConfiguration,
  parseExecutionIntentPublicKeySet,
  parseExternalApiOrigin,
  buildScanDigestV1,
  canonicalizeJson,
} from '../src/security/index.ts';

// Keys are generated only in memory and are never committed or written to disk.
const active = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const overlap = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const activePublic = active.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const overlapPublic = overlap.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const publicKeys = `active:${activePublic},overlap:${overlapPublic}`;
const signer = new ExecutionIntentSigner(parseExecutionIntentSignerConfiguration({
  activeKid: 'active',
  privateKeyPkcs8Base64: active.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  publishedPublicKeys: publicKeys,
}));
const verifier = new ExecutionIntentVerifier(
  parseExecutionIntentVerifierConfiguration({ publishedPublicKeys: publicKeys }),
);
const now = new Date('2026-10-05T12:00:00Z');
const numericNow = Math.floor(now.getTime() / 1000);
const context = {
  expectedIssuer: 'http://127.0.0.1:4310',
  expectedAudience: 'edaix-job-agent-extension',
  expectedSubject: '10000000-0000-4000-8000-000000000001',
  now,
};
const digest = `sha256:${'a'.repeat(64)}`;

function claims(overrides: Record<string, unknown> = {}) {
  return {
    ver: 1,
    iss: context.expectedIssuer,
    aud: context.expectedAudience,
    sub: context.expectedSubject,
    jti: randomBytes(32).toString('base64url'),
    iat: numericNow,
    nbf: numericNow,
    exp: numericNow + 120,
    missionId: '10000000-0000-4000-8000-000000000002',
    missionRevision: '1',
    missionStepId: '10000000-0000-4000-8000-000000000003',
    stepAttempt: 1,
    intentVersion: 1,
    extensionInstallId: '10000000-0000-4000-8000-000000000004',
    target: {
      jobId: 'synthetic-job',
      sourcePlatform: 'GREENHOUSE',
      atsProvider: 'GREENHOUSE',
      canonicalOrigin: 'https://boards.greenhouse.io',
      pathRuleId: 'greenhouse-application-v1',
      postingFingerprint: digest,
    },
    fieldKeys: ['email', 'firstName'],
    fieldSchemaVersion: 1,
    automationLevel: 'L1_FILL_STOP_BEFORE_SUBMIT',
    allowedActions: ['FILL'],
    planDigest: digest,
    approvalMessageId: '10000000-0000-4000-8000-000000000005',
    profile: { revision: '1', deletionEpoch: '0', snapshotDigest: digest },
    resume: {
      versionId: '10000000-0000-4000-8000-000000000006',
      contentHash: digest,
      contentRevision: '1',
      libraryRevision: '0',
    },
    policyVersion: 'policy-test-v1',
    killSwitchVersion: '1',
    consentVersion: 'consent-test-v1',
    ...overrides,
  };
}

function rejectsIntent(value: Record<string, unknown>, reason: string) {
  const { compactJws } = signer.sign(value);
  assert.throws(() => verifier.verify(compactJws, context), (error) =>
    error instanceof ExecutionIntentVerificationError && error.reason === reason,
  );
}

test('V2/V3 and unknown claims are rejected rather than downgraded to V1', () => {
  rejectsIntent(claims({ ver: 2 }), 'CLAIMS_INVALID');
  rejectsIntent(claims({ ver: 3, applicationForm: {} }), 'CLAIMS_INVALID');
  rejectsIntent(claims({ unknownAuthority: true }), 'CLAIMS_INVALID');
});

test('valid crypto cannot cross the owner, issuer, audience or time boundaries', () => {
  rejectsIntent(claims({ sub: '10000000-0000-4000-8000-000000000099' }), 'SUBJECT_MISMATCH');
  rejectsIntent(claims({ iss: 'https://other.example' }), 'ISSUER_MISMATCH');
  rejectsIntent(claims({ aud: 'other-extension' }), 'AUDIENCE_MISMATCH');
  rejectsIntent(claims({ iat: numericNow - 120, nbf: numericNow - 120, exp: numericNow }), 'EXPIRED');
  rejectsIntent(claims({ nbf: numericNow + 31 }), 'NOT_YET_VALID');
  rejectsIntent(claims({ exp: numericNow + 121 }), 'CLAIMS_INVALID');
});

test('tampered claims fail signature verification', () => {
  const { compactJws } = signer.sign(claims());
  const parts = compactJws.split('.');
  parts[1] = Buffer.from(JSON.stringify(claims({ intentVersion: 2 }))).toString('base64url');
  assert.throws(() => verifier.verify(parts.join('.'), context), (error) =>
    error instanceof ExecutionIntentVerificationError && error.reason === 'SIGNATURE_INVALID',
  );
});

test('field order, unknown fields and duplicate capabilities fail closed', () => {
  rejectsIntent(claims({ fieldKeys: ['firstName', 'email'] }), 'CLAIMS_INVALID');
  rejectsIntent(claims({ fieldKeys: ['not-a-profile-key'] }), 'CLAIMS_INVALID');
  rejectsIntent(claims({ allowedActions: ['FILL', 'FILL'] }), 'CLAIMS_INVALID');
});

test('valid V1 is verified and deeply immutable without creating a lease', () => {
  const { compactJws } = signer.sign(claims());
  const verified = verifier.verifyDetailed(compactJws, context);
  assert.equal(verified.kid, 'active');
  assert.equal(verified.payload.ver, 1);
  assert.equal(verified.payload.sub, context.expectedSubject);
  assert.ok(Object.isFrozen(verified.payload.target));
  assert.ok(Object.isFrozen(verified.payload.fieldKeys));
  assert.ok(!Object.hasOwn(verified.payload, 'executionLease'));
});

test('missing, incomplete and mismatched key configurations cannot enable a signer', () => {
  assert.equal(parseExecutionIntentSignerConfiguration({}), null);
  assert.throws(() => new ExecutionIntentSigner(null).sign(claims()), /SIGNER_UNAVAILABLE/);
  assert.throws(() => parseExecutionIntentSignerConfiguration({ activeKid: 'active' }), /incomplete/);
  assert.throws(() => parseExecutionIntentSignerConfiguration({
    activeKid: 'active',
    privateKeyPkcs8Base64: overlap.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publishedPublicKeys: publicKeys,
  }), /does not match/);
  assert.throws(() => parseExecutionIntentPublicKeySet(`active:${activePublic}`), /at least two/);
  assert.throws(() => parseExecutionIntentPublicKeySet(`active:${activePublic},other:${activePublic}`), /same public key/);
});

test('public key responses contain only public fields; unsafe issuer origins are rejected', () => {
  const { jwks } = parseExecutionIntentPublicKeySet(publicKeys);
  assert.deepEqual(Object.keys(jwks.keys[0]).sort(), ['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
  assert.throws(() => parseExternalApiOrigin('http://example.com:4310'), /must use https/);
  assert.throws(() => parseExternalApiOrigin('https://user:password@example.com'), /canonical/);
  assert.throws(() => parseExternalApiOrigin('https://example.com/path'), /canonical/);
});

test('digest normalization binds target and rejects coercive JSON inputs', () => {
  const base = { canonicalOrigin: 'https://example.com', pathname: '/apply', vendor: 'generic' };
  assert.equal(
    buildScanDigestV1({ ...base, fieldKeys: ['firstName', 'email'] }),
    buildScanDigestV1({ ...base, fieldKeys: ['email', 'firstName'] }),
  );
  assert.notEqual(
    buildScanDigestV1({ ...base, fieldKeys: ['email'] }),
    buildScanDigestV1({ ...base, pathname: '/other', fieldKeys: ['email'] }),
  );
  assert.throws(() => canonicalizeJson({ amount: Number.NaN }), /UNSUPPORTED/);
  assert.throws(() => canonicalizeJson({ created: new Date() }), /UNSUPPORTED/);
});
