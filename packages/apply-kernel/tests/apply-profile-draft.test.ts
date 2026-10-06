import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APPLY_PROFILE_KEY,
  APPLY_PROFILE_MIGRATION_STARTED_AT_KEY,
  APPLY_PROFILE_MIGRATION_NOTICE_KEY,
  APPLY_PROFILE_SCHEMA_VERSION,
  LEGACY_PROFILE_MIGRATION_WINDOW_MS,
  discardLegacyApplyProfile,
  readLegacyApplyProfile,
  readLegacyProfileMigrationDeadline,
} from '../src/profileDraft';

type ChangeListener = (
  changes: Record<string, { readonly newValue?: unknown }>,
  areaName: string,
) => void;

function keysFor(input: string | readonly string[]): readonly string[] {
  return typeof input === 'string' ? [input] : input;
}

function installStorage(initial: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { ...initial };
  const listeners = new Set<ChangeListener>();
  const get = vi.fn(async (input: string | readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keysFor(input)) {
      if (Object.prototype.hasOwnProperty.call(values, key)) result[key] = values[key];
    }
    return result;
  });
  const set = vi.fn(async (entries: Record<string, unknown>) => Object.assign(values, entries));
  const remove = vi.fn(async (input: string | readonly string[]) => {
    for (const key of keysFor(input)) delete values[key];
  });
  // Presence/size only: model Chrome's `getBytesInUse` without making the
  // value-free scheduler test accidentally inspect the stored draft.
  const getBytesInUse = vi.fn(async (input: string | readonly string[]) =>
    keysFor(input).some((key) => Object.prototype.hasOwnProperty.call(values, key)) ? 1 : 0,
  );
  const addListener = vi.fn((listener: ChangeListener) => listeners.add(listener));
  const removeListener = vi.fn((listener: ChangeListener) => listeners.delete(listener));

  vi.stubGlobal('browser', {
    storage: {
      local: { get, set, remove, getBytesInUse },
      onChanged: { addListener, removeListener },
    },
  });

  return { values, get, set, remove, getBytesInUse, addListener, removeListener };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('legacy local profile migration boundary', () => {
  it('treats an absent legacy key as absent and never creates a migration marker', async () => {
    const storage = installStorage();

    await expect(readLegacyApplyProfile(10)).resolves.toEqual({
      ok: true,
      value: { kind: 'absent' },
    });
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('reads a valid old draft only to offer an explicit migration and starts a value-free 30-day clock', async () => {
    const storage = installStorage({
      [APPLY_PROFILE_KEY]: { email: ' alex@example.test ', unknown: 'do not carry forward' },
    });

    await expect(readLegacyApplyProfile(123)).resolves.toEqual({
      ok: true,
      value: {
        kind: 'migratable',
        draft: { email: 'alex@example.test' },
        startedAt: 123,
      },
    });
    expect(storage.set).toHaveBeenCalledWith({ [APPLY_PROFILE_MIGRATION_STARTED_AT_KEY]: 123 });
    expect(storage.set).not.toHaveBeenCalledWith(expect.objectContaining({ [APPLY_PROFILE_KEY]: expect.anything() }));
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('exposes only a value-free deadline state to the background scheduler', async () => {
    const storage = installStorage({ [APPLY_PROFILE_KEY]: { email: 'S0-LEGACY-SCHEDULER-CANARY' } });

    const result = await readLegacyProfileMigrationDeadline(123);

    expect(result).toEqual({ ok: true, value: { kind: 'pending', startedAt: 123 } });
    expect(JSON.stringify(result)).not.toContain('S0-LEGACY-SCHEDULER-CANARY');
    expect(storage.get).toHaveBeenCalledWith([
      APPLY_PROFILE_MIGRATION_STARTED_AT_KEY,
      APPLY_PROFILE_MIGRATION_NOTICE_KEY,
    ]);
    expect(storage.getBytesInUse).toHaveBeenCalledWith(APPLY_PROFILE_KEY);
    expect(storage.get.mock.calls.flat()).not.toContain(APPLY_PROFILE_KEY);
  });

  it('reads the old v2 envelope without rewriting it, including its original data shape', async () => {
    const storage = installStorage({
      [APPLY_PROFILE_KEY]: {
        v: APPLY_PROFILE_SCHEMA_VERSION,
        updatedAt: 77,
        data: { firstName: 'Ada', city: 'Seattle' },
      },
      [APPLY_PROFILE_MIGRATION_STARTED_AT_KEY]: 100,
    });

    await expect(readLegacyApplyProfile(101)).resolves.toEqual({
      ok: true,
      value: {
        kind: 'migratable',
        draft: { firstName: 'Ada', city: 'Seattle' },
        startedAt: 100,
      },
    });
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('never exposes an unreadable/newer legacy object as a fillable or uploadable draft', async () => {
    const storage = installStorage({
      [APPLY_PROFILE_KEY]: { v: 3, updatedAt: 789, data: { email: 'newer@example.test' } },
    });

    await expect(readLegacyApplyProfile(100)).resolves.toEqual({
      ok: true,
      value: { kind: 'unreadable', startedAt: 100 },
    });
    expect(storage.set).toHaveBeenCalledWith({ [APPLY_PROFILE_MIGRATION_STARTED_AT_KEY]: 100 });
  });

  it('makes an empty, unknown, or overlong old shape delete-only instead of uploading a transformed subset', async () => {
    const storage = installStorage({
      [APPLY_PROFILE_KEY]: {
        unknown: 'do not upload',
        email: 'x'.repeat(513),
      },
    });

    await expect(readLegacyApplyProfile(100)).resolves.toEqual({
      ok: true,
      value: { kind: 'unreadable', startedAt: 100 },
    });
  });

  it('makes an otherwise valid legacy draft delete-only when any known field violates the current account contract', async () => {
    const storage = installStorage({
      [APPLY_PROFILE_KEY]: {
        email: 'alex@example.test',
        // The old local format allowed up to 512 characters. The account
        // contract allows phone only up to 64, so a partial migration would
        // otherwise succeed locally and fail at the next IPC boundary.
        phone: '1'.repeat(65),
      },
    });

    await expect(readLegacyApplyProfile(100)).resolves.toEqual({
      ok: true,
      value: { kind: 'unreadable', startedAt: 100 },
    });
  });

  it('hard-deletes an undecided local profile at 30 days and reports no profile value back', async () => {
    const startedAt = 1_000;
    const storage = installStorage({
      [APPLY_PROFILE_KEY]: { email: 'alex@example.test' },
      [APPLY_PROFILE_MIGRATION_STARTED_AT_KEY]: startedAt,
    });

    await expect(readLegacyApplyProfile(startedAt + LEGACY_PROFILE_MIGRATION_WINDOW_MS)).resolves.toEqual({
      ok: true,
      value: { kind: 'expired' },
    });
    expect(storage.remove).toHaveBeenCalledWith([
      APPLY_PROFILE_KEY,
      APPLY_PROFILE_MIGRATION_STARTED_AT_KEY,
    ]);
    expect(storage.set).toHaveBeenCalledWith({ [APPLY_PROFILE_MIGRATION_NOTICE_KEY]: 'expired' });
    expect(storage.values).not.toHaveProperty(APPLY_PROFILE_KEY);
    expect(storage.values).not.toHaveProperty(APPLY_PROFILE_MIGRATION_STARTED_AT_KEY);
  });

  it('does not delete a profile a millisecond before the privacy deadline', async () => {
    const startedAt = 1_000;
    const storage = installStorage({
      [APPLY_PROFILE_KEY]: { email: 'alex@example.test' },
      [APPLY_PROFILE_MIGRATION_STARTED_AT_KEY]: startedAt,
    });

    await expect(
      readLegacyApplyProfile(startedAt + LEGACY_PROFILE_MIGRATION_WINDOW_MS - 1),
    ).resolves.toMatchObject({ ok: true, value: { kind: 'migratable' } });
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('allows explicit deletion without login, even when the old object cannot be parsed', async () => {
    const storage = installStorage({
      [APPLY_PROFILE_KEY]: { v: 99, data: 'not readable by this build' },
      [APPLY_PROFILE_MIGRATION_STARTED_AT_KEY]: 10,
    });

    await expect(discardLegacyApplyProfile()).resolves.toEqual({ ok: true, value: undefined });
    expect(storage.remove).toHaveBeenCalledWith([
      APPLY_PROFILE_KEY,
      APPLY_PROFILE_MIGRATION_STARTED_AT_KEY,
      APPLY_PROFILE_MIGRATION_NOTICE_KEY,
    ]);
  });

  it('fails closed if it cannot record a deadline or delete legacy data', async () => {
    const deadline = installStorage({ [APPLY_PROFILE_KEY]: { email: 'alex@example.test' } });
    deadline.set.mockRejectedValueOnce(new Error('set failed'));
    await expect(readLegacyApplyProfile(1)).resolves.toEqual({ ok: false, code: 'STORAGE_UNAVAILABLE' });

    const deletion = installStorage({ [APPLY_PROFILE_KEY]: { email: 'alex@example.test' } });
    deletion.remove.mockRejectedValueOnce(new Error('remove failed'));
    await expect(discardLegacyApplyProfile()).resolves.toEqual({ ok: false, code: 'STORAGE_UNAVAILABLE' });
  });
});
