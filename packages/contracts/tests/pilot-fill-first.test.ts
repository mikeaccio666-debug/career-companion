import { describe, expect, it } from 'vitest';
import {
  PILOT_UA4_LEDGER_SCHEMA_VERSION,
  parsePilotUa4TerminalLedger,
  parsePilotUa4WriteAuthorityResponse,
} from '../src/draft/pilotUa4WriteAuthority';

const binding = {
  origin: 'https://job-boards.greenhouse.io',
  pathname: '/fixture/jobs/1',
  domGeneration: 'a'.repeat(64),
};

function ledger(disposition: unknown) {
  return {
    schemaVersion: PILOT_UA4_LEDGER_SCHEMA_VERSION,
    binding,
    discoveryComplete: true,
    questions: [{ questionId: 'q-one', required: true }],
    dispositions: [{ questionId: 'q-one', disposition }],
    unobservedRegions: [],
    summary: {
      observableQuestions: 1, requiredQuestions: 1, terminalQuestions: 1,
      terminalRequiredQuestions: 1, requiredFieldFinalDispositionCoverage: 100,
      unobservedRegions: 0,
    },
  };
}

describe('fill-first recovery contract', () => {
  it('accepts an explicit frozen-Undo authority without weakening its other gates', () => {
    const response = {
      ok: true, schemaVersion: 1,
      authority: {
        authorityId: 'b'.repeat(64), binding, pageIdentityDigest: 'c'.repeat(64),
        observedControlIdentityDigests: [], expiresAtMs: 10_000,
        questionAuthorizations: [], blockedQuestions: [],
        constraints: {
          exactTargetBinding: 'REQUIRED', semanticReadback: 'REQUIRED', hostValidation: 'REQUIRED',
          lateRecheck: 'REQUIRED', undo: 'FROZEN', submit: 'FORBIDDEN',
          activationState: 'DEFAULT_OFF', releaseState: 'NOT_RELEASED',
        },
      },
    };
    expect(parsePilotUa4WriteAuthorityResponse(response).ok).toBe(true);
    response.authority.constraints.submit = 'ALLOWED';
    expect(parsePilotUa4WriteAuthorityResponse(response).ok).toBe(false);
  });

  it('records verified filling without inventing owned Undo', () => {
    const disposition = {
      state: 'FILLED', semanticReadback: 'HOST_ACCEPTED', lateRecheck: 'STABLE', undo: 'FROZEN',
    };
    expect(parsePilotUa4TerminalLedger(ledger(disposition))).toMatchObject({
      ok: true, value: { dispositions: [{ disposition }] },
    });
    expect(parsePilotUa4TerminalLedger(ledger({ ...disposition, undo: 'UNKNOWN' })).ok).toBe(false);
  });

  it('preserves possible partial writes on failures instead of claiming FILLED', () => {
    const disposition = {
      state: 'POLICY_BLOCKED', reason: 'HOST_REJECTED', writeEffect: 'MAY_HAVE_CHANGED',
    };
    expect(parsePilotUa4TerminalLedger(ledger(disposition))).toMatchObject({
      ok: true, value: { dispositions: [{ disposition }] },
    });
    expect(parsePilotUa4TerminalLedger(ledger({
      state: 'PREFILLED', semanticReadback: 'CURRENT', writeEffect: 'MAY_HAVE_CHANGED',
    })).ok).toBe(false);
  });
});

describe('fill-first projection', () => {
  it('carries possible page changes only on failed rows', async () => {
    const { parsePilotUa5RunProjection } = await import('../src/draft/pilotUa5Certification');
    const projection = {
      schemaVersion: 2, binding, discoveryComplete: true,
      rows: [{ questionId: 'q-one', required: true, state: 'POLICY_BLOCKED', reason: 'HOST_REJECTED', writeEffect: 'MAY_HAVE_CHANGED' }],
      unobservedRegions: [],
      summary: { observableQuestions: 1, requiredQuestions: 1, requiredCompleted: 0, terminalQuestions: 1, unobservedRegions: 0 },
    };
    expect(parsePilotUa5RunProjection(projection)).toMatchObject({ ok: true, value: projection });
    expect(parsePilotUa5RunProjection({ ...projection, rows: [{ ...projection.rows[0], state: 'MANUAL_REQUIRED' }] }).ok).toBe(false);
    expect(parsePilotUa5RunProjection({ ...projection, rows: [{ ...projection.rows[0], writeEffect: 'NONE' }] }).ok).toBe(false);
  });
});
