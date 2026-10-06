import { describe, expect, it } from 'vitest';
import {
  STAGING_MIGRATION_ACTIONS,
  parseStagingMigrationAttempt,
  parseStagingMigrationEvidence,
} from '../src/deployment-staging-migrations.ts';

const digest = (seed: string) => seed.repeat(64).slice(0, 64);
const operationId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const database = { schemaVersion: 1, metadataSha256: digest('1'), roleSha256: digest('2'), targetSha256: digest('3') };
const databases = { api: database, auth: { ...database, roleSha256: digest('4') } };
const baseline = [{ id: '0001_clean_baseline', sha256: digest('a') }, { id: '0002_seed', sha256: digest('b') }];
const observedRows = [{ id: '0003_applied_out_of_band', sha256: digest('c') }];

const attempt = {
  schemaVersion: 1,
  environment: 'staging',
  operationId,
  releaseId: `${'a'.repeat(40)}-default-x64-${'b'.repeat(12)}`,
  manifestSha256: digest('5'),
  policySha256: digest('6'),
  hostSha256: digest('7'),
  configurationSha256: digest('8'),
  planSha256: digest('9'),
  baseline,
  databases,
  coreSha256: digest('e'),
};
const evidence = {
  schemaVersion: 1,
  environment: 'staging',
  operationId,
  attemptSha256: digest('f'),
  after: baseline,
  databases,
  changed: false,
  applicationRollback: 'compatible',
};

describe('routine migration action set', () => {
  it('is closed and names the read-only ledger reading', () => {
    expect([...STAGING_MIGRATION_ACTIONS]).toEqual(['apply', 'verify', 'inspect', 'observe']);
  });
});

/**
 * `observedRows` names rows a deployment found already registered and admitted as a prefix of its
 * own plan, rather than applied itself. It has to be optional: every attempt and evidence record
 * written before the admission path existed is immutable, and its digest is chained into the host's
 * pointer, so a required key would invalidate the entire recorded history.
 */
describe('parseStagingMigrationAttempt / parseStagingMigrationEvidence', () => {
  it('accepts records with no observed rows, exactly as before', () => {
    expect(parseStagingMigrationAttempt(attempt)).toBe(attempt);
    expect(parseStagingMigrationEvidence(evidence)).toBe(evidence);
  });

  it('accepts records that name the rows admitted from the ledger', () => {
    const withRows = { ...attempt, observedRows };
    const evidenceWithRows = { ...evidence, observedRows };
    expect(parseStagingMigrationAttempt(withRows)).toBe(withRows);
    expect(parseStagingMigrationEvidence(evidenceWithRows)).toBe(evidenceWithRows);
  });

  it('holds observed rows to the same row shape and stays closed to anything else', () => {
    for (const bad of [[], [{ id: '0003_applied_out_of_band' }], [{ id: 'nope', sha256: digest('c') }], observedRows[0], null, undefined]) {
      expect(parseStagingMigrationAttempt({ ...attempt, observedRows: bad })).toBeNull();
      expect(parseStagingMigrationEvidence({ ...evidence, observedRows: bad })).toBeNull();
    }
    expect(parseStagingMigrationAttempt({ ...attempt, observedRows, surplus: true })).toBeNull();
    expect(parseStagingMigrationEvidence({ ...evidence, observedRows, surplus: true })).toBeNull();
  });

  it('still requires every mandatory key', () => {
    for (const key of Object.keys(attempt)) {
      const changed: Record<string, unknown> = { ...attempt, observedRows };
      delete changed[key];
      expect(parseStagingMigrationAttempt(changed)).toBeNull();
    }
    for (const key of Object.keys(evidence)) {
      const changed: Record<string, unknown> = { ...evidence, observedRows };
      delete changed[key];
      expect(parseStagingMigrationEvidence(changed)).toBeNull();
    }
  });
});
