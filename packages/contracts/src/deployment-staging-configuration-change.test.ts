import { describe, expect, it } from 'vitest';
import { parseStagingConfigurationChange } from './deployment-staging-configuration-change.ts';

const digest = (n: string) => n.repeat(64).slice(0, 64);
const reference = (configurationId: string) => ({
  releaseId: `${'a'.repeat(40)}-default-x64-${'b'.repeat(12)}`,
  revision: 'a'.repeat(40),
  image: `123456789012.dkr.ecr.us-east-1.amazonaws.com/edaix-product@sha256:${digest('6')}`,
  ciRunId: '123',
  configurationId,
  policySha256: configurationId,
  manifestSha256: digest('7'),
  configurationSha256: configurationId === digest('d') ? digest('1') : digest('2'),
});

/** Turning on the email worker: auth.env gains two keys and the service list grows. */
function change(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    mode: 'normal-staging-configuration-change',
    grantId: '40000000-0000-4000-8000-000000000001',
    hostSha256: digest('e'),
    previous: reference(digest('d')),
    candidate: reference(digest('c')),
    changes: ['environment', 'services'],
    environment: [{ service: 'auth', previousSha256: digest('3'), candidateSha256: digest('4') }],
    previousComposeSha256: digest('5'),
    candidateComposeSha256: digest('5'),
    previousProxySha256: digest('8'),
    candidateProxySha256: digest('8'),
    previousPublicConfigSha256: digest('b'),
    candidatePublicConfigSha256: digest('b'),
    previousServices: ['api', 'auth', 'chat', 'marketing'],
    candidateServices: ['api', 'auth', 'auth-worker', 'chat', 'marketing'],
    previousAcceptedSchemaSha256: [digest('9')],
    candidateAcceptedSchemaSha256: [digest('9')],
    previousDatabaseMetadata: { api: digest('a'), auth: digest('b') },
    candidateDatabaseMetadata: { api: digest('a'), auth: digest('b') },
    approvalRef: 'https://github.com/edaix-official/edaix-job-agents/pull/329',
    ...overrides,
  };
}

describe('staging configuration change', () => {
  it('keeps the release and moves the configuration', () => {
    const parsed = parseStagingConfigurationChange(change());
    expect(parsed).not.toBeNull();
    expect(parsed!.previous.releaseId).toBe(parsed!.candidate.releaseId);
    expect(parsed!.previous.configurationId).not.toBe(parsed!.candidate.configurationId);
    expect([...parsed!.changes]).toEqual(['environment', 'services']);
  });

  it('lets an added service move the digest with no entry to pin', () => {
    const parsed = parseStagingConfigurationChange(change({
      changes: ['environment', 'services'],
      environment: [],
    }));
    expect(parsed).not.toBeNull();
    expect([...parsed!.environment]).toEqual([]);
    expect(parsed!.candidateServices).toContain('auth-worker');
  });

  it('re-pins the public build identity on its own, which is what a corrected build config needs', () => {
    const parsed = parseStagingConfigurationChange(change({
      changes: ['public-config'],
      environment: [],
      candidatePublicConfigSha256: digest('f'),
      previousServices: ['api', 'auth', 'chat', 'marketing'],
      candidateServices: ['api', 'auth', 'chat', 'marketing'],
    }));
    expect(parsed).not.toBeNull();
    expect(parsed!.previousPublicConfigSha256).toBe(digest('b'));
    expect(parsed!.candidatePublicConfigSha256).toBe(digest('f'));
    // Release identity moves; the release it identifies does not.
    expect(parsed!.previous.releaseId).toBe(parsed!.candidate.releaseId);
    expect(parsed!.previous.image).toBe(parsed!.candidate.image);
  });

  it('extends the accepted schema on its own, which is what unblocks the single-admin launch proof', () => {
    const parsed = parseStagingConfigurationChange(change({
      changes: ['accepted-schema'],
      environment: [],
      candidateAcceptedSchemaSha256: [digest('9'), digest('a')],
      previousServices: ['api', 'auth', 'chat', 'marketing'],
      candidateServices: ['api', 'auth', 'chat', 'marketing'],
    }));
    expect(parsed).not.toBeNull();
    expect([...parsed!.candidateAcceptedSchemaSha256]).toEqual([digest('9'), digest('a')]);
  });
});

describe('staging configuration change rejections', () => {
  const rejected: readonly [string, Record<string, unknown>][] = [
    ['no change is declared', { changes: [], environment: [] }],
    ['environment is declared with no entries and no service move', {
      changes: ['environment'],
      environment: [],
      previousServices: ['api', 'auth', 'chat', 'marketing'],
      candidateServices: ['api', 'auth', 'chat', 'marketing'],
    }],
    ['a declared kind does not actually differ', { changes: ['environment', 'services', 'proxy'] }],
    ['an undeclared kind differs', { changes: ['environment'] }],
    ['an environment entry does not move', {
      changes: ['services'],
      environment: [{ service: 'auth', previousSha256: digest('3'), candidateSha256: digest('3') }],
    }],
    ['the same service is listed twice', {
      environment: [
        { service: 'auth', previousSha256: digest('3'), candidateSha256: digest('4') },
        { service: 'auth', previousSha256: digest('3'), candidateSha256: digest('4') },
      ],
    }],
    ['an unknown service is listed', {
      environment: [{ service: 'scraper', previousSha256: digest('3'), candidateSha256: digest('4') }],
    }],
    ['public-config is declared but the two public digests are the same', {
      changes: ['public-config'],
      environment: [],
      previousServices: ['api', 'auth', 'chat', 'marketing'],
      candidateServices: ['api', 'auth', 'chat', 'marketing'],
    }],
    ['the public build identity moves without declaring public-config', {
      candidatePublicConfigSha256: digest('f'),
    }],
    ['a public build digest is not a digest', {
      changes: ['public-config'],
      environment: [],
      candidatePublicConfigSha256: 'not-a-digest',
      previousServices: ['api', 'auth', 'chat', 'marketing'],
      candidateServices: ['api', 'auth', 'chat', 'marketing'],
    }],
    ['the configuration does not move', { candidate: reference(digest('d')) }],
    ['the release moves as well', {
      candidate: { ...reference(digest('c')), releaseId: `${'f'.repeat(40)}-default-x64-${'b'.repeat(12)}` },
    }],
    ['the image moves as well', {
      candidate: { ...reference(digest('c')), image: `123456789012.dkr.ecr.us-east-1.amazonaws.com/edaix-product@sha256:${digest('7')}` },
    }],
    ['the approval reference is not this repository', { approvalRef: 'https://example.com/pull/1' }],
    ['an unknown field is present', { extra: true }],
    ['the service list is empty', { changes: ['environment'], candidateServices: [] }],
    ['observed database metadata moves without the kind', {
      candidateDatabaseMetadata: { api: digest('c'), auth: digest('b') },
    }],
    ['the database-metadata kind is declared but no metadata moves', {
      changes: ['environment', 'services', 'database-metadata'],
    }],
    ['the two sides name different databases', {
      changes: ['environment', 'services', 'database-metadata'],
      candidateDatabaseMetadata: { api: digest('c') },
    }],
    ['a database metadata pin is not a digest', {
      candidateDatabaseMetadata: { api: 'not-a-digest', auth: digest('b') },
    }],
    ['the metadata pins name a service that has no database', {
      previousDatabaseMetadata: { api: digest('a'), auth: digest('b'), chat: digest('c') },
      candidateDatabaseMetadata: { api: digest('a'), auth: digest('b'), chat: digest('c') },
    }],
  ];

  for (const [name, overrides] of rejected) {
    it(`admits nothing when ${name}`, () => {
      expect(parseStagingConfigurationChange(change(overrides))).toBeNull();
    });
  }

  const workerDatabase = { metadataSha256: digest('1'), roleSha256: digest('2'), targetSha256: digest('3') };

  it('pins the database a newly added service brings with it', () => {
    const parsed = parseStagingConfigurationChange(change({
      addedDatabases: { 'auth-worker': workerDatabase },
    }));
    expect(parsed).not.toBeNull();
    expect(parsed!.addedDatabases!['auth-worker']).toEqual(workerDatabase);
    // The metadata pins still speak only for the databases that were already there.
    expect(Object.keys(parsed!.candidateDatabaseMetadata).sort()).toEqual(['api', 'auth']);
  });

  const workerRejections: readonly [string, Record<string, unknown>][] = [
    ['the pins name a service the change does not add', { addedDatabases: { auth: workerDatabase } }],
    ['the pins name a service with no database at all', { addedDatabases: { chat: workerDatabase } }],
    ['the pins are empty', { addedDatabases: {} }],
    ['a pinned entry is missing a digest', { addedDatabases: { 'auth-worker': { metadataSha256: digest('1'), roleSha256: digest('2') } } }],
    ['a pinned entry carries a field the policy never takes from a record', {
      addedDatabases: { 'auth-worker': { ...workerDatabase, metadataVersion: 2 } },
    }],
    ['a pinned digest is not a digest', { addedDatabases: { 'auth-worker': { ...workerDatabase, roleSha256: 'not-a-digest' } } }],
    ['the pins arrive on a change that moves no service', {
      changes: ['environment'],
      previousServices: ['api', 'auth', 'chat', 'marketing'],
      candidateServices: ['api', 'auth', 'chat', 'marketing'],
      addedDatabases: { 'auth-worker': workerDatabase },
    }],
  ];
  for (const [name, overrides] of workerRejections) {
    it(`admits no added database when ${name}`, () => {
      expect(parseStagingConfigurationChange(change(overrides))).toBeNull();
    });
  }

  it('re-pins observed database metadata when the kind says so', () => {
    const parsed = parseStagingConfigurationChange(change({
      changes: ['environment', 'services', 'database-metadata'],
      candidateDatabaseMetadata: { api: digest('c'), auth: digest('b') },
    }));
    expect(parsed).not.toBeNull();
    expect(parsed!.candidateDatabaseMetadata.api).toBe(digest('c'));
    expect(parsed!.previousDatabaseMetadata.api).toBe(digest('a'));
  });
  /**
   * The one pairing that has to move together.
   *
   * `publicConfigSha256` is a digest of the build that produced a release, so the
   * only artifact carrying a given value is the release built with it. Holding the
   * release still while re-pinning the policy asks the deploy to admit the candidate
   * configuration against the previous build's manifest, and `verifyRelease`
   * compares exactly those two -- so before this the kind could only ever pass when
   * the running release already carried the target digest, the one case needing no
   * re-pin at all.
   */
  it('lets a declared public-config carry the release that actually has the digest', () => {
    const parsed = parseStagingConfigurationChange(change({
      changes: ['public-config'],
      environment: [],
      candidate: {
        ...reference(digest('c')),
        releaseId: `${'f'.repeat(40)}-default-x64-${'b'.repeat(12)}`,
        revision: 'f'.repeat(40),
        image: `123456789012.dkr.ecr.us-east-1.amazonaws.com/edaix-product@sha256:${digest('9')}`,
      },
      candidatePublicConfigSha256: digest('f'),
      previousServices: ['api', 'auth', 'chat', 'marketing'],
      candidateServices: ['api', 'auth', 'chat', 'marketing'],
    }));
    expect(parsed).not.toBeNull();
    expect(parsed!.candidate.releaseId).not.toBe(parsed!.previous.releaseId);
    expect(parsed!.candidatePublicConfigSha256).toBe(digest('f'));
  });

  /** Every other kind keeps the release immovable; only public-config is excepted. */
  it('still refuses a moved release when public-config is not declared', () => {
    expect(parseStagingConfigurationChange(change({
      candidate: { ...reference(digest('c')), releaseId: `${'f'.repeat(40)}-default-x64-${'b'.repeat(12)}` },
    }))).toBeNull();
  });
});
