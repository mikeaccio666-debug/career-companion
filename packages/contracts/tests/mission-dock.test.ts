import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AGENT_ENDPOINTS,
  AGENT_ENDPOINT_ERROR_CODES,
  EXECUTION_INTENT_EXECUTABLE_ATS_PROVIDER_CODES,
  SOURCE_PLATFORM_CODES,
  parseEnsureMissionStartApprovalRequestV1,
  parseEnsureMissionStartApprovalResponseV1,
  parseMissionMaterialsV1,
  parseReleaseMissionCoverLetterRequestV1,
  parseReleaseMissionCoverLetterTextV1,
  parseReleaseMissionResumeRequestV1,
  parseRequestMissionCoverLetterRequestV1,
  parseRequestMissionCoverLetterResultV1,
  parseResolveMissionPageBindingRequestV1,
  parseResolveMissionPageBindingResponseV1,
} from '../src/index.ts';
import { parseChannelMessage } from '../src/draft/channel.ts';

/**
 * Dock Mission wiring wire (2026-09-24, argoland §4.15, mirrored here).
 *
 * The fixtures are synthetic and value-free: placeholder ids, fictitious people and
 * companies. Their shapes follow what argoland's
 * `src/database/start-applying-dock-chain.postgres.spec.ts` sends and receives, so a drift
 * between that authority and this copy fails here.
 */
const FIXTURES = join(import.meta.dirname, 'fixtures', 'mission-wiring');
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

const PARSERS: Readonly<Record<string, (value: unknown) => unknown>> = {
  'page-binding-request.json': parseResolveMissionPageBindingRequestV1,
  'page-binding-response.json': parseResolveMissionPageBindingResponseV1,
  'page-binding-none.json': parseResolveMissionPageBindingResponseV1,
  'start-approval-request.json': parseEnsureMissionStartApprovalRequestV1,
  'start-approval-response.json': parseEnsureMissionStartApprovalResponseV1,
  'materials.json': parseMissionMaterialsV1,
  'materials-resume-unavailable.json': parseMissionMaterialsV1,
  'resume-release-request.json': parseReleaseMissionResumeRequestV1,
  'cover-letter-request.json': parseRequestMissionCoverLetterRequestV1,
  'cover-letter-result.json': parseRequestMissionCoverLetterResultV1,
  'cover-letter-failed.json': parseRequestMissionCoverLetterResultV1,
  'cover-letter-release-request.json': parseReleaseMissionCoverLetterRequestV1,
  'cover-letter-text.json': parseReleaseMissionCoverLetterTextV1,
};

describe('dock Mission wire fixtures', () => {
  it('has a parser for every fixture, and every fixture parses to itself', () => {
    const files = readdirSync(FIXTURES).filter((name) => name.endsWith('.json') && !name.startsWith('channel-'));
    expect(files.sort()).toEqual(Object.keys(PARSERS).sort());
    for (const name of files) {
      expect({ name, parsed: PARSERS[name]!(fixture(name)) }).toEqual({ name, parsed: fixture(name) });
    }
  });

  it('reads a future portal hello and a dock-only answer on the channel', () => {
    const hello = parseChannelMessage(fixture('channel-hello-future.json'));
    expect(hello.ok && hello.value.kind === 'channel/hello' && hello.value.requiredCapabilities)
      .toEqual(['DISCOVERY_V1', 'FORM_PLAN_V1', 'GUIDED_AUTOFILL_V1']);
    expect(parseChannelMessage(fixture('channel-ready-dock.json'))).toEqual({
      ok: true,
      value: fixture('channel-ready-dock.json'),
    });
  });

  it('refuses the shapes this repo once invented and the backend never served', () => {
    expect(parseResolveMissionPageBindingResponseV1({ schemaVersion: 1, bound: true })).toBeNull();
    expect('getMissionPageBinding' in AGENT_ENDPOINTS).toBe(false);
    expect('getMissionResumeFile' in AGENT_ENDPOINTS).toBe(false);
  });

  it('registers the seven Mission dock endpoints with argoland paths and statuses', () => {
    expect(AGENT_ENDPOINTS.resolveMissionPageBinding).toMatchObject({
      method: 'POST', path: '/api/v1/agent/missions/page-binding', sourceSection: '4.15', successStatuses: [200],
    });
    expect(AGENT_ENDPOINTS.ensureMissionStartApproval).toMatchObject({
      method: 'POST', path: '/api/v1/agent/missions/:missionId/start-approvals', successStatuses: [201, 200],
    });
    expect(AGENT_ENDPOINTS.getMissionMaterials).toMatchObject({ method: 'GET', path: '/api/v1/agent/missions/:missionId/materials' });
    expect(AGENT_ENDPOINTS.releaseMissionResume).toMatchObject({ method: 'POST', responseKind: 'binary' });
    expect(AGENT_ENDPOINTS.requestMissionCoverLetter).toMatchObject({ method: 'POST', responseKind: 'json' });
    expect(AGENT_ENDPOINTS.releaseMissionCoverLetterText).toMatchObject({ method: 'POST', responseKind: 'json' });
    expect(AGENT_ENDPOINTS.releaseMissionCoverLetterPdf).toMatchObject({ method: 'POST', responseKind: 'binary' });
    expect(AGENT_ENDPOINT_ERROR_CODES.ensureMissionStartApproval).toEqual(
      expect.arrayContaining(['EXECUTION_APPROVAL_REQUIRED', 'EXECUTION_TARGET_MISMATCH', 'EXTENSION_INSTALL_MISMATCH']),
    );
  });

  it('accepts the inventory ATS providers the runtime bundle executes (argoland authority)', () => {
    expect(SOURCE_PLATFORM_CODES).toEqual(expect.arrayContaining(['WORKDAY', 'SMARTRECRUITERS', 'BAMBOOHR']));
    expect(EXECUTION_INTENT_EXECUTABLE_ATS_PROVIDER_CODES).toEqual(
      ['ASHBY', 'BAMBOOHR', 'GREENHOUSE', 'LEVER', 'SMARTRECRUITERS', 'WORKABLE', 'WORKDAY'],
    );
  });
});
