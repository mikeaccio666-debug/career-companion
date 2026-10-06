import { describe, expect, it, vi } from 'vitest';
import { APPLICATION_PROFILE_FIELD_KEYS, APPLICATION_SIGNING_CONSENT_VERSION } from '@edaix/contracts';

import {
  createProfileDirectoryClient,
  type ProfileDirectoryChannel,
  type ProfileDirectoryCode,
} from '../lib/profileDirectoryClient';
import type {
  DirectoryResponseText,
  ProfileDirectoryOperation,
} from '../lib/profileDirectoryTransport';

const personalBody = (fields: Record<string, unknown> = {}) => JSON.stringify({
  schemaVersion: 1, revision: '4', deletionEpoch: '0', updatedAt: null,
  fields: { ...Object.fromEntries(APPLICATION_PROFILE_FIELD_KEYS.map((key: string) => [key, null])), ...fields,
  },
});

function harness(texts: readonly (string | { code: ProfileDirectoryCode })[]) {
  const calls: { operation: ProfileDirectoryOperation; body: unknown }[] = [];
  const queue = [...texts];
  const diagnostics: ProfileDirectoryCode[] = [];
  const run = vi.fn(async (operation: ProfileDirectoryOperation, body?: unknown) => {
    calls.push({ operation, body });
    const next = queue.shift() ?? '{}';
    return typeof next === 'string'
      ? { ok: true as const, text: next as DirectoryResponseText }
      : { ok: false as const, code: next.code as never };
  });
  const channel: ProfileDirectoryChannel = { run };
  const client = createProfileDirectoryClient(channel, (code) => diagnostics.push(code));
  return { client, calls, diagnostics, run };
}

describe('the panel half', () => {
  it('reads the twenty-two ordinary keys, and asks the worker by operation not by URL', async () => {
    const { client, calls } = harness([personalBody()]);
    const result = await client.personal();

    expect(result).toMatchObject({ ok: true });
    expect(calls[0]).toEqual({ operation: 'PERSONAL_READ', body: undefined });
    // Nothing the panel sends resembles an address.
    expect(JSON.stringify(calls[0])).not.toContain('/users/me');
  });

  it('discards the whole answer when a self-identification value arrives on the ordinary channel', async () => {
    for (const smuggled of ['gender', 'raceEthnicity', 'veteranStatus', 'disabilityStatus']) {
      const { client, diagnostics } = harness([personalBody({ [smuggled]: 'Male' })]);

      expect(await client.personal()).toEqual({ ok: false, code: 'SENSITIVE_SMUGGLED' });
      // The reason is a stable code. The answer itself never reaches a
      // diagnostic, a log, or an error body.
      expect(diagnostics).toEqual(['SENSITIVE_SMUGGLED']);
    }
  });

  it('discards an answer missing one of the ordinary keys rather than showing a gap as empty', async () => {
    const body = JSON.parse(personalBody()) as { fields: Record<string, unknown> };
    delete body.fields['email'];
    const { client } = harness([JSON.stringify(body)]);

    expect(await client.personal()).toEqual({ ok: false, code: 'RESPONSE_MALFORMED' });
  });

  it('discards an answer that is not even JSON, instead of throwing at the caller', async () => {
    const { client } = harness(['<html>proxy error</html>']);
    expect(await client.personal()).toEqual({ ok: false, code: 'RESPONSE_MALFORMED' });
  });

  it('passes the worker\'s own refusals through unchanged', async () => {
    for (const code of ['DISABLED', 'LOGIN_REQUIRED', 'UNAVAILABLE', 'STALE'] as const) {
      const { client } = harness([{ code }]);
      expect(await client.personal()).toEqual({ ok: false, code });
    }
  });

  it('sends nothing at all when the caller\'s own update does not satisfy the contract', async () => {
    const { client, run } = harness([]);
    const result = await client.savePersonal({
      schemaVersion: 1, expectedRevision: '4', expectedDeletionEpoch: '0',
      fields: { location: 'Berlin' },
    } as never);

    expect(result).toEqual({ ok: false, code: 'INVALID' });
    expect(run).not.toHaveBeenCalled();
  });

  it('carries the reuse switch on the work-authorization section, both ways', async () => {
    const stored = {
      schemaVersion: 1, profileRevision: '4', deletionEpoch: '0', preferencesRevision: '2',
      reuseEnabled: true, entries: [{ regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO' }],
    };
    const { client, calls } = harness([
      JSON.stringify(stored),
      JSON.stringify({ ...stored, reuseEnabled: false, preferencesRevision: '3' }),
    ]);

    expect(await client.workAuthorization()).toEqual({ ok: true, value: stored });

    const saved = await client.saveWorkAuthorization({
      schemaVersion: 1, expectedProfileRevision: '4', expectedDeletionEpoch: '0',
      expectedPreferencesRevision: '2', reuseEnabled: false, entries: stored.entries,
    } as never);

    expect(saved).toMatchObject({ ok: true, value: { reuseEnabled: false } });
    // Withdrawing reuse leaves the answers the user stated exactly as they are.
    expect(calls[1]!.body).toMatchObject({ reuseEnabled: false, entries: stored.entries });
  });

  it('reads and writes self-identification on its own operation, never the ordinary one', async () => {
    const block = {
      schemaVersion: 1, answers: { eeoSex: ['Male'] }, reuseEnabled: true,
      disclosureVersion: '2026-09-10', revision: '2', updatedAt: null,
    };
    const { client, calls } = harness([JSON.stringify(block), JSON.stringify({ ...block, revision: '3' })]);

    expect(await client.eeo()).toEqual({ ok: true, value: block });
    await client.saveEeo({
      schemaVersion: 1, expectedRevision: '2', answers: { eeoSex: ['Male'] },
      reuseEnabled: true, disclosureVersion: '2026-09-10',
    } as never);

    expect(calls.map((call) => call.operation)).toEqual(['EEO_READ', 'EEO_SAVE']);
    for (const call of calls) expect(call.operation).not.toContain('PERSONAL');
  });

  it('checks the shape on every section, so no path returns an unchecked answer', async () => {
    // One probe per section: a section that skipped its check would hand this
    // obviously-wrong record straight back as a value.
    const junk = JSON.stringify({ schemaVersion: 1, unexpected: true });
    for (const read of [
      (c: ReturnType<typeof harness>['client']) => c.personal(),
      (c: ReturnType<typeof harness>['client']) => c.workAuthorization(),
      (c: ReturnType<typeof harness>['client']) => c.eeo(),
      (c: ReturnType<typeof harness>['client']) => c.preferences(),
    ]) {
      const { client } = harness([junk]);
      expect(await read(client)).toEqual({ ok: false, code: 'RESPONSE_MALFORMED' });
    }
  });
});

describe('代填授权（2026-09-28：文案再加第五刀的新类别，版本 application-signing-2026-09-28）', () => {
  const consentBody = (granted: boolean, policyVersion: string = APPLICATION_SIGNING_CONSENT_VERSION) => JSON.stringify({
    schemaVersion: 1,
    consent: { purpose: 'application-signing', policyVersion, granted, grantedAt: granted ? '2026-09-28T08:00:00.000Z' : null },
  });

  it('打开：请求体带上这版插件显示的文案版本——服务端不会把一段没显示过的文案记成他的同意', async () => {
    const { client, calls } = harness([consentBody(true)]);
    expect(await client.setSigningConsent(true)).toEqual({ ok: true, value: true });
    expect(calls).toEqual([{ operation: 'SIGNING_CONSENT_GRANT', body: { policyVersion: 'application-signing-2026-09-28' } }]);
  });

  it('关掉：撤回不带请求体', async () => {
    const { client, calls } = harness([consentBody(false)]);
    expect(await client.setSigningConsent(false)).toEqual({ ok: true, value: false });
    expect(calls).toEqual([{ operation: 'SIGNING_CONSENT_REVOKE', body: undefined }]);
  });

  it('服务端要的是别的版本（老服务端还在 09-24，或更新的一版）→ VERSION_MISMATCH：编辑器不摆那一格', async () => {
    for (const version of ['application-signing-2026-09-24', 'application-signing-2099-01-01']) {
      const { client } = harness([consentBody(true, version)]);
      expect(await client.signingConsent()).toEqual({ ok: false, code: 'VERSION_MISMATCH' });
    }
  });
});

/**
 * 「我的资料」上一次读到的那一份（2026-10-04，先显示旧的、后台换新）：worker 从 storage.session 交来原文，这里照样走
 * 现读的那几道门判形状——判不过的那一格当没有，绝不半份摆出来。
 */
describe('上一次读到的那一份', () => {
  const snapshotText = async () => JSON.stringify((await import('../assistant/testing/profile-snapshot')).fictionalProfileSnapshot('Example Person'));
  const consentText = (granted: boolean) => JSON.stringify({
    schemaVersion: 1,
    consent: { purpose: 'application-signing', policyVersion: APPLICATION_SIGNING_CONSENT_VERSION, granted, grantedAt: granted ? '2026-10-01T00:00:00.000Z' : null, revoked: false },
  });

  it('四格各自走现读的那道门；没有的那一格是 NO_CACHE', async () => {
    const reply = { ok: true, slots: { PROFILE_V2: { at: 42, text: await snapshotText() }, SIGNING_CONSENT: { at: 43, text: consentText(true) } } };
    const client = createProfileDirectoryClient({ run: vi.fn(), cached: async () => reply });
    const view = await client.cached();
    expect(view?.profileV2?.at).toBe(42);
    expect(view?.profileV2?.value.revision).toBe('1');
    expect(view?.signingConsent).toEqual({ ok: true, value: true });
    expect(view?.eeo).toEqual({ ok: false, code: 'NO_CACHE' });
    expect(view?.resumeLibrary).toEqual({ ok: false, code: 'NO_CACHE' });
  });

  it('资料那一格判不过：当没有（整份不摆），不是半份', async () => {
    const reply = { ok: true, slots: { PROFILE_V2: { at: 1, text: '{"schemaVersion":2,"revision":"1"}' } } };
    const client = createProfileDirectoryClient({ run: vi.fn(), cached: async () => reply });
    expect((await client.cached())?.profileV2).toBeNull();
  });

  it('worker 没答、答了别的形状、这一页没登记：null（编辑器照旧先转圈）', async () => {
    for (const reply of [undefined, null, { ok: false, code: 'PAGE_NOT_REGISTERED' }, { ok: true, slots: { PROFILE_V2: { at: 'x', text: 1 } } }, { ok: true }]) {
      const client = createProfileDirectoryClient({ run: vi.fn(), cached: async () => reply });
      const view = await client.cached();
      expect(view === null || view.profileV2 === null, JSON.stringify(reply)).toBe(true);
    }
    const throwing = createProfileDirectoryClient({ run: vi.fn(), cached: async () => { throw new Error('Extension context invalidated.'); } });
    expect(await throwing.cached()).toBeNull();
    expect(await createProfileDirectoryClient({ run: vi.fn() }).cached(), '没接这一路').toBeNull();
  });
});
