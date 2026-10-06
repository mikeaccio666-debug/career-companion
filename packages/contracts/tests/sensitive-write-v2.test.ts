import { describe, expect, it } from 'vitest';

import {
  SENSITIVE_MANUAL_ONLY_CLASSES,
  canonicalizeSensitiveStatementV1,
  parseActualSensitiveItemsV2,
  parseBase64Url43,
  parseCanonicalBcp47Locale,
  parseCreateSensitiveWriteConfirmationRequestV2,
  parseClaimExecutionIntentRequestV2,
  parseClaimExecutionIntentResponseV2,
  parseDecideSensitiveWriteConfirmationRequestV2,
  parseExecutionIntentIssueRequestV2,
  parseFetchSensitiveExecutionMaterialRequestV2,
  parseFetchSensitiveExecutionMaterialResponseV2,
  parseIsoCountryCode,
  parseIssueExecutionIntentResponseV2,
  parseKeyedDigest,
  parseSafeToken,
  parseSensitiveDiscoveryItemsV2,
  parseSensitiveExecutionMaterialItemsV2,
  parseSensitiveMaterialValueV1,
  parseSensitiveStatementDigestV1,
  parseSensitiveStatementTextV1,
  parseSensitiveWriteDecisionItemsV2,
  parseSensitiveWriteReleaseRefV1,
  parseSha256Digest,
  parseSubmitApplicationReceiptRequestV2,
  parseSubmitApplicationReceiptResponseV2,
  parseUuid,
  type ClaimExecutionIntentRequestV2,
  type CreateSensitiveWriteConfirmationResponseV2,
  type ExecutionIntentIssueRequestV2,
  type FetchSensitiveExecutionMaterialRequestV2,
  type OneToTwenty,
  type SensitiveWriteDecisionResponseV2,
  type SubmitApplicationReceiptRequestV2SensitiveRelease,
  type Uuid,
} from '../src/index.ts';
import {
  PENDING_L2P_SENSITIVE_ASSISTED_WRITE_CLASSES,
  PENDING_L2P_SENSITIVE_MANUAL_ONLY_CLASSES,
  PENDING_L2P_SENSITIVE_PROPOSAL_STATUS,
} from '../src/draft/index.ts';

const uuidA = parseUuid('00000000-0000-4000-8000-000000000001')!;
const uuidB = parseUuid('00000000-0000-4000-8000-000000000002')!;
const uuidC = parseUuid('00000000-0000-4000-8000-000000000003')!;
const digest = parseSha256Digest(`sha256:${'a'.repeat(64)}`)!;
const keyedDigest = parseKeyedDigest(`hmac-sha256:v1:key-id:${'b'.repeat(64)}`)!;
const statementDigest = parseSensitiveStatementDigestV1(
  `hmac-sha256:v1:statement-key:${'c'.repeat(64)}`,
)!;
const statement = parseSensitiveStatementTextV1(
  'I certify that the information above is true.',
)!;
const locale = parseCanonicalBcp47Locale('en-US')!;

describe('pending L2-P sensitive assisted-write proposal', () => {
  it('keeps the proposed write set closed and explicitly pending', () => {
    expect(PENDING_L2P_SENSITIVE_PROPOSAL_STATUS).toBe('PENDING_L2P_PROPOSAL');
    expect(PENDING_L2P_SENSITIVE_ASSISTED_WRITE_CLASSES).toEqual([
      'BACKGROUND_CHECK_AUTHORIZATION',
      'ARBITRATION_AGREEMENT',
      'CREDIT_REPORT_AUTHORIZATION',
      'DRUG_TEST_AUTHORIZATION',
      'PASSWORD',
    ]);
  });

  it('leaves challenges, marketing, unlisted consent and unknown controls manual-only', () => {
    expect(PENDING_L2P_SENSITIVE_MANUAL_ONLY_CLASSES).toEqual([
      'OTP_OR_2FA',
      'CAPTCHA_OR_HUMAN_CHALLENGE',
      'MARKETING_SUBSCRIPTION',
      'CONTACT_CURRENT_EMPLOYER',
      'OTHER_SUBSTANTIVE_AUTHORIZATION',
      'FILE_PICKER',
      'UNKNOWN_HIGH_RISK',
    ]);
    expect(
      PENDING_L2P_SENSITIVE_MANUAL_ONLY_CLASSES.some((value) =>
        (PENDING_L2P_SENSITIVE_ASSISTED_WRITE_CLASSES as readonly string[]).includes(value),
      ),
    ).toBe(false);
  });

  it('cannot enter the effective discovery or material decoders before convergence', () => {
    expect(SENSITIVE_MANUAL_ONLY_CLASSES).toContain('PASSWORD');
    expect(SENSITIVE_MANUAL_ONLY_CLASSES).toContain('SUBSTANTIVE_AUTHORIZATION');
    for (const observedConceptCode of PENDING_L2P_SENSITIVE_ASSISTED_WRITE_CLASSES) {
      expect(
        parseSensitiveDiscoveryItemsV2([
          {
            clientDiscoveryItemId: uuidA,
            observedConceptCode,
            regionCode: null,
            locale,
            statementText: statement,
          },
        ]),
      ).toBeNull();
    }
    expect(
      parseSensitiveExecutionMaterialItemsV2([
        {
          releaseItemId: uuidA,
          targetOccurrenceId: uuidB,
          valueAuthority: {
            kind: 'LOCAL_CREDENTIAL_RECORD',
            credentialId: uuidC,
            canonicalOrigin: 'https://jobs.example.invalid',
          },
          answer: { kind: 'PASSWORD', value: 'must-never-enter-the-api-wire' },
        },
      ]),
    ).toBeNull();
  });
});

function numberedUuid(index: number) {
  return parseUuid(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)!;
}

describe('sensitive v2 hostile-boundary primitives', () => {
  it('models OneToTwenty as a real static 1..20 tuple union', () => {
    const twenty = [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ] as const;
    const accepted: OneToTwenty<number> = twenty;
    const twentyOne = [...twenty, 21] as const;
    // @ts-expect-error OneToTwenty must reject a statically-known 21st member.
    const rejected: OneToTwenty<number> = twentyOne;
    expect(accepted).toHaveLength(20);
    expect(rejected).toHaveLength(21);
  });

  it('brands only canonical lowercase UUIDv4 and rejects version/case aliases', () => {
    expect(parseUuid('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).not.toBeNull();
    expect(parseUuid('aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa')).toBeNull();
    expect(parseUuid('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')).toBeNull();
    // @ts-expect-error raw strings, including uppercase aliases, are not statically trusted UUIDs.
    const uppercaseAlias: Uuid = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    expect(uppercaseAlias).toContain('AAAA');
  });

  it('decodes and re-encodes an exact 32-byte unpadded base64url capability', () => {
    expect(parseBase64Url43('A'.repeat(43))).toBe('A'.repeat(43));
    expect(parseBase64Url43('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8')).not.toBeNull();
    expect(parseBase64Url43(`${'A'.repeat(42)}B`), 'non-zero trailing pad bits').toBeNull();
    expect(parseBase64Url43('A'.repeat(42))).toBeNull();
    expect(parseBase64Url43(`${'A'.repeat(43)}=`)).toBeNull();
    expect(parseBase64Url43(`${'A'.repeat(42)}+`)).toBeNull();
  });

  it('accepts only the fixed ISO table, canonical BCP-47, SafeToken, and keyed digest grammar', () => {
    expect(parseIsoCountryCode('US')).toBe('US');
    expect(parseIsoCountryCode('AX')).toBe('AX');
    expect(parseIsoCountryCode('SS')).toBe('SS');
    expect(parseIsoCountryCode('ZZ')).toBeNull();
    expect(parseIsoCountryCode('XK')).toBeNull();
    expect(parseIsoCountryCode('AN')).toBeNull();
    expect(parseIsoCountryCode('us')).toBeNull();

    expect(parseCanonicalBcp47Locale('zh-Hans-CN')).toBe('zh-Hans-CN');
    expect(parseCanonicalBcp47Locale('en-us')).toBeNull();
    expect(parseCanonicalBcp47Locale('not_a_locale')).toBeNull();
    expect(parseSafeToken('policy:v1')).toBe('policy:v1');
    expect(parseSafeToken('')).toBeNull();
    expect(parseSafeToken('x'.repeat(65))).toBeNull();
    expect(keyedDigest).not.toBeNull();
    expect(parseKeyedDigest(`hmac-sha256:v1:key:${'A'.repeat(64)}`)).toBeNull();
    expect(parseKeyedDigest(`sha256:${'b'.repeat(64)}`)).toBeNull();
    expect(statementDigest).not.toBeNull();
  });
});

describe('canonicalizeSensitiveStatementV1', () => {
  it('applies line-ending normalization, NFC, and only the exact edge trim set', () => {
    const edge =
      '\u0009\u000a\u000b\u000c\u000d\u0020\u0085\u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
    expect(canonicalizeSensitiveStatementV1(`${edge}Cafe\u0301\r\nline\rnext${edge}`)).toBe(
      'Café\nline\nnext',
    );
  });

  it('preserves internal whitespace, punctuation, negation, digits, TAB, and LF', () => {
    const exact = 'I do not agree.  Item 2:\tno\nKeep this line.';
    expect(canonicalizeSensitiveStatementV1(exact)).toBe(exact);
    expect(parseSensitiveStatementTextV1(exact)).toBe(exact);
  });

  it('makes server parsing reject non-canonical or unsafe input', () => {
    expect(parseSensitiveStatementTextV1(' padded ')).toBeNull();
    expect(parseSensitiveStatementTextV1('Cafe\u0301')).toBeNull();
    expect(parseSensitiveStatementTextV1('line\rbreak')).toBeNull();
    expect(canonicalizeSensitiveStatementV1('A\u0000B')).toBeNull();
    expect(canonicalizeSensitiveStatementV1('A\u007fB')).toBeNull();
    expect(canonicalizeSensitiveStatementV1('\ud800')).toBeNull();
    expect(canonicalizeSensitiveStatementV1(' '.repeat(10))).toBeNull();
    expect(canonicalizeSensitiveStatementV1('x'.repeat(4096))).not.toBeNull();
    expect(canonicalizeSensitiveStatementV1('x'.repeat(4097))).toBeNull();
  });
});

describe('bounded, sorted, unique sensitive item sets', () => {
  const itemA = {
    clientDiscoveryItemId: uuidA,
    observedConceptCode: 'TRUTHFULNESS_ATTESTATION',
    regionCode: null,
    locale,
    statementText: statement,
  } as const;
  const itemB = { ...itemA, clientDiscoveryItemId: uuidB } as const;

  it('accepts 1..20 discovery items only in canonical id order with exact keys', () => {
    expect(parseSensitiveDiscoveryItemsV2([itemA, itemB])).not.toBeNull();
    expect(parseSensitiveDiscoveryItemsV2([])).toBeNull();
    expect(parseSensitiveDiscoveryItemsV2([itemB, itemA])).toBeNull();
    expect(parseSensitiveDiscoveryItemsV2([itemA, itemA])).toBeNull();
    expect(parseSensitiveDiscoveryItemsV2([{ ...itemA, html: '<p>secret</p>' }])).toBeNull();
    expect(
      parseSensitiveDiscoveryItemsV2([
        {
          ...itemA,
          clientDiscoveryItemId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        },
        {
          ...itemA,
          clientDiscoveryItemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      ]),
    ).toBeNull();
    const twentyOne = Array.from({ length: 21 }, (_, index) => ({
      ...itemA,
      clientDiscoveryItemId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    }));
    expect(parseSensitiveDiscoveryItemsV2(twentyOne)).toBeNull();
  });

  it('applies the same exact-set discipline to decision and claim raw-statement items', () => {
    const decisionA = {
      confirmationItemId: uuidA,
      statementDigest,
      decision: 'RELEASE',
    } as const;
    const decisionB = { ...decisionA, confirmationItemId: uuidB } as const;
    expect(parseSensitiveWriteDecisionItemsV2([decisionA, decisionB])).not.toBeNull();
    expect(parseSensitiveWriteDecisionItemsV2([])).toBeNull();
    expect(parseSensitiveWriteDecisionItemsV2([decisionB, decisionA])).toBeNull();
    expect(parseSensitiveWriteDecisionItemsV2([{ ...decisionA, decision: 'ALLOW' }])).toBeNull();
    const twentyDecisions = Array.from({ length: 20 }, (_, index) => ({
      ...decisionA,
      confirmationItemId: numberedUuid(index + 1),
    }));
    expect(parseSensitiveWriteDecisionItemsV2(twentyDecisions)).not.toBeNull();
    expect(
      parseSensitiveWriteDecisionItemsV2([
        ...twentyDecisions,
        { ...decisionA, confirmationItemId: numberedUuid(21) },
      ]),
    ).toBeNull();

    const actualA = { releaseItemId: uuidA, locale, statementText: statement } as const;
    const actualB = { ...actualA, releaseItemId: uuidB } as const;
    expect(parseActualSensitiveItemsV2([actualA, actualB])).not.toBeNull();
    expect(parseActualSensitiveItemsV2([actualA, actualA])).toBeNull();
    expect(parseActualSensitiveItemsV2([{ ...actualA, statementDigest }])).toBeNull();
  });

  it('strictly decodes the two confirmation mutation bodies', () => {
    const discovery = {
      executionProtocolVersion: 2,
      extensionInstallId: uuidA,
      clientReceiptId: uuidB,
      executionLease: 'opaque-secret',
      missionStepId: uuidC,
      intentVersion: 2,
      jobIdentityHash: digest,
      planDigest: digest,
      outcome: 'USER_ACTION_REQUIRED',
      fieldResults: [],
      discovery: { classifierVersion: 'sensitive-classifier-v1', items: [itemA] },
      executionStartedAt: '2026-08-18T10:04:10.000Z',
      executionFinishedAt: '2026-08-18T10:04:15.000Z',
    } as const;
    expect(parseCreateSensitiveWriteConfirmationRequestV2(discovery)).not.toBeNull();
    expect(
      parseCreateSensitiveWriteConfirmationRequestV2({
        ...discovery,
        fieldResults: [{ fieldKey: 'email', outcomeCode: 'FILLED' }],
      }),
    ).toBeNull();
    expect(
      parseCreateSensitiveWriteConfirmationRequestV2({
        ...discovery,
        executionFinishedAt: '2026-08-18T10:04:00.000Z',
      }),
    ).toBeNull();

    const decision = {
      clientRequestId: uuidA,
      extensionInstallId: uuidB,
      confirmationDecisionToken: 'A'.repeat(43),
      expectedStateRevision: '1',
      confirmationDigest: digest,
      items: [
        { confirmationItemId: uuidC, statementDigest, decision: 'HANDLE_MANUALLY' },
      ],
    } as const;
    expect(parseDecideSensitiveWriteConfirmationRequestV2(decision)).not.toBeNull();
    expect(
      parseDecideSensitiveWriteConfirmationRequestV2({ ...decision, statementText: statement }),
    ).toBeNull();
    expect(
      parseDecideSensitiveWriteConfirmationRequestV2({
        ...decision,
        confirmationDecisionToken: `${'A'.repeat(42)}B`,
      }),
    ).toBeNull();
  });
});

describe('typed material is value-scoped and exact', () => {
  const release = { id: uuidA, revision: '1', digest } as const;

  it('validates material value bounds and canonical multi-choice sets', () => {
    expect(parseSensitiveMaterialValueV1({ kind: 'BOOLEAN', value: false })).not.toBeNull();
    expect(parseSensitiveMaterialValueV1({ kind: 'SINGLE_CHOICE', optionCode: 'YES' })).not.toBeNull();
    expect(
      parseSensitiveMaterialValueV1({ kind: 'MULTI_CHOICE', optionCodes: ['A', 'B'] }),
    ).not.toBeNull();
    expect(parseSensitiveMaterialValueV1({ kind: 'MULTI_CHOICE', optionCodes: [] })).toBeNull();
    expect(
      parseSensitiveMaterialValueV1({
        kind: 'MULTI_CHOICE',
        optionCodes: Array.from({ length: 20 }, (_, index) => `A${String(index).padStart(2, '0')}`),
      }),
    ).not.toBeNull();
    expect(
      parseSensitiveMaterialValueV1({
        kind: 'MULTI_CHOICE',
        optionCodes: Array.from({ length: 21 }, (_, index) => `A${String(index).padStart(2, '0')}`),
      }),
    ).toBeNull();
    expect(
      parseSensitiveMaterialValueV1({ kind: 'MULTI_CHOICE', optionCodes: ['B', 'A'] }),
    ).toBeNull();
    expect(
      parseSensitiveMaterialValueV1({ kind: 'MULTI_CHOICE', optionCodes: ['A', 'A'] }),
    ).toBeNull();
    expect(parseSensitiveMaterialValueV1({ kind: 'SHORT_TEXT', text: 'x'.repeat(256) })).not.toBeNull();
    expect(parseSensitiveMaterialValueV1({ kind: 'SHORT_TEXT', text: 'x'.repeat(257) })).toBeNull();
    expect(parseSensitiveMaterialValueV1({ kind: 'BOOLEAN', value: true, extra: true })).toBeNull();
  });

  it('locks RELEASE_DECISION_BOOLEAN_TRUE to exact boolean true', () => {
    const base = {
      releaseItemId: uuidA,
      targetOccurrenceId: uuidB,
      valueAuthority: { kind: 'RELEASE_DECISION_BOOLEAN_TRUE' },
    } as const;
    expect(
      parseSensitiveExecutionMaterialItemsV2([
        { ...base, answer: { kind: 'BOOLEAN', value: true } },
      ]),
    ).not.toBeNull();
    expect(
      parseSensitiveExecutionMaterialItemsV2([
        { ...base, answer: { kind: 'BOOLEAN', value: false } },
      ]),
    ).toBeNull();
    expect(
      parseSensitiveExecutionMaterialItemsV2([
        { ...base, answer: { kind: 'SHORT_TEXT', text: 'yes' } },
      ]),
    ).toBeNull();
  });

  it('allows stored EEO/work facts but never promotes truthfulness into a reusable profile value', () => {
    const stored = {
      kind: 'SENSITIVE_VALUE_RECORD',
      sensitiveValue: {
        id: uuidC,
        revision: '4',
        deletionEpoch: '0',
        digest: keyedDigest,
        definition: {
          definitionCode: 'eeo-race-us-v1',
          definitionVersion: '1',
          answerSchemaVersion: 'choice-v1',
          subject: {
            kind: 'EEO_SELF_IDENTIFICATION',
            jurisdictionCode: 'US',
            optionSetCode: 'eeo-race-us-v1',
          },
        },
      },
    } as const;
    const item = {
      releaseItemId: uuidA,
      targetOccurrenceId: uuidB,
      valueAuthority: stored,
      answer: { kind: 'SINGLE_CHOICE', optionCode: 'DECLINE_TO_ANSWER' },
    } as const;
    expect(parseSensitiveExecutionMaterialItemsV2([item])).not.toBeNull();
    const forbiddenReusableTruth = {
      ...item,
      valueAuthority: {
        ...stored,
        sensitiveValue: {
          ...stored.sensitiveValue,
          definition: {
            definitionCode: 'truthfulness-v1',
            definitionVersion: '1',
            answerSchemaVersion: 'boolean-v1',
            subject: {
              kind: 'TRUTHFULNESS_ATTESTATION',
              polarity: 'AFFIRMATIVE',
              optionSetCode: 'BOOLEAN_TRUE',
            },
          },
        },
      },
      answer: { kind: 'BOOLEAN', value: true },
    } as const;
    expect(parseSensitiveExecutionMaterialItemsV2([forbiddenReusableTruth])).toBeNull();
  });

  it('strictly decodes the POST material body and no-store response', () => {
    const request = {
      executionProtocolVersion: 2,
      extensionInstallId: uuidA,
      executionLease: 'opaque-secret',
      missionStepId: uuidB,
      intentVersion: 3,
      sensitiveWriteRelease: release,
    } as const;
    expect(parseSensitiveWriteReleaseRefV1(release)).not.toBeNull();
    expect(parseFetchSensitiveExecutionMaterialRequestV2(request)).not.toBeNull();
    expect(parseFetchSensitiveExecutionMaterialRequestV2({ ...request, statementText: statement })).toBeNull();
    expect(
      parseSensitiveWriteReleaseRefV1({ ...release, id: '00000000-0000-1000-8000-000000000001' }),
    ).toBeNull();

    const response = {
      schemaVersion: 2,
      materialSchemaVersion: 1,
      sensitiveWriteRelease: release,
      items: [
        {
          releaseItemId: uuidA,
          targetOccurrenceId: uuidB,
          valueAuthority: { kind: 'RELEASE_DECISION_BOOLEAN_TRUE' },
          answer: { kind: 'BOOLEAN', value: true },
        },
      ],
    } as const;
    expect(parseFetchSensitiveExecutionMaterialResponseV2(response)).not.toBeNull();
    expect(parseFetchSensitiveExecutionMaterialResponseV2({ ...response, items: [] })).toBeNull();
    const twentyItems = Array.from({ length: 20 }, (_, index) => ({
      ...response.items[0],
      releaseItemId: numberedUuid(index + 1),
    }));
    expect(
      parseFetchSensitiveExecutionMaterialResponseV2({ ...response, items: twentyItems }),
    ).not.toBeNull();
    expect(
      parseFetchSensitiveExecutionMaterialResponseV2({
        ...response,
        items: [
          ...twentyItems,
          { ...response.items[0], releaseItemId: numberedUuid(21) },
        ],
      }),
    ).toBeNull();
    expect(parseFetchSensitiveExecutionMaterialResponseV2({ ...response, etag: 'secret' })).toBeNull();
  });
});

describe('v2 issue, claim, and receipt runtime decoders', () => {
  const release = { id: uuidA, revision: '1', digest } as const;
  const actualTarget = {
    canonicalOrigin: 'https://boards.example.invalid',
    pathRuleId: parseSafeToken('greenhouse-v3')!,
    postingFingerprint: digest,
  } as const;
  const sensitiveResult = {
    sensitivity: 'USER_RELEASE_REQUIRED',
    releaseItemId: uuidA,
    outcomeCode: 'FILLED',
    reasonCode: null,
  } as const;
  const receiptCommon = {
    executionProtocolVersion: 2,
    clientReceiptId: uuidA,
    executionLease: 'opaque-secret',
    missionStepId: uuidB,
    intentVersion: 2,
    jobIdentityHash: digest,
    planDigest: digest,
    executionStartedAt: '2026-08-18T10:04:10.000Z',
    executionFinishedAt: '2026-08-18T10:04:15.000Z',
  } as const;
  const responseReceiptCommon = {
    id: uuidA,
    clientReceiptId: uuidB,
    missionId: uuidC,
    missionStepId: uuidA,
    intentVersion: 2,
    outcome: 'FILL_SUCCEEDED',
    verificationLevel: 'CLIENT_REPORTED',
    createdAt: '2026-08-18T10:04:16.000Z',
  } as const;
  const mission = { id: uuidC, revision: '8', status: 'WAITING_FOR_USER' } as const;

  it('decodes both exact issue arms and rejects mixed, legacy, extra, and non-v4 shapes', () => {
    const approval = {
      executionProtocolVersion: 2,
      missionRevision: '7',
      extensionInstallId: uuidA,
      authority: { kind: 'APPROVAL', missionStepId: uuidB },
    } as const;
    const sensitive = {
      executionProtocolVersion: 2,
      missionRevision: '8',
      extensionInstallId: uuidA,
      authority: { kind: 'SENSITIVE_WRITE_RELEASE', sensitiveWriteRelease: release },
    } as const;
    expect(parseExecutionIntentIssueRequestV2(approval)).not.toBeNull();
    expect(parseExecutionIntentIssueRequestV2(sensitive)).not.toBeNull();
    expect(
      parseExecutionIntentIssueRequestV2({
        ...approval,
        authority: { ...approval.authority, sensitiveWriteRelease: release },
      }),
    ).toBeNull();
    expect(parseExecutionIntentIssueRequestV2({ ...approval, missionStepId: uuidB })).toBeNull();
    expect(parseExecutionIntentIssueRequestV2({ ...approval, extra: true })).toBeNull();
    expect(
      parseExecutionIntentIssueRequestV2({
        ...approval,
        extensionInstallId: '00000000-0000-1000-8000-000000000001',
      }),
    ).toBeNull();
    expect(
      parseExecutionIntentIssueRequestV2({
        ...approval,
        extensionInstallId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      }),
    ).toBeNull();
    expect(
      parseExecutionIntentIssueRequestV2(
        Object.assign(Object.create({ inherited: true }), approval),
      ),
    ).toBeNull();
  });

  it('decodes only the schema-2 exact issue response and exact kid grammar', () => {
    const response = {
      schemaVersion: 2,
      executionProtocolVersion: 2,
      executionIntent: 'header.payload.signature',
      expiresAt: '2026-08-18T10:05:00.000Z',
      intentVersion: 2,
      kid: 'exec-2026-08-a',
    } as const;
    expect(parseIssueExecutionIntentResponseV2(response)).not.toBeNull();
    expect(parseIssueExecutionIntentResponseV2({ ...response, schemaVersion: 1 })).toBeNull();
    expect(parseIssueExecutionIntentResponseV2({ ...response, kid: 'key:colon' })).toBeNull();
    expect(parseIssueExecutionIntentResponseV2({ ...response, kid: 'x'.repeat(65) })).toBeNull();
    expect(parseIssueExecutionIntentResponseV2({ ...response, values: {} })).toBeNull();
  });

  it('decodes the two exact claim arms and enforces sorted closed field sets', () => {
    const standard = {
      executionProtocolVersion: 2,
      executionIntent: 'header.payload.signature',
      extensionInstallId: uuidA,
      actualTarget,
      actualFieldKeys: ['email', 'firstName'],
      scanDigest: digest,
    } as const;
    const sensitive = {
      executionProtocolVersion: 2,
      executionIntent: 'header.payload.signature',
      extensionInstallId: uuidA,
      actualTarget,
      actualSensitiveItems: [{ releaseItemId: uuidB, locale, statementText: statement }],
      scanDigest: digest,
    } as const;
    expect(parseClaimExecutionIntentRequestV2(standard)).not.toBeNull();
    expect(parseClaimExecutionIntentRequestV2(sensitive)).not.toBeNull();
    expect(parseClaimExecutionIntentRequestV2({ ...standard, actualFieldKeys: [] })).toBeNull();
    expect(
      parseClaimExecutionIntentRequestV2({
        ...standard,
        actualFieldKeys: ['firstName', 'email'],
      }),
    ).toBeNull();
    expect(
      parseClaimExecutionIntentRequestV2({ ...standard, actualFieldKeys: ['email', 'email'] }),
    ).toBeNull();
    expect(
      parseClaimExecutionIntentRequestV2({ ...standard, actualFieldKeys: ['password'] }),
    ).toBeNull();
    expect(
      parseClaimExecutionIntentRequestV2({
        ...standard,
        actualSensitiveItems: sensitive.actualSensitiveItems,
      }),
    ).toBeNull();
    expect(parseClaimExecutionIntentRequestV2({ ...sensitive, extra: true })).toBeNull();
    expect(
      parseClaimExecutionIntentRequestV2({
        ...standard,
        actualTarget: { ...actualTarget, canonicalOrigin: 'https://user@example.invalid' },
      }),
    ).toBeNull();
  });

  it('enforces the claim raw-item OneToTwenty bound at runtime', () => {
    const claim = {
      executionProtocolVersion: 2,
      executionIntent: 'header.payload.signature',
      extensionInstallId: uuidA,
      actualTarget,
      actualSensitiveItems: [] as unknown[],
      scanDigest: digest,
    };
    expect(parseClaimExecutionIntentRequestV2(claim)).toBeNull();
    claim.actualSensitiveItems = Array.from({ length: 20 }, (_, index) => ({
      releaseItemId: numberedUuid(index + 1),
      locale,
      statementText: statement,
    }));
    expect(parseClaimExecutionIntentRequestV2(claim)).not.toBeNull();
    claim.actualSensitiveItems.push({
      releaseItemId: numberedUuid(21),
      locale,
      statementText: statement,
    });
    expect(parseClaimExecutionIntentRequestV2(claim)).toBeNull();
  });

  it('decodes exact standard/release claim responses without mixing authority arms', () => {
    const claimCommon = {
      missionId: uuidA,
      missionStepId: uuidB,
      intentVersion: 2,
      executionLease: 'opaque-secret',
      leaseExpiresAt: '2026-08-18T10:09:00.000Z',
    } as const;
    const standard = {
      schemaVersion: 2,
      executionProtocolVersion: 2,
      claim: {
        ...claimCommon,
        allowedActions: ['DISCOVER_SENSITIVE', 'FILL'],
        sensitiveWriteRelease: null,
      },
    } as const;
    const sensitive = {
      schemaVersion: 2,
      executionProtocolVersion: 2,
      claim: {
        ...claimCommon,
        allowedActions: ['FILL_SENSITIVE'],
        sensitiveWriteRelease: release,
      },
    } as const;
    expect(parseClaimExecutionIntentResponseV2(standard)).not.toBeNull();
    expect(parseClaimExecutionIntentResponseV2(sensitive)).not.toBeNull();
    expect(
      parseClaimExecutionIntentResponseV2({
        ...standard,
        claim: { ...standard.claim, allowedActions: ['FILL', 'DISCOVER_SENSITIVE'] },
      }),
    ).toBeNull();
    expect(
      parseClaimExecutionIntentResponseV2({
        ...standard,
        claim: { ...standard.claim, sensitiveWriteRelease: release },
      }),
    ).toBeNull();
    expect(
      parseClaimExecutionIntentResponseV2({
        ...sensitive,
        claim: { ...sensitive.claim, allowedActions: ['FILL_SENSITIVE', 'SUBMIT'] },
      }),
    ).toBeNull();
    expect(parseClaimExecutionIntentResponseV2({ ...sensitive, etag: 'forbidden' })).toBeNull();
  });

  it('decodes exact standard and sensitive receipt requests and rejects raw or mixed fields', () => {
    const standard = {
      ...receiptCommon,
      receiptMode: 'STANDARD',
      outcome: 'FILL_SUCCEEDED',
      fieldResults: [{ fieldKey: 'email', outcomeCode: 'FILLED' }],
    } as const;
    const sensitive = {
      ...receiptCommon,
      receiptMode: 'SENSITIVE_RELEASE',
      sensitiveReleaseSnapshot: release,
      outcome: 'FILL_SUCCEEDED',
      fieldResults: [sensitiveResult],
    } as const;
    expect(parseSubmitApplicationReceiptRequestV2(standard)).not.toBeNull();
    expect(parseSubmitApplicationReceiptRequestV2(sensitive)).not.toBeNull();
    expect(
      parseSubmitApplicationReceiptRequestV2({
        ...standard,
        fieldResults: [
          { fieldKey: 'firstName', outcomeCode: 'FILLED' },
          { fieldKey: 'email', outcomeCode: 'FILLED' },
        ],
      }),
    ).not.toBeNull();
    expect(
      parseSubmitApplicationReceiptRequestV2({
        ...standard,
        fieldResults: [
          { fieldKey: 'email', outcomeCode: 'FILLED' },
          { fieldKey: 'email', outcomeCode: 'FAILED' },
        ],
      }),
    ).toBeNull();
    expect(
      parseSubmitApplicationReceiptRequestV2({
        ...standard,
        fieldResults: [{ fieldKey: 'password', outcomeCode: 'FILLED' }],
      }),
    ).toBeNull();
    expect(
      parseSubmitApplicationReceiptRequestV2({ ...standard, sensitiveReleaseSnapshot: release }),
    ).toBeNull();
    expect(parseSubmitApplicationReceiptRequestV2({ ...sensitive, statementText: statement })).toBeNull();
    expect(
      parseSubmitApplicationReceiptRequestV2({ ...sensitive, outcome: 'SUBMISSION_TRIGGERED' }),
    ).toBeNull();
    expect(
      parseSubmitApplicationReceiptRequestV2({
        ...sensitive,
        executionFinishedAt: '2026-08-18T10:04:00.000Z',
      }),
    ).toBeNull();
    expect(
      parseSubmitApplicationReceiptRequestV2({
        ...sensitive,
        fieldResults: [{ ...sensitiveResult, fieldKey: 'email' }],
      }),
    ).toBeNull();
  });

  it('enforces the sensitive receipt OneToTwenty bound, sorting, and uniqueness at runtime', () => {
    const receipt = {
      ...receiptCommon,
      receiptMode: 'SENSITIVE_RELEASE',
      sensitiveReleaseSnapshot: release,
      outcome: 'FILL_SUCCEEDED',
      fieldResults: [] as Array<typeof sensitiveResult>,
    };
    expect(parseSubmitApplicationReceiptRequestV2(receipt)).toBeNull();
    receipt.fieldResults = Array.from({ length: 20 }, (_, index) => ({
      ...sensitiveResult,
      releaseItemId: numberedUuid(index + 1),
    }));
    expect(parseSubmitApplicationReceiptRequestV2(receipt)).not.toBeNull();
    receipt.fieldResults.push({ ...sensitiveResult, releaseItemId: numberedUuid(21) });
    expect(parseSubmitApplicationReceiptRequestV2(receipt)).toBeNull();
    expect(
      parseSubmitApplicationReceiptRequestV2({
        ...receipt,
        fieldResults: [
          { ...sensitiveResult, releaseItemId: uuidB },
          { ...sensitiveResult, releaseItemId: uuidA },
        ],
      }),
    ).toBeNull();
    expect(
      parseSubmitApplicationReceiptRequestV2({
        ...receipt,
        fieldResults: [sensitiveResult, sensitiveResult],
      }),
    ).toBeNull();
  });

  it('decodes exact standard/release receipt responses and enforces paired provenance', () => {
    const standard = {
      schemaVersion: 2,
      receipt: responseReceiptCommon,
      mission,
    } as const;
    const sensitive = {
      schemaVersion: 2,
      receipt: {
        ...responseReceiptCommon,
        sensitiveReleaseSnapshot: release,
        fieldResults: [sensitiveResult],
      },
      mission,
    } as const;
    expect(parseSubmitApplicationReceiptResponseV2(standard)).not.toBeNull();
    expect(parseSubmitApplicationReceiptResponseV2(sensitive)).not.toBeNull();
    expect(
      parseSubmitApplicationReceiptResponseV2({
        ...sensitive,
        receipt: { ...sensitive.receipt, fieldResults: [] },
      }),
    ).toBeNull();
    const twentyResults = Array.from({ length: 20 }, (_, index) => ({
      ...sensitiveResult,
      releaseItemId: numberedUuid(index + 1),
    }));
    expect(
      parseSubmitApplicationReceiptResponseV2({
        ...sensitive,
        receipt: { ...sensitive.receipt, fieldResults: twentyResults },
      }),
    ).not.toBeNull();
    expect(
      parseSubmitApplicationReceiptResponseV2({
        ...sensitive,
        receipt: {
          ...sensitive.receipt,
          fieldResults: [
            ...twentyResults,
            { ...sensitiveResult, releaseItemId: numberedUuid(21) },
          ],
        },
      }),
    ).toBeNull();
    expect(
      parseSubmitApplicationReceiptResponseV2({
        ...sensitive,
        receipt: { ...sensitive.receipt, sensitiveReleaseSnapshot: undefined },
      }),
    ).toBeNull();
    const { fieldResults: _omitted, ...releaseWithoutResults } = sensitive.receipt;
    expect(
      parseSubmitApplicationReceiptResponseV2({
        ...sensitive,
        receipt: releaseWithoutResults,
      }),
    ).toBeNull();
    expect(
      parseSubmitApplicationReceiptResponseV2({
        ...sensitive,
        receipt: { ...sensitive.receipt, outcome: 'SUBMISSION_CONFIRMED' },
      }),
    ).toBeNull();
    expect(parseSubmitApplicationReceiptResponseV2({ ...standard, rawError: 'secret' })).toBeNull();
  });
});

describe('v2 issue, claim, receipt, and decision types are closed discriminated unions', () => {
  const release = { id: uuidA, revision: '1', digest } as const;
  const actualTarget = {
    canonicalOrigin: 'https://boards.example.invalid',
    pathRuleId: parseSafeToken('greenhouse-v3')!,
    postingFingerprint: digest,
  } as const;

  it('separates APPROVAL and SENSITIVE_WRITE_RELEASE issue authority', () => {
    const approval: ExecutionIntentIssueRequestV2 = {
      executionProtocolVersion: 2,
      missionRevision: '7',
      extensionInstallId: uuidA,
      authority: { kind: 'APPROVAL', missionStepId: uuidB },
    };
    const sensitive: ExecutionIntentIssueRequestV2 = {
      executionProtocolVersion: 2,
      missionRevision: '9',
      extensionInstallId: uuidA,
      authority: { kind: 'SENSITIVE_WRITE_RELEASE', sensitiveWriteRelease: release },
    };
    const mixed = {
      ...approval,
      authority: { kind: 'APPROVAL', missionStepId: uuidB, sensitiveWriteRelease: release },
    } as const;
    // @ts-expect-error an APPROVAL arm cannot smuggle a sensitive release ref.
    const invalid: ExecutionIntentIssueRequestV2 = mixed;
    expect(approval.authority.kind).toBe('APPROVAL');
    expect(sensitive.authority.kind).toBe('SENSITIVE_WRITE_RELEASE');
    expect(invalid.authority.kind).toBe('APPROVAL');
  });

  it('separates standard field claims from sensitive raw-statement claims', () => {
    const standard: ClaimExecutionIntentRequestV2 = {
      executionProtocolVersion: 2,
      executionIntent: 'compact-jws',
      extensionInstallId: uuidA,
      actualTarget,
      actualFieldKeys: ['email'],
      scanDigest: digest,
    };
    const sensitive: ClaimExecutionIntentRequestV2 = {
      executionProtocolVersion: 2,
      executionIntent: 'compact-jws',
      extensionInstallId: uuidA,
      actualTarget,
      actualSensitiveItems: [{ releaseItemId: uuidB, locale, statementText: statement }],
      scanDigest: digest,
    };
    const mixed = { ...standard, actualSensitiveItems: sensitive.actualSensitiveItems };
    // @ts-expect-error the two v2 claim arms are mutually exclusive.
    const invalid: ClaimExecutionIntentRequestV2 = mixed;
    expect(standard.actualFieldKeys).toEqual(['email']);
    expect(sensitive.actualSensitiveItems).toHaveLength(1);
    expect(invalid.executionProtocolVersion).toBe(2);
  });

  it('keeps sensitive receipts value-free and submission-free', () => {
    const receipt: SubmitApplicationReceiptRequestV2SensitiveRelease = {
      executionProtocolVersion: 2,
      receiptMode: 'SENSITIVE_RELEASE',
      clientReceiptId: uuidA,
      executionLease: 'opaque-secret',
      missionStepId: uuidB,
      intentVersion: 3,
      jobIdentityHash: digest,
      planDigest: digest,
      sensitiveReleaseSnapshot: release,
      outcome: 'FILL_SUCCEEDED',
      fieldResults: [
        {
          sensitivity: 'USER_RELEASE_REQUIRED',
          releaseItemId: uuidC,
          outcomeCode: 'FILLED',
          reasonCode: null,
        },
      ],
      executionStartedAt: '2026-08-18T10:40:10.000Z' as never,
      executionFinishedAt: '2026-08-18T10:40:15.000Z' as never,
    };
    const withRaw = { ...receipt, statementText: statement };
    // @ts-expect-error a sensitive receipt cannot contain statement text.
    const invalidRaw: SubmitApplicationReceiptRequestV2SensitiveRelease = withRaw;
    const withSubmit = { ...receipt, outcome: 'SUBMISSION_TRIGGERED' } as const;
    // @ts-expect-error a FILL_SENSITIVE-only intent cannot report submission.
    const invalidSubmit: SubmitApplicationReceiptRequestV2SensitiveRelease = withSubmit;
    expect(receipt.receiptMode).toBe('SENSITIVE_RELEASE');
    expect(invalidRaw.statementText).toBe(statement);
    expect(invalidSubmit.outcome).toBe('SUBMISSION_TRIGGERED');
  });

  it('ties decision response status pairs and material request fields at compile time', () => {
    const handoff: SensitiveWriteDecisionResponseV2 = {
      schemaVersion: 2,
      confirmation: {
        kind: 'SENSITIVE_WRITE_CONFIRM',
        id: uuidA,
        revision: '1',
        stateRevision: '2',
        status: 'MANUAL_HANDOFF',
      },
      mission: { id: uuidB, revision: '10', status: 'CANCELLATION_REQUESTED' },
      sensitiveWriteRelease: null,
      releasedItems: [],
    };
    const request: FetchSensitiveExecutionMaterialRequestV2 = {
      executionProtocolVersion: 2,
      extensionInstallId: uuidA,
      executionLease: 'opaque-secret',
      missionStepId: uuidB,
      intentVersion: 3,
      sensitiveWriteRelease: release,
    };
    expect(handoff.confirmation.status).toBe('MANUAL_HANDOFF');
    expect(request.sensitiveWriteRelease).toEqual(release);
  });

  it('keeps discovery replay on the immutable first-success PENDING/WAITING snapshot', () => {
    const replay: CreateSensitiveWriteConfirmationResponseV2 = {
      schemaVersion: 2,
      confirmationDecisionToken: null,
      receipt: { id: uuidA, outcome: 'USER_ACTION_REQUIRED' },
      mission: { id: uuidB, revision: '9', status: 'WAITING_FOR_USER' },
      sensitiveWriteConfirmation: {
        kind: 'SENSITIVE_WRITE_CONFIRM',
        id: uuidC,
        revision: '1',
        stateRevision: '1',
        status: 'PENDING',
        missionId: uuidB,
        sourceReceiptId: uuidA,
        sourceMissionStepId: uuidA,
        confirmationStepId: uuidC,
        sourceIntentVersion: 2,
        extensionInstallId: uuidA,
        jobIdentityHash: digest,
        targetCountryCode: parseIsoCountryCode('US')!,
        basePlanDigest: digest,
        confirmationDigest: digest,
        classifierVersion: parseSafeToken('classifier-v1')!,
        sensitiveSettingRevision: '3',
        sensitiveConsentVersion: parseSafeToken('sensitive-assisted-write-v1')!,
        sensitiveReleasePolicyVersion: parseSafeToken('sensitive-release-v1')!,
        uiCopyVersion: parseSafeToken('sensitive-confirm-ui-v1')!,
        expiresAt: '2026-08-18T10:34:15.000Z' as never,
        items: [
          {
            confirmationItemId: uuidA,
            clientDiscoveryItemId: uuidB,
            targetOccurrenceId: uuidC,
            conceptCode: 'TRUTHFULNESS_ATTESTATION',
            regionCode: null,
            definition: {
              definitionCode: parseSafeToken('truthfulness-affirmative-v1')!,
              definitionVersion: parseSafeToken('1')!,
              answerSchemaVersion: parseSafeToken('boolean-v1')!,
              subject: {
                kind: 'TRUTHFULNESS_ATTESTATION',
                polarity: 'AFFIRMATIVE',
                optionSetCode: 'BOOLEAN_TRUE',
              },
            },
            statementDigest,
            valueAuthority: { kind: 'RELEASE_DECISION_BOOLEAN_TRUE' },
          },
        ],
      },
    };
    const terminalMutation = {
      ...replay,
      sensitiveWriteConfirmation: {
        ...replay.sensitiveWriteConfirmation!,
        status: 'RELEASED',
      },
    } as const;
    // @ts-expect-error discovery replay never hydrates a later terminal confirmation state.
    const invalid: CreateSensitiveWriteConfirmationResponseV2 = terminalMutation;
    expect(replay.confirmationDecisionToken).toBeNull();
    expect(replay.sensitiveWriteConfirmation?.status).toBe('PENDING');
    expect(invalid.sensitiveWriteConfirmation?.status).toBe('RELEASED');
  });
});
