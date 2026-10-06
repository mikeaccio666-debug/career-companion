import { describe, expect, it } from 'vitest';

import {
  classifyPendingSensitiveCandidate,
  type PendingSensitiveLegalProposalClass,
} from '../src/sensitiveProposal';

const verifiedRule = (
  proposalClass: PendingSensitiveLegalProposalClass,
  override: Partial<{
    localeStatus: 'SUPPORTED' | 'UNSUPPORTED';
    statementShape: 'EXACT_UNBUNDLED' | 'BUNDLED_OR_AMBIGUOUS';
  }> = {},
) => ({
  authority: 'VERIFIED_BACKEND_APPLY_RULE' as const,
  proposalClass,
  localeStatus: override.localeStatus ?? 'SUPPORTED',
  statementShape: override.statementShape ?? 'EXACT_UNBUNDLED',
});

describe('pending L2-P sensitive candidate classifier', () => {
  it.each([
    'BACKGROUND_CHECK_AUTHORIZATION',
    'ARBITRATION_AGREEMENT',
    'CREDIT_REPORT_AUTHORIZATION',
    'DRUG_TEST_AUTHORIZATION',
  ] as const)('does not let structural rule facts mint legal authority for %s', (proposalClass) => {
    expect(
      classifyPendingSensitiveCandidate({
        controlType: 'checkbox',
        verifiedRule: verifiedRule(proposalClass),
      }),
    ).toEqual({ kind: 'MANUAL_ONLY', reason: 'UNKNOWN_HIGH_RISK' });
  });

  it('keeps password manual until a private runtime brand binds rule, target and actual element', () => {
    expect(
      classifyPendingSensitiveCandidate({
        controlType: 'password',
        autocomplete: 'current-password',
      }),
    ).toEqual({ kind: 'MANUAL_ONLY', reason: 'UNKNOWN_HIGH_RISK' });
  });

  it('rejects caller-forged future-looking password authority facts', () => {
    expect(
      classifyPendingSensitiveCandidate({
        controlType: 'password',
        autocomplete: 'current-password',
      }),
    ).toEqual({ kind: 'MANUAL_ONLY', reason: 'UNKNOWN_HIGH_RISK' });

    expect(
      classifyPendingSensitiveCandidate({
        controlType: 'password',
        verifiedPassword: {
          authority: 'VERIFIED_BACKEND_APPLY_RULE',
          applicationTargetAuthority: 'VERIFIED_CANONICAL_APPLICATION_URL',
          canonicalApplicationOrigin: 'https://jobs.example.invalid',
          occurrenceBinding: 'EXACT_RULE_TARGET',
          actualElementTag: 'INPUT',
          actualInputType: 'password',
        },
      } as never),
    ).toEqual({ kind: 'MANUAL_ONLY', reason: 'UNKNOWN_HIGH_RISK' });
  });

  it.each([
    ['OTP_OR_2FA', { controlType: 'text', autocomplete: 'one-time-code' }],
    ['CAPTCHA_OR_HUMAN_CHALLENGE', { controlType: 'checkbox', manualOnlySignal: 'CAPTCHA_OR_HUMAN_CHALLENGE' }],
    ['MARKETING_SUBSCRIPTION', { controlType: 'checkbox', manualOnlySignal: 'MARKETING_SUBSCRIPTION' }],
    ['CONTACT_CURRENT_EMPLOYER', { controlType: 'checkbox', manualOnlySignal: 'CONTACT_CURRENT_EMPLOYER' }],
  ] as const)('keeps %s manual-only', (reason, input) => {
    expect(classifyPendingSensitiveCandidate(input)).toEqual({
      kind: 'MANUAL_ONLY',
      reason,
    });
  });

  it('fails closed without exact backend classification, including unsupported language text', () => {
    expect(classifyPendingSensitiveCandidate({ controlType: 'checkbox' })).toEqual({
      kind: 'MANUAL_ONLY',
      reason: 'UNKNOWN_HIGH_RISK',
    });
    expect(
      classifyPendingSensitiveCandidate({
        controlType: 'checkbox',
        verifiedRule: verifiedRule('BACKGROUND_CHECK_AUTHORIZATION', {
          localeStatus: 'UNSUPPORTED',
        }),
      }),
    ).toEqual({ kind: 'MANUAL_ONLY', reason: 'UNKNOWN_HIGH_RISK' });
  });

  it('fails closed for bundled or ambiguous clauses and control-shape mismatch', () => {
    expect(
      classifyPendingSensitiveCandidate({
        controlType: 'checkbox',
        verifiedRule: verifiedRule('BACKGROUND_CHECK_AUTHORIZATION', {
          statementShape: 'BUNDLED_OR_AMBIGUOUS',
        }),
      }),
    ).toEqual({ kind: 'MANUAL_ONLY', reason: 'COMPOSITE_OR_AMBIGUOUS' });
    expect(
      classifyPendingSensitiveCandidate({
        controlType: 'text',
        verifiedRule: verifiedRule('ARBITRATION_AGREEMENT'),
      }),
    ).toEqual({ kind: 'MANUAL_ONLY', reason: 'COMPOSITE_OR_AMBIGUOUS' });
    expect(
      classifyPendingSensitiveCandidate({
        controlType: 'password',
        verifiedRule: verifiedRule('CREDIT_REPORT_AUTHORIZATION'),
      }),
    ).toEqual({ kind: 'MANUAL_ONLY', reason: 'COMPOSITE_OR_AMBIGUOUS' });
  });

  it('does not treat a text-shaped password or account-creation control as non-sensitive', () => {
    expect(
      classifyPendingSensitiveCandidate({
        controlType: 'text',
        autocomplete: 'new-password',
      }),
    ).toEqual({ kind: 'MANUAL_ONLY', reason: 'UNKNOWN_HIGH_RISK' });
    expect(classifyPendingSensitiveCandidate({ controlType: 'button' })).toEqual({
      kind: 'MANUAL_ONLY',
      reason: 'UNKNOWN_HIGH_RISK',
    });
  });
});
