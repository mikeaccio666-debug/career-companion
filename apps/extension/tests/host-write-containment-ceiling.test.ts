// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBundledApplyPolicy } from '@edaix/apply-kernel/policy';
import type { ExecutionGrant, FillProgress } from '@edaix/agent-channel';
import { enforceHostSubmissionContainmentPolicy } from '../lib/hostWriteContainment';
import { scanCurrentPage } from '../lib/kernelScanner';
import { fillFromGrant } from '../lib/kernelFiller';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();


afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('T10 production host-write containment ceiling', () => {
  const controlledTarget = Object.freeze({
    origin: 'https://job-boards.greenhouse.io:8443',
    pathname: '/acme/jobs/12345',
  });

  it('disables the whole policy by default before any current or future writer can run', () => {
    const policy = createBundledApplyPolicy();
    const guarded = enforceHostSubmissionContainmentPolicy(policy, controlledTarget);
    expect(guarded.enabled).toBe(false);
    expect(guarded.source).toBe('disabled');
    expect(policy.enabled).toBe(true);
  });

  it('returns POLICY_DISABLED before values or input/change handlers can call direct submit', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="first_name">First name*</label><input id="first_name" required />
        <label for="last_name">Last name*</label><input id="last_name" required />
        <label for="email">Email*</label><input id="email" type="email" required />
        <button type="submit">Submit application</button>
      </form>`;
    const form = document.querySelector<HTMLFormElement>('#application-form')!;
    const directSubmit = vi.spyOn(HTMLFormElement.prototype, 'submit')
      .mockImplementation(() => undefined);
    let hostEvents = 0;
    const hostileHostListener = () => {
      hostEvents += 1;
      form.submit();
    };
    form.addEventListener('input', hostileHostListener);
    form.addEventListener('change', hostileHostListener);
    // The production text envelope is input/change/blur/focusout, not just the
    // two events this ceiling's header names, and `e2e/t10-host-write-hazard.mjs`
    // measures a focusout listener reaching the same eventless call. The
    // ceiling has to hold across the whole envelope, so the test covers it.
    form.addEventListener('focusout', hostileHostListener);
    const { scan } = await scanCurrentPage(document, {
      hostname: 'job-boards.greenhouse.io',
      origin: 'https://job-boards.greenhouse.io',
      pathname: '/acme/jobs/12345',
    });
    expect(scan).not.toBeNull();
    const grant: ExecutionGrant = {
      missionId: 'm_containment',
      missionStepId: 'ms_containment',
      fieldKeys: scan!.fieldKeys,
      allowedActions: ['FILL'],
      executionLease: 'lease_containment',
      leaseExpiresAt: Math.floor(Date.now() / 1_000) + 120,
      intentVersion: 1,
      planDigest: `sha256:${'1'.repeat(64)}`,
      jobIdentityHash: `sha256:${'2'.repeat(64)}`,
      fieldSchemaVersion: 1,
      profileSnapshot: {
        revision: '1',
        deletionEpoch: '0',
        snapshotDigest: `sha256:${'3'.repeat(64)}`,
      },
    };
    const outcomes: Parameters<FillProgress['onOutcome']>[0][] = [];
    const result = await fillFromGrant({
      grant,
      scan: scan!,
      profile: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' },
      progress: {
        onOutcome: (outcome) => outcomes.push(outcome),
        onNeedsUserInput: () => undefined,
        shouldStop: () => false,
      },
      policy: enforceHostSubmissionContainmentPolicy(
        createBundledApplyPolicy(Date.now()),
        controlledTarget,
      ),
    });

    expect(result).toHaveLength(3);
    expect(result.every((outcome) => !outcome.ok && outcome.reason === 'POLICY_DISABLED')).toBe(true);
    expect(outcomes).toEqual(result);
    expect(document.querySelector<HTMLInputElement>('#first_name')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#last_name')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#email')!.value).toBe('');
    expect(hostEvents).toBe(0);
    expect(directSubmit).not.toHaveBeenCalled();
  });

  it('admits only the compile-time controlled Mock rehearsal and still denies pointer writers', () => {
    vi.stubGlobal('__VIBE_CONTROLLED_MOCK_WRITES__', true);
    const policy = createBundledApplyPolicy();
    const guarded = enforceHostSubmissionContainmentPolicy(policy, controlledTarget);
    expect(guarded.enabled).toBe(true);
    expect(guarded.capabilities['set-combobox']).toBe(false);
    expect(guarded.capabilities['manage-rows']).toBe(false);
  });

  it('keeps the mock exception disabled for every non-exact origin or pathname', () => {
    vi.stubGlobal('__VIBE_CONTROLLED_MOCK_WRITES__', true);
    const policy = createBundledApplyPolicy();
    expect(enforceHostSubmissionContainmentPolicy(policy, {
      ...controlledTarget,
      origin: 'https://job-boards.greenhouse.io',
    }).enabled).toBe(false);
    expect(enforceHostSubmissionContainmentPolicy(policy, {
      ...controlledTarget,
      pathname: '/acme/jobs/99999',
    }).enabled).toBe(false);
  });

  it('admits only a literal true compile flag, never a truthy stand-in', () => {
    // A build variable that survives as the string '1', or as a 1 from an
    // arithmetic define, is the shape a misconfigured toolchain produces. The
    // ceiling is the last thing standing between a normal build and a real
    // page, so it reads the flag exactly rather than for truthiness.
    for (const truthy of ['1', 1, 'true', {}, [], -1]) {
      vi.stubGlobal('__VIBE_CONTROLLED_MOCK_WRITES__', truthy);
      const guarded = enforceHostSubmissionContainmentPolicy(
        createBundledApplyPolicy(),
        controlledTarget,
      );
      expect(guarded.enabled).toBe(false);
      expect(guarded.source).toBe('disabled');
    }
  });

  it('hands back a frozen ceiling so a later caller cannot re-enable it in place', () => {
    const guarded = enforceHostSubmissionContainmentPolicy(
      createBundledApplyPolicy(),
      controlledTarget,
    );
    expect(Object.isFrozen(guarded)).toBe(true);
    expect(() => {
      (guarded as { enabled: boolean }).enabled = true;
    }).toThrow(TypeError);
    expect(guarded.enabled).toBe(false);
  });
});

describe('live host writing (internal test build; store build since 2026-09-23)', () => {
  const posting = Object.freeze({
    origin: 'https://job-boards.greenhouse.io',
    pathname: '/acme/jobs/4001',
  });

  it('stays disabled on a live posting until its own flag is set', () => {
    const policy = createBundledApplyPolicy();
    expect(enforceHostSubmissionContainmentPolicy(policy, posting).enabled).toBe(false);
    // The mock flag must not open a live host: the two exceptions are separate.
    vi.stubGlobal('__VIBE_CONTROLLED_MOCK_WRITES__', true);
    expect(enforceHostSubmissionContainmentPolicy(policy, posting).enabled).toBe(false);
  });

  it('admits a live posting with the flag, keeping every capability the policy granted', () => {
    vi.stubGlobal('__VIBE_LIVE_HOST_WRITES__', true);
    const policy = createBundledApplyPolicy();
    const guarded = enforceHostSubmissionContainmentPolicy(policy, posting);
    expect(guarded.enabled).toBe(true);
    // Unlike the mock rehearsal, a live run must exercise the paths it exists for.
    expect(guarded.capabilities['set-combobox']).toBe(policy.capabilities['set-combobox']);
    expect(guarded.capabilities['manage-rows']).toBe(policy.capabilities['manage-rows']);
  });

  it('admits any ordinary public https posting host, whatever the vendor', () => {
    vi.stubGlobal('__VIBE_LIVE_HOST_WRITES__', true);
    const policy = createBundledApplyPolicy();
    for (const origin of [
      'https://job-boards.greenhouse.io',
      'https://jobs.lever.co',
      'https://jobs.ashbyhq.com',
      'https://careers-acme.icims.com',
      'https://acme.bamboohr.com',
    ]) {
      expect(enforceHostSubmissionContainmentPolicy(policy, { origin, pathname: '/x/jobs/1' }).enabled)
        .toBe(true);
    }
  });

  it('refuses rehearsal and credential-bearing shapes even with the flag', () => {
    vi.stubGlobal('__VIBE_LIVE_HOST_WRITES__', true);
    const policy = createBundledApplyPolicy();
    for (const origin of [
      // Plain http, a port, and embedded credentials are harness/credential
      // shapes, not live postings.
      'http://job-boards.greenhouse.io',
      'https://job-boards.greenhouse.io:8443',
      'https://user:pw@job-boards.greenhouse.io',
      // A single-label host is localhost-shaped, never a public posting.
      'https://localhost',
      'not-a-url',
    ]) {
      expect(enforceHostSubmissionContainmentPolicy(policy, { origin, pathname: '/x/jobs/1' }).enabled)
        .toBe(false);
    }
  });
});
