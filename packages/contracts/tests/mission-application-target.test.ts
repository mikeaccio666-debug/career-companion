import { describe, expect, it } from 'vitest';

import {
  AGENT_ENDPOINTS,
  AGENT_ENDPOINT_ERROR_CODES,
  parseGetMissionApplicationTargetResponse,
} from '../src/index.ts';

const RESPONSE = Object.freeze({
  schemaVersion: 1,
  target: Object.freeze({
    missionRevision: '8',
    canonicalOrigin: 'https://boards.example.invalid',
    pathname: '/source-job/application',
    atsProvider: 'GREENHOUSE',
    pathRuleId: 'greenhouse-v3',
    verifierVersion: 'greenhouse-direct-v2',
    verifiedAt: '2026-08-24T15:59:00.000Z',
    freshUntil: '2026-08-24T16:09:00.000Z',
    policyVersion: 'application-target-v1',
    revision: '7',
  }),
});

describe('Mission application-target contract', () => {
  it('registers one owner-scoped read endpoint with the closed failure set', () => {
    expect(AGENT_ENDPOINTS.getMissionApplicationTarget).toMatchObject({
      method: 'GET',
      path: '/api/v1/agent/missions/:missionId/application-target',
      sourceSection: '4.2',
      auth: 'bearer',
    });
    expect(AGENT_ENDPOINT_ERROR_CODES.getMissionApplicationTarget).toEqual([
      'VALIDATION_FAILED',
      'LOGIN_REQUIRED',
      'ACCOUNT_UNAVAILABLE',
      'RATE_LIMITED',
      'AGENT_UNAVAILABLE',
      'INTERNAL_ERROR',
      'MISSION_NOT_FOUND',
      'JOB_UNAVAILABLE',
      'JOB_EXPIRED',
      'JOB_IDENTITY_AMBIGUOUS',
    ]);
  });

  it('strictly decodes the value-free verified target projection', () => {
    expect(parseGetMissionApplicationTargetResponse(RESPONSE)).toEqual(RESPONSE);

    for (const rejected of [
      { ...RESPONSE, target: { ...RESPONSE.target, pathname: '//evil.invalid/apply' } },
      { ...RESPONSE, target: { ...RESPONSE.target, pathname: '/apply?token=secret' } },
      { ...RESPONSE, target: { ...RESPONSE.target, canonicalOrigin: 'http://boards.example.invalid' } },
      { ...RESPONSE, target: { ...RESPONSE.target, freshUntil: RESPONSE.target.verifiedAt } },
      { ...RESPONSE, target: { ...RESPONSE.target, missionRevision: '0' } },
      { ...RESPONSE, target: { ...RESPONSE.target, vendor: 'greenhouse' } },
      { ...RESPONSE, token: 'forbidden' },
    ]) {
      expect(parseGetMissionApplicationTargetResponse(rejected)).toBeNull();
    }
  });
});
