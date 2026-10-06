import { describe, expect, it } from 'vitest';
import {
  AGENT_ENDPOINTS,
  AGENT_ENDPOINT_ERROR_CODES,
  APPLICATION_LEDGER_DATE_STATES,
  APPLICATION_LEDGER_STATUSES,
  PROVIDER_CONFIRMATION_ENDPOINT,
  PROVIDER_CONFIRMATION_ERROR_CODES,
  parseIanaTimeZone,
} from '../src/index.ts';

describe('T11 Application Ledger contracts', () => {
  it('accepts only canonical IANA timezone authority', () => {
    expect(parseIanaTimeZone('America/Los_Angeles')).toBe('America/Los_Angeles');
    expect(parseIanaTimeZone('Etc/UTC')).toBe('Etc/UTC');
    expect(parseIanaTimeZone('UTC')).toBeNull();
    expect(parseIanaTimeZone('US/Pacific')).toBeNull();
    expect(parseIanaTimeZone(' America/Los_Angeles')).toBeNull();
    expect(parseIanaTimeZone('not/a-zone')).toBeNull();
    expect(parseIanaTimeZone(undefined)).toBeNull();
  });

  it('freezes the closed ledger state sets', () => {
    expect(APPLICATION_LEDGER_STATUSES).toEqual([
      'VERIFIED',
      'SUBMITTED_UNVERIFIED',
      'OUTCOME_UNKNOWN',
      'PARTIAL',
      'FAILED',
      'BLOCKED',
    ]);
    expect(APPLICATION_LEDGER_DATE_STATES).toEqual([
      'KNOWN',
      'UNKNOWN_MISSING_SUBMITTED_AT',
      'UNKNOWN_MISSING_TIME_ZONE',
      'UNKNOWN_CONFLICT',
      'UNKNOWN_EVIDENCE',
    ]);
  });

  it('registers owner ledger and timezone endpoints with common stable failures', () => {
    expect(AGENT_ENDPOINTS.listApplicationLedger).toMatchObject({
      method: 'GET',
      path: '/api/v1/agent/application-ledger',
      auth: 'bearer',
    });
    expect(AGENT_ENDPOINTS.updatePrimaryTimeZone).toMatchObject({
      method: 'PATCH',
      path: '/api/v1/agent/account-preferences/primary-time-zone',
      auth: 'bearer',
    });
    expect(AGENT_ENDPOINT_ERROR_CODES.listApplicationLedger).toContain('LOGIN_REQUIRED');
    expect(AGENT_ENDPOINT_ERROR_CODES.updatePrimaryTimeZone).toContain('VALIDATION_FAILED');
  });

  it('keeps trusted provider ingress outside owner bearer endpoints', () => {
    expect(PROVIDER_CONFIRMATION_ENDPOINT).toEqual({
      method: 'POST',
      path: '/api/internal/v1/provider-confirmations',
      auth: 'hmac-sha256-v1',
      successStatuses: [200, 201],
    });
    expect(PROVIDER_CONFIRMATION_ERROR_CODES).toContain('PROVIDER_ATTESTATION_INVALID');
    expect(PROVIDER_CONFIRMATION_ERROR_CODES).toContain('PROVIDER_CONFIRMATION_CONFLICT');
  });
});
