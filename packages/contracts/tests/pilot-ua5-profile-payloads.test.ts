import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  PILOT_UA5_PROFILE_PAYLOAD_CONSTRAINTS,
  parsePilotUa5ProfilePayloadResponse,
  parsePilotUa5ProfileBinding,
} from '../src/draft/pilotUa5ProfilePayloads';

const hex = (seed: string): string => seed.repeat(64).slice(0, 64);
const identityDigest = hex('a');
const semanticDigest = hex('b');
const pageIdentityDigest = hex('c');
const authorityId = hex('d');
const answerDigest = hex('e');
const domGeneration = hex('f');
const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const binding = Object.freeze({
  origin: 'https://example.invalid',
  pathname: '/apply',
  domGeneration,
});

function success() {
  return {
    ok: true,
    schemaVersion: 1,
    composition: {
      ok: true,
      schemaVersion: 1,
      candidateRule: {
        schemaVersion: 1,
        kind: 'EPHEMERAL_PAGE_CANDIDATE',
        binding,
        pageIdentityDigest,
        issuedAtMs: 1_000,
        expiresAtMs: 31_000,
        classifications: [{
          identityDigest,
          kind: 'CANONICAL_FIELD',
          canonicalField: 'EMAIL',
          confidence: 'HIGH',
          provenance: { source: 'AUTOCOMPLETE', semanticDigest },
          reasonCode: 'CANONICAL_AUTOCOMPLETE_MATCH',
        }],
        constraints: {
          remoteCode: 'FORBIDDEN',
          automaticPublication: 'FORBIDDEN',
          writerAuthority: 'NOT_GRANTED',
          submit: 'HUMAN_ONLY',
          activationState: 'DEFAULT_OFF',
          releaseState: 'NOT_RELEASED',
        },
      },
      authority: {
        authorityId,
        binding,
        pageIdentityDigest,
        observedControlIdentityDigests: [identityDigest],
        expiresAtMs: 31_000,
        questionAuthorizations: [{
          questionId: 'question.email',
          controlKind: 'TEXT',
          identityDigests: [identityDigest],
          required: true,
          answerAuthority: 'PROFILE_CONFIRMED',
          answerDigest,
        }],
        blockedQuestions: [],
        constraints: {
          exactTargetBinding: 'REQUIRED',
          semanticReadback: 'REQUIRED',
          hostValidation: 'REQUIRED',
          lateRecheck: 'REQUIRED',
          undo: 'REQUIRED',
          submit: 'FORBIDDEN',
          activationState: 'DEFAULT_OFF',
          releaseState: 'NOT_RELEASED',
        },
      },
      projection: {
        schemaVersion: 1,
        binding,
        rows: [{
          questionId: 'question.email',
          required: true,
          writerKind: 'TEXT',
          memberCount: 1,
          admission: 'AUTHORIZED',
        }],
        summary: {
          observableQuestions: 1,
          requiredQuestions: 1,
          authorizedQuestions: 1,
          requiredAuthorizedQuestions: 1,
        },
      },
      constraints: {
        submit: 'FORBIDDEN',
        remoteCode: 'FORBIDDEN',
        rawValues: 'NEVER_TRANSMITTED',
        activationState: 'DEFAULT_OFF',
        releaseState: 'NOT_RELEASED',
      },
    },
    profileBinding: {
      fieldSchemaVersion: 1,
      fieldKeys: ['email'],
      revision: '7',
      deletionEpoch: '0',
      snapshotDigest: `sha256:${hex('1')}`,
    },
    payloads: [{
      questionId: 'question.email',
      payloadRef: 'ua5.profile.question.email',
      answerDigest,
      value: 'ada@example.invalid',
    }],
    constraints: PILOT_UA5_PROFILE_PAYLOAD_CONSTRAINTS,
  };
}

describe('pilot UA-5 Profile payload wire', () => {
  it('snapshots the original binding and rejects unknown fields, accessors, and invalid versions', () => {
    const binding = success().profileBinding;
    const parsed = parsePilotUa5ProfileBinding(binding);
    expect(parsed).toEqual(binding);
    expect(Object.isFrozen(parsed)).toBe(true);
    binding.revision = '2';
    binding.fieldKeys.push('fullName');
    expect(parsed?.revision).toBe('7');
    expect(parsed?.fieldKeys).toEqual(['email']);
    for (const invalid of [undefined, { ...binding, revision: '-1' }, { ...binding, deletionEpoch: '01' },
      { ...binding, owner: 'foreign' }, Object.defineProperty({}, 'revision', { get() { throw new Error('TEST_ACCESSOR'); } })]) {
      expect(parsePilotUa5ProfileBinding(invalid)).toBeNull();
    }
  });

  it('accepts one owner-snapshot-bound safe scalar payload beside a value-free composition', () => {
    const parsed = parsePilotUa5ProfilePayloadResponse(success());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.value.ok) throw new Error('expected success');
    expect(parsed.value.payloads).toEqual([{
      questionId: 'question.email',
      payloadRef: 'ua5.profile.question.email',
      answerDigest,
      value: 'ada@example.invalid',
    }]);
    expect(parsed.value.composition.constraints.rawValues).toBe('NEVER_TRANSMITTED');
    expect(parsed.value.constraints).toEqual({
      compositionValueBoundary: 'VALUE_FREE_SUBOBJECT_ONLY',
      payloadWire: 'DEV_ONLY_DATA_L1',
      dataLifetime: 'EPHEMERAL_MEMORY_ONLY',
      panelExposure: 'FORBIDDEN',
      persistence: 'FORBIDDEN',
      logging: 'FORBIDDEN',
    });
  });

  it('rejects a payload not bound to the exact authorization answer digest', () => {
    const candidate = success();
    candidate.payloads[0]!.answerDigest = hex('9');
    expect(parsePilotUa5ProfilePayloadResponse(candidate).ok).toBe(false);
  });

  it.each(['TEXT', 'TEXTAREA', 'NATIVE_SELECT', 'RADIO_GROUP', 'COMBOBOX'])(
    'accepts an authorized confirmed scalar for %s', (controlKind) => {
      const candidate = success();
      candidate.composition.authority.questionAuthorizations[0]!.controlKind = controlKind;
      candidate.composition.projection.rows[0]!.writerKind = controlKind;
      expect(parsePilotUa5ProfilePayloadResponse(candidate).ok).toBe(true);
    },
  );

  it('accepts a confirmed phone bound to the existing phone field key', () => {
    const candidate = success();
    candidate.composition.candidateRule.classifications[0]!.canonicalField = 'PHONE';
    candidate.profileBinding.fieldKeys = ['phone'];
    candidate.payloads[0]!.value = '+14155550100';
    expect(parsePilotUa5ProfilePayloadResponse(candidate).ok).toBe(true);
  });

  it.each([
    ['LINKEDIN_URL', 'linkedinUrl'], ['GITHUB_URL', 'githubUrl'], ['PORTFOLIO_URL', 'portfolioUrl'],
  ])('binds %s only to its existing exact field key', (canonical, fieldKey) => {
    const candidate = success();
    const classification = candidate.composition.candidateRule.classifications[0]!;
    classification.canonicalField = canonical!;
    candidate.profileBinding.fieldKeys = [fieldKey!];
    candidate.payloads[0]!.value = 'https://synthetic.example.invalid';
    expect(parsePilotUa5ProfilePayloadResponse(candidate).ok).toBe(true);
    candidate.profileBinding.fieldKeys = [fieldKey === 'linkedinUrl' ? 'githubUrl' : 'linkedinUrl'];
    expect(parsePilotUa5ProfilePayloadResponse(candidate).ok).toBe(false);
    candidate.profileBinding.fieldKeys = [fieldKey!];
    classification.canonicalField = 'URL';
    expect(parsePilotUa5ProfilePayloadResponse(candidate).ok).toBe(false);
  });

  it('requires every radio member to bind the same canonical scalar', () => {
    const candidate = success();
    const secondIdentity = hex('2');
    const classification = candidate.composition.candidateRule.classifications[0]!;
    candidate.composition.candidateRule.classifications.push({ ...classification, identityDigest: secondIdentity });
    candidate.composition.authority.observedControlIdentityDigests.push(secondIdentity);
    const authorization = candidate.composition.authority.questionAuthorizations[0]!;
    authorization.controlKind = 'RADIO_GROUP';
    authorization.identityDigests.push(secondIdentity);
    Object.assign(candidate.composition.projection.rows[0]!, { writerKind: 'RADIO_GROUP', memberCount: 2 });
    expect(parsePilotUa5ProfilePayloadResponse(candidate).ok).toBe(true);
    candidate.composition.candidateRule.classifications[1]!.canonicalField = 'PHONE';
    expect(parsePilotUa5ProfilePayloadResponse(candidate).ok).toBe(false);
  });

  it('rejects payloads for a non-safe canonical field even if UA-4 authorized it', () => {
    const candidate = success();
    candidate.composition.candidateRule.classifications[0]!.canonicalField = 'COUNTRY';
    expect(parsePilotUa5ProfilePayloadResponse(candidate).ok).toBe(false);
  });

  it.each(['CONTENTEDITABLE', 'CHECKBOX_GROUP', 'FILE'])(
    'rejects a safe scalar payload when the authority targets %s',
    (controlKind) => {
      const candidate = success();
      candidate.composition.authority.questionAuthorizations[0]!.controlKind = controlKind;
      expect(parsePilotUa5ProfilePayloadResponse(candidate).ok).toBe(false);
    },
  );

  it('requires the profile binding field keys to equal the payload-derived sorted set', () => {
    const candidate = success();
    candidate.profileBinding.fieldKeys = ['email', 'fullName'];
    expect(parsePilotUa5ProfilePayloadResponse(candidate).ok).toBe(false);
  });

  it('allows repeated safe fields across multiple questions without treating field count as payload count', () => {
    const candidate = success();
    const count = 6;
    candidate.composition.candidateRule.classifications = Array.from(
      { length: count },
      (_, index) => ({
        ...candidate.composition.candidateRule.classifications[0]!,
        identityDigest: digest(`identity-${index}`),
        provenance: {
          ...candidate.composition.candidateRule.classifications[0]!.provenance,
          semanticDigest: digest(`semantic-${index}`),
        },
      }),
    );
    candidate.composition.authority.observedControlIdentityDigests =
      candidate.composition.candidateRule.classifications.map((item) => item.identityDigest);
    candidate.composition.authority.questionAuthorizations = Array.from(
      { length: count },
      (_, index) => ({
        ...candidate.composition.authority.questionAuthorizations[0]!,
        questionId: `question.email.${index}`,
        identityDigests: [
          candidate.composition.candidateRule.classifications[index]!.identityDigest,
        ],
        answerDigest: digest(`answer-${index}`),
      }),
    );
    candidate.composition.projection.rows = Array.from(
      { length: count },
      (_, index) => ({
        ...candidate.composition.projection.rows[0]!,
        questionId: `question.email.${index}`,
      }),
    );
    candidate.composition.projection.summary = {
      observableQuestions: count,
      requiredQuestions: count,
      authorizedQuestions: count,
      requiredAuthorizedQuestions: count,
    };
    candidate.payloads = candidate.composition.authority.questionAuthorizations.map(
      (authorization) => ({
        questionId: authorization.questionId,
        payloadRef: `ua5.profile.${authorization.questionId}`,
        answerDigest: authorization.answerDigest,
        value: 'ada@example.invalid',
      }),
    );

    expect(parsePilotUa5ProfilePayloadResponse(candidate).ok).toBe(true);
  });

  it('rejects duplicate refs, unknown keys, getters and Proxies without invoking value accessors', () => {
    const duplicate = success();
    duplicate.payloads.push({ ...duplicate.payloads[0]! });
    expect(parsePilotUa5ProfilePayloadResponse(duplicate).ok).toBe(false);
    expect(parsePilotUa5ProfilePayloadResponse({ ...success(), extra: true }).ok).toBe(false);

    let reads = 0;
    const accessor = success() as Record<string, unknown>;
    Object.defineProperty(accessor, 'payloads', {
      enumerable: true,
      get: () => {
        reads += 1;
        return [];
      },
    });
    expect(parsePilotUa5ProfilePayloadResponse(accessor).ok).toBe(false);
    expect(reads).toBe(0);
    expect(parsePilotUa5ProfilePayloadResponse(new Proxy(success(), {
      ownKeys: () => { throw new Error('proxy trap'); },
    })).ok).toBe(false);
  });

  it('accepts only closed, value-free failure envelopes', () => {
    expect(parsePilotUa5ProfilePayloadResponse({
      ok: false,
      schemaVersion: 1,
      code: 'PILOT_UA5_PROFILE_UNAVAILABLE',
    })).toEqual({
      ok: true,
      value: {
        ok: false,
        schemaVersion: 1,
        code: 'PILOT_UA5_PROFILE_UNAVAILABLE',
      },
    });
    expect(parsePilotUa5ProfilePayloadResponse({
      ok: false,
      schemaVersion: 1,
      code: 'PILOT_UA5_PROFILE_UNAVAILABLE',
      value: 'smuggled',
    }).ok).toBe(false);
  });
});

// P1: the public payload wire must carry a sealed original source, and the
// current-read echo must be exact, immutable and unable to carry answer values.
describe('P1 original-bound wire', () => {
  it('requires the v2 outer envelope and keeps the nested v1 payload', async () => {
    const { parsePilotUa5BoundProfilePayloadResponse } = await import('../src/draft/pilotUa5ProfilePayloads');
    expect(parsePilotUa5BoundProfilePayloadResponse(success()).ok).toBe(false);
    const bound = { ok: true, schemaVersion: 2, payload: success(), originalBindingSeal: 'e30.e30.AA' };
    expect(parsePilotUa5BoundProfilePayloadResponse(bound).ok).toBe(true);
    expect(parsePilotUa5BoundProfilePayloadResponse({ ...bound, originalBindingSeal: '' }).ok).toBe(false);
    expect(parsePilotUa5BoundProfilePayloadResponse({ ...bound, schemaVersion: 1 }).ok).toBe(false);
  });

  it('copies every check coordinate, rejects accessors and rejects value-bearing extras', async () => {
    const { parsePilotUa5ProfileCheck, parsePilotUa5ProfileCurrentnessResponse } = await import('../src/draft/pilotUa5ProfileCurrentness');
    const check = { runRequestId: 'a'.repeat(32), ordinal: 1, binding: { ...binding, pathname: String(binding.pathname) }, profileBinding: success().profileBinding, questionId: 'question.email', answerDigest };
    const parsed = parsePilotUa5ProfileCheck(check);
    expect(parsed).toEqual(check);
    check.binding.pathname = '/changed';
    expect(parsed?.binding.pathname).toBe('/apply');
    for (const invalid of [{ ...check, ordinal: 0 }, { ...check, ordinal: 501 }, { ...check, value: 'private' }, { ...check, answerDigest: '' }, { ...check, questionId: '' }]) {
      expect(parsePilotUa5ProfileCheck(invalid)).toBeNull();
    }
    const getter = vi.fn(() => 1);
    expect(parsePilotUa5ProfileCheck(Object.defineProperty({ ...check }, 'ordinal', { get: getter }))).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    expect(parsePilotUa5ProfileCurrentnessResponse({ ok: true, schemaVersion: 1, kind: 'MATCH_AT_READ', check }).ok).toBe(true);
    expect(parsePilotUa5ProfileCurrentnessResponse({ ok: true, schemaVersion: 1, kind: 'MATCH', check }).ok).toBe(false);
  });
});
