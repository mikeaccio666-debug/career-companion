import { describe, expect, it, vi } from 'vitest';
import { createPilotWizardSource } from '../lib/pilotWizardSource';
import type { DiscoveryRuntimeAuthorization } from '../lib/executionRuntimeAuthority';
import type { VerifiedApplicationTarget } from '@edaix/agent-channel';

const ORIGIN = 'https://portal.example.test', OWNER = '32345678-1234-4234-8234-123456789abc';
const selection = { kind: 'pilot-ua5/select-wizard-context', schemaVersion: 1,
  correlationId: '12345678-1234-4234-8234-123456789abc', missionId: '22345678-1234-4234-8234-123456789abc', expectedOwnerId: OWNER, missionRevision: '7' };
const authorization: DiscoveryRuntimeAuthorization = { schemaVersion: 1, purpose: 'DISCOVERY', runtimeBundleVersion: `rb1_${'a'.repeat(64)}`, releaseRevision: '7',
  policyVersion: 'policy-v1', rulesReleaseVersion: 'release-v1', rulesReleaseDigest: `sha256:${'b'.repeat(64)}`,
  atsProvider: 'GREENHOUSE', pathRuleId: 'application-v1', vendor: 'greenhouse', rulesetVersion: 'rules-v3', rulesetDigest: `sha256:${'c'.repeat(64)}` };
function fixture() {
  let owner: string | null = OWNER, time = 10_000;
  let target = { missionRevision: '7', canonicalOrigin: 'https://ats.example.test', pathname: '/application', atsProvider: 'GREENHOUSE' as const,
    pathRuleId: 'application-v1', verifierVersion: 'test-v1', verifiedAt: new Date(1_000).toISOString(), freshUntil: new Date(100_000).toISOString(), policyVersion: 'target-v1', revision: '4' };
  let page = { tabId: 7, origin: target.canonicalOrigin, pathname: target.pathname, targetUrlDigest: 'd'.repeat(64), pageEpoch: 1 };
  let sequence = 0;
  const resolveTarget = vi.fn(async () => target as unknown as VerifiedApplicationTarget), readConnectionReadiness = vi.fn(async () => 'READY' as const);
  const runtimeAuthority = { authorizeDiscovery: vi.fn(async () => ({ ok: true as const, value: authorization })), revalidate: vi.fn(async () => true) };
  const getCurrentUserId = vi.fn(async () => owner);
  const source = createPilotWizardSource({ allowedPortalOrigins: [ORIGIN], getCurrentUserId,
    readConnectionReadiness, resolveTarget, runtimeAuthority, readPageFacts: async () => page, now: () => time,
    newSessionId: () => (++sequence).toString(16).padStart(32, '0') });
  return { source, resolveTarget, readConnectionReadiness, runtimeAuthority, getCurrentUserId,
    owner: (next: string | null) => { owner = next; }, time: (next: number) => { time = next; },
    target: (patch: Partial<typeof target>) => { target = { ...target, ...patch }; }, page: (patch: Partial<typeof page>) => { page = { ...page, ...patch }; } };
}
describe('Portal-selected verified wizard source', () => {
  it.each([39_999, 40_000, 40_001, 45_000])('checks issuance expiry after the final owner read settles at %i', async (settledAt) => {
    const f = fixture(); await f.source.select(selection, ORIGIN);
    f.getCurrentUserId.mockResolvedValueOnce(OWNER).mockImplementationOnce(async () => {
      await Promise.resolve(); f.time(settledAt); return OWNER;
    });
    const context = await f.source.resolve(7, '1'.repeat(32));
    if (settledAt < 40_000) {
      expect(context?.expiresAtMs).toBe(40_000);
      expect(await f.source.validate(context!)).toBe(true);
    } else {
      expect(context).toBeNull();
    }
  });
  it.each([39_999, 40_000, 40_001, 45_000])('checks validation expiry after the final owner read settles at %i', async (settledAt) => {
    const f = fixture(); await f.source.select(selection, ORIGIN);
    const context = await f.source.resolve(7, '1'.repeat(32));
    expect(context?.expiresAtMs).toBe(40_000);
    f.getCurrentUserId.mockResolvedValueOnce(OWNER).mockImplementationOnce(async () => {
      await Promise.resolve(); f.time(settledAt); return OWNER;
    });
    expect(await f.source.validate(context!)).toBe(settledAt < 40_000);
    expect(await f.source.validate(context!)).toBe(settledAt < 40_000);
  });
  it.each(['selection', 'scan', 'other-tab'] as const)('does not let a late owner reply retire a newer %s', async (replacement) => {
    const f = fixture(); await f.source.select(selection, ORIGIN);
    const nextOwner = '42345678-1234-4234-8234-123456789abc';
    let finish!: (owner: string | null) => void;
    f.getCurrentUserId.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const oldResolve = f.source.resolve(7, '1'.repeat(32));
    if (replacement === 'selection') {
      f.owner(nextOwner);
      expect(await f.source.select({ ...selection, expectedOwnerId: nextOwner,
        correlationId: '52345678-1234-4234-8234-123456789abc' }, ORIGIN)).toBe(true);
    }
    const currentTab = replacement === 'other-tab' ? 8 : 7;
    f.page({ tabId: currentTab });
    const current = await f.source.resolve(currentTab, '2'.repeat(32));
    expect(current).not.toBeNull();
    expect(await f.source.validate(current!)).toBe(true);
    finish(nextOwner);
    expect(await oldResolve).toBeNull();
    expect(await f.source.validate(current!)).toBe(true);
  });
  it.each([7, 8])('still retires the current selection when the newest owner read fails on tab %i', async (failedTab) => {
    const f = fixture(); await f.source.select(selection, ORIGIN);
    const first = await f.source.resolve(7, '1'.repeat(32));
    f.owner(null);
    expect(await f.source.resolve(failedTab, '2'.repeat(32))).toBeNull();
    f.owner(OWNER);
    expect(await f.source.validate(first!)).toBe(false);
    expect(await f.source.resolve(7, '3'.repeat(32))).toBeNull();
  });
  it('does not let a late rejection retire a newer context', async () => {
    const f = fixture(); await f.source.select(selection, ORIGIN);
    const first = await f.source.resolve(7, '1'.repeat(32));
    let finish!: (value: boolean) => void;
    f.runtimeAuthority.revalidate.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const oldValidation = f.source.validate(first!);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const next = await f.source.resolve(7, '2'.repeat(32));
    finish(false);
    expect(await oldValidation).toBe(false);
    expect(await f.source.validate(next!)).toBe(true);
  });
  it('binds repeated reads to one owner/tab/document/target/rules scope without serializing the Mission', async () => {
    const f = fixture();
    expect(await f.source.select(selection, ORIGIN)).toBe(true);
    const first = await f.source.resolve(7, '1'.repeat(32));
    expect(first?.scope).toBe('LOCAL_SESSION');
    expect(JSON.stringify(first)).not.toContain(selection.missionId);
    expect(await f.source.validate(first!)).toBe(true);
    const next = await f.source.resolve(7, '2'.repeat(32));
    expect(next?.sessionId).toBe(first?.sessionId);
    expect(await f.source.validate(first!)).toBe(false);
    expect(await f.source.validate({ ...first! })).toBe(false);
    expect(f.runtimeAuthority.authorizeDiscovery).toHaveBeenCalledWith({ atsProvider: 'GREENHOUSE', pathRuleId: 'application-v1' });
  });
  it('requires a trusted Portal, exact owner readiness and backend Mission revision', async () => {
    const f = fixture();
    expect(await f.source.select(selection, 'https://hostile.example.test')).toBe(false);
    expect(f.resolveTarget).not.toHaveBeenCalled();
    expect(f.readConnectionReadiness).not.toHaveBeenCalled();
    f.owner(null);
    expect(await f.source.select(selection, ORIGIN)).toBe(false);
    const g = fixture(); g.target({ missionRevision: '8' });
    expect(await g.source.select(selection, ORIGIN)).toBe(false);
    expect(await g.source.resolve(7, '1'.repeat(32))).toBeNull();
    expect(g.runtimeAuthority.authorizeDiscovery).not.toHaveBeenCalled();
  });
  it.each(['owner', 'target', 'document', 'expiry', 'runtime'] as const)('retires %s drift before publication', async (change) => {
    const f = fixture(); await f.source.select(selection, ORIGIN);
    const context = await f.source.resolve(7, '1'.repeat(32));
    expect(context).not.toBeNull();
    if (change === 'owner') f.owner('42345678-1234-4234-8234-123456789abc');
    if (change === 'target') f.target({ revision: '5' });
    if (change === 'document') f.page({ pageEpoch: 2 });
    if (change === 'expiry') f.time(context!.expiresAtMs);
    if (change === 'runtime') f.runtimeAuthority.revalidate.mockResolvedValue(false);
    expect(await f.source.validate(context!)).toBe(false);
    expect(await f.source.validate(context!)).toBe(false);
  });
  it('rejects replay and target drift across the network boundary and retires scopes on reset', async () => {
    const f = fixture(); await f.source.select(selection, ORIGIN);
    expect(await f.source.select(selection, ORIGIN)).toBe(false);
    const first = await f.source.resolve(7, '1'.repeat(32));
    expect(first).not.toBeNull();
    f.runtimeAuthority.authorizeDiscovery.mockImplementation(async () => { f.target({ revision: '5' }); return { ok: true, value: authorization }; });
    expect(await f.source.resolve(7, '2'.repeat(32))).toBeNull();
    f.source.reset();
    expect(await f.source.validate(first!)).toBe(false);
    expect(await f.source.resolve(7, '3'.repeat(32))).toBeNull();
  });
});

describe('whether a page may be offered Autofill at all', () => {
  // The dock asks this before it draws a button. It is a display decision, not
  // an authorization: it issues nothing and grants nothing, and every run still
  // goes through resolve() with the full checks.
  it('says yes only for the exact page of a live selection', async () => {
    const f = fixture();
    expect(await f.source.missionBound(7), 'nothing selected yet').toBe(false);
    await f.source.select(selection, ORIGIN);
    expect(await f.source.missionBound(7)).toBe(true);
    expect(await f.source.missionBound(8), 'another tab is another page').toBe(false);
  });
  it('says no once the selection has gone stale', async () => {
    const f = fixture();
    await f.source.select(selection, ORIGIN);
    f.time(100_001);
    expect(await f.source.missionBound(7)).toBe(false);
  });
  it('says no when this tab is somewhere else than the application page', async () => {
    const f = fixture();
    await f.source.select(selection, ORIGIN);
    f.page({ pathname: '/some-other-form' });
    expect(await f.source.missionBound(7)).toBe(false);
  });
  it('says no rather than throwing when the page cannot be read', async () => {
    const f = fixture();
    await f.source.select(selection, ORIGIN);
    f.page({ tabId: -1 });
    expect(await f.source.missionBound(-1)).toBe(false);
  });
});
