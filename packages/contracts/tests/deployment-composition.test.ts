import { describe, expect, it } from 'vitest';
import { parseDeploymentComposition, parseCompositionAdmission, parseCompositionReleaseReceipt, parseMarketingReleaseRequest, parseMarketingOperation } from '../src/deploymentComposition.ts';
import { parseDeploymentVersion } from '../src/deployment.ts';

const revision = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/edaix@sha256:${digest}`;
const releaseId = `${revision}-default-x64-${digest.slice(0, 12)}`;
const entries = { api: 'units/api/dist/apps/api/src/main.js', chat: 'units/chat/apps/chat/server.js', marketing: 'units/marketing/apps/marketing/server.js' };
const artifact = (service: keyof typeof entries) => ({ format: service === 'marketing' ? 2 : 1,
  image, sourceRevision: revision, releaseId, ciRunId: '21', buildRunId: '22',
  manifestSha256: digest, entry: entries[service], platform: 'linux', architecture: 'x64', nodeVersion: '24.19.0',
  lockfileSha256: digest, publicConfigSha256: digest, schemaSha256: digest });
const composition = () => ({ schemaVersion: 2, kind: 'marketing-composition',
  compositionId: `${revision}-marketing-x64-${digest.slice(0, 12)}`,
  assembly: { sourceRevision: revision, ciRunId: '31', buildRunId: '32', buildRunAttempt: 1 },
  compatibilitySha256: digest, services: { api: artifact('api'), chat: artifact('chat'), marketing: artifact('marketing') } });

describe('private Marketing composition contracts', () => {
  it('preserves actual retained source identity and leaves the public v1 wire unchanged', () => {
    const input = composition();
    input.services.marketing.sourceRevision = 'c'.repeat(40);
    input.services.marketing.releaseId = `${'c'.repeat(40)}-marketing-x64-${digest.slice(0, 12)}`;
    expect(parseDeploymentComposition(input)).toEqual(input);
    expect(parseDeploymentVersion({ schemaVersion: 1, revision, releaseId })).not.toBeNull();
    expect(parseDeploymentVersion({ schemaVersion: 1, revision, releaseId, compositionId: input.compositionId })).toBeNull();
  });

  it('rejects mutable images, forged identity, extra fields and unsupported service splits', () => {
    for (const corrupt of [
      (value: any) => { value.services.api.image = image.split('@')[0] + ':latest'; },
      (value: any) => { value.services.marketing.sourceRevision = 'c'.repeat(40); },
      (value: any) => { value.services.api.format = 2; },
      (value: any) => { value.services.chat.entry = '../api.js'; },
      (value: any) => { value.services.marketing.token = 'synthetic'; },
      (value: any) => { value.services.scraper = value.services.api; },
      (value: any) => { value.services.authWorker = value.services.api; },
      (value: any) => { delete value.services.chat; },
      (value: any) => { value.assembly.buildRunAttempt = 0; },
    ]) {
      const input = composition(); corrupt(input);
      expect(parseDeploymentComposition(input)).toBeNull();
    }
  });

  it('binds each environment separately using closed non-secret fingerprints', () => {
    const input = { schemaVersion: 2, environment: 'production', expectedPrevious: releaseId,
      policySha256: digest, configurationSha256: 'c'.repeat(64), acceptedSchemaSha256: [digest],
      acceptanceReference: 'https://github.com/edaix-official/edaix-job-agents/pull/241' };
    expect(parseCompositionAdmission(input)).toEqual(input);
    expect(parseCompositionAdmission({ ...input, runtimeEnvironment: { DATABASE_URL: 'synthetic' } })).toBeNull();
    expect(parseCompositionAdmission({ ...input, expectedPrevious: '../current' })).toBeNull();
    expect(parseCompositionAdmission({ ...input, environment: 'preview' })).toBeNull();
    expect(parseCompositionAdmission({ ...input, acceptanceReference: 'https://foreign.example/approval' })).toBeNull();
  });

  it('keeps renewed unit provenance and rejects arbitrary data in transport receipts', () => {
    const value = composition();
    const admission = (environment: string) => ({ schemaVersion: 2, environment, expectedPrevious: releaseId,
      policySha256: digest, configurationSha256: digest, acceptedSchemaSha256: [digest],
      acceptanceReference: 'https://github.com/edaix-official/edaix-job-agents/pull/241' });
    const admissions = { staging: admission('staging'), production: admission('production') };
    const sourceEvidence = { runId: '22', artifact: 'staging-deployment' };
    const request = { schemaVersion: 2, kind: 'marketing-validate', base: artifact('api'), marketing: artifact('marketing'),
      services: ['api', 'chat', 'marketing'], sourceEvidence, admissions };
    expect(parseMarketingReleaseRequest(request)?.marketing?.buildRunId).toBe('22');
    expect(parseMarketingReleaseRequest({ ...request, sourceEvidence: { ...sourceEvidence, artifact: 'published-release' } })).toBeNull();
    const receipt = { schemaVersion: 2, kind: 'marketing-composition', image, sourceRevision: revision,
      releaseId: value.compositionId, ciRunId: '31', buildRunId: '32', composition: value, sourceEvidence, admissions };
    expect(parseCompositionReleaseReceipt(receipt)?.composition.services.marketing.buildRunId).toBe('22');
    expect(parseCompositionReleaseReceipt({ ...receipt, ciRunId: '99' })).toBeNull();
    expect(parseCompositionReleaseReceipt({ ...receipt, token: 'synthetic' })).toBeNull();
  });
  it('binds the effective retained snapshot to the boot that verified it', () => {
    const retained = { api: { containerId: 'a'.repeat(64), imageId: `sha256:${digest}`,
      startedAt: '2026-09-07T00:00:00Z', running: true } };
    const operation = { schemaVersion: 2, operationId: '12345678-1234-1234-1234-123456789abc', mode: 'marketing',
      candidate: 'candidate', previous: 'previous', expectedPrevious: 'previous', startedAt: '2026-09-07T00:00:00Z',
      status: 'recovery_required', phase: 'recovery_required', retained, recoveredRetained: retained,
      retainedBootId: '12345678-1234-1234-1234-123456789abc' };
    expect(parseMarketingOperation(operation)).toEqual(operation);
    const { retainedBootId, ...unbound } = operation;
    expect(parseMarketingOperation(unbound)).toBeNull();
    expect(parseMarketingOperation({ ...operation, retainedBootId: 'unknown' })).toBeNull();
  });

  it('accepts a stable reason that carries digits and still rejects malformed reasons', () => {
    const operation = { schemaVersion: 2, operationId: '12345678-1234-1234-1234-123456789abc', mode: 'marketing',
      candidate: 'candidate', previous: 'previous', expectedPrevious: 'previous', startedAt: '2026-09-07T00:00:00Z',
      status: 'rejected', phase: 'rejected', reason: 'DEPLOY_HOST_TOOLS_LINUX_X64_NODE24_REQUIRED' };
    expect(parseMarketingOperation(operation)).toEqual(operation);
    for (const reason of ['deploy_lower_case', 'DEPLOY_', `DEPLOY_${'A'.repeat(81)}`, 'DEPLOY_WITH-DASH', 'OTHER_PREFIX']) {
      expect(parseMarketingOperation({ ...operation, reason })).toBeNull();
    }
  });

});
