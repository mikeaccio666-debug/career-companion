/** Synthetic Profile fixture for the real connected pipeline. NON_ACCEPTANCE. */
import type { PilotUa5ProfilePayloadResponse } from '../../packages/contracts/src/draft/pilotUa5ProfilePayloads';
import { derivePilotUa5Questions } from '../../packages/apply-kernel/src/pilotUa5Composition';
import type { createPilotUa5ConnectedLiveRun } from '../../apps/extension/connected-dev/liveRun';
import { pilotUa5SemanticDigest } from '../../apps/extension/lib/pilotUa5SemanticDigest';
const ANSWER_DIGEST = 'a'.repeat(64), VALUE = 'synthetic@example.test';

export function syntheticWizardProfileResponse(
  request: Parameters<Parameters<ReturnType<typeof createPilotUa5ConnectedLiveRun>>[2]['resolveProfilePayloads']>[0],
  now: number,
): PilotUa5ProfilePayloadResponse {
  const control = request.discovery.controls[0]!;
  const isGivenName = control.autocomplete.includes('given-name');
  const classification = Object.freeze({
    identityDigest: control.identityDigest,
    kind: 'CANONICAL_FIELD' as const,
    canonicalField: isGivenName ? 'NAME_GIVEN' as const : 'EMAIL' as const,
    confidence: 'HIGH' as const,
    provenance: Object.freeze({
      source: 'AUTOCOMPLETE' as const,
      semanticDigest: 'b'.repeat(64),
    }),
    reasonCode: 'CANONICAL_AUTOCOMPLETE_MATCH' as const,
  });
  const epochs = [Object.freeze({
    cause: 'USER_TRIGGER' as const,
    binding: request.discovery.binding,
    controls: request.discovery.controls,
    structure: request.structure!,
    suppressedControls: request.discovery.observation.suppressedControls,
    hiddenNotObservedCount: request.discovery.observation.hiddenNotObservedCount,
    attributedAddRowGroup: null,
  })];
  const derived = derivePilotUa5Questions(epochs, [classification], pilotUa5SemanticDigest);
  if (!derived.ok) throw new Error(`fixture compilation failed: ${derived.reason}`);
  const question = derived.questions[0]!;
  const pageIdentityDigest = 'c'.repeat(64);
  return Object.freeze({
    ok: true,
    schemaVersion: 1,
    composition: Object.freeze({
      ok: true,
      schemaVersion: 1,
      candidateRule: Object.freeze({
        schemaVersion: 1,
        kind: 'EPHEMERAL_PAGE_CANDIDATE',
        binding: request.discovery.binding,
        pageIdentityDigest,
        issuedAtMs: now,
        expiresAtMs: now + 30_000,
        classifications: Object.freeze([classification]),
        constraints: Object.freeze({
          remoteCode: 'FORBIDDEN',
          automaticPublication: 'FORBIDDEN',
          writerAuthority: 'NOT_GRANTED',
          submit: 'HUMAN_ONLY',
          activationState: 'DEFAULT_OFF',
          releaseState: 'NOT_RELEASED',
        }),
      }),
      authority: Object.freeze({
        authorityId: 'd'.repeat(64),
        binding: request.discovery.binding,
        pageIdentityDigest,
        observedControlIdentityDigests: Object.freeze(request.discovery.controls.map((entry) => entry.identityDigest)),
        expiresAtMs: now + 30_000,
        questionAuthorizations: Object.freeze([Object.freeze({
          questionId: question.questionId,
          controlKind: 'TEXT' as const,
          identityDigests: Object.freeze([control.identityDigest]),
          required: true,
          answerAuthority: 'PROFILE_CONFIRMED' as const,
          answerDigest: ANSWER_DIGEST,
        })]),
        blockedQuestions: Object.freeze([]),
        constraints: Object.freeze({
          exactTargetBinding: 'REQUIRED',
          semanticReadback: 'REQUIRED',
          hostValidation: 'REQUIRED',
          lateRecheck: 'REQUIRED',
          undo: 'FROZEN',
          submit: 'FORBIDDEN',
          activationState: 'DEFAULT_OFF',
          releaseState: 'NOT_RELEASED',
        }),
      }),
      projection: Object.freeze({
        schemaVersion: 1,
        binding: request.discovery.binding,
        rows: Object.freeze([Object.freeze({
          questionId: question.questionId,
          required: true,
          writerKind: 'TEXT',
          memberCount: 1,
          admission: 'AUTHORIZED' as const,
        })]),
        summary: Object.freeze({
          observableQuestions: 1,
          requiredQuestions: 1,
          authorizedQuestions: 1,
          requiredAuthorizedQuestions: 1,
        }),
      }),
      constraints: Object.freeze({
        submit: 'FORBIDDEN',
        remoteCode: 'FORBIDDEN',
        rawValues: 'NEVER_TRANSMITTED',
        activationState: 'DEFAULT_OFF',
        releaseState: 'NOT_RELEASED',
      }),
    }),
    profileBinding: Object.freeze({
      fieldSchemaVersion: 1,
      fieldKeys: Object.freeze(isGivenName ? ['firstName'] as const : ['email'] as const),
      revision: '1' as never,
      deletionEpoch: '0' as never,
      snapshotDigest: `sha256:${'e'.repeat(64)}` as never,
    }),
    payloads: Object.freeze([Object.freeze({
      questionId: question.questionId,
      payloadRef: 'ua5.profile.email',
      answerDigest: ANSWER_DIGEST,
      value: isGivenName ? 'Ada' : VALUE,
    })]),
    constraints: Object.freeze({
      compositionValueBoundary: 'VALUE_FREE_SUBOBJECT_ONLY',
      payloadWire: 'DEV_ONLY_DATA_L1',
      dataLifetime: 'EPHEMERAL_MEMORY_ONLY',
      panelExposure: 'FORBIDDEN',
      persistence: 'FORBIDDEN',
      logging: 'FORBIDDEN',
    }),
  });
}
