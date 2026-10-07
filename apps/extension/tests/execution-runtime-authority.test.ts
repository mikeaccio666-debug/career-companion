// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { APPLY_RULES_RUNTIME_RELEASE_V1 } from '../../../packages/apply-rules/runtime-release';
import {
  canonicalizeExecutionRuntimeJsonV1,
  type ExecutionRuntimeBundleV1,
  type ExecutionRuntimeBundleWithoutVersionV1,
} from '@edaix/contracts';
import type { ExecutionGrant, FillProgress, PageScan } from '@edaix/agent-channel';
import type { BridgeEvent, BridgePortLike, BridgeRequest } from '../lib/bridgeProtocol';
import {
  createBackgroundExecutionRuntimeAuthority,
  resolveStoredDiscoveryRuntimeAuthority,
  resolveStoredWizardRuntimeAuthority,
  readResolvedDiscoveryWizardDeclaration,
  resolveStoredExecutionRuntimeAuthority,
  type VerifiedIntentRuntimeTarget,
} from '../lib/executionRuntimeAuthority';
import {
  createExecutionRuntimeBundleClient,
  type ExecutionRuntimeBundleClient,
} from '../lib/executionRuntimeBundleClient';
import {
  openVerifiedHostShadowRoot,
  scanCurrentPageWithDiscoveryAuthority,
  scanCurrentPageWithRuntimeAuthority,
  type RuntimeKernelScanGate,
} from '../lib/kernelScanner';
import { createTabKernelBridge } from '../lib/tabBridge';
import { createPilotWizardRuntime, readPilotWizardRuntimeStep, isPilotWizardRuntimeCurrent } from '../lib/pilotWizardRuntime';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');

describe('verified wizard source', () => {
  it('exposes v3 declarations only through the exact verified discovery authority', async () => {
    const base = bundle();
    const rulesets = base.rules.rulesets.map((entry) => {
      if (entry.ruleset.vendor !== 'greenhouse') return entry;
      const ruleset = { ...entry.ruleset, schemaVersion: 3, wizard: { schemaVersion: 1,
        wizardKey: 'test-wizard', applicationRootSelector: '#application', indicatorContainerSelector: '#steps',
        steps: [{ stepKey: 'personal', indicatorSelector: '#personal' }],
      } };
      return { ...entry, ruleset, digest: digest(ruleset) };
    });
    const mappings = base.rules.mappings.map((mapping) => ({ ...mapping,
      rulesetDigest: rulesets.find((entry) => entry.version === mapping.rulesetVersion)!.digest,
    }));
    const content = { releaseVersion: base.rules.releaseVersion, mappings, rulesets };
    const { runtimeBundleVersion: _old, ...rest } = base;
    const withoutVersion = { ...rest, compatibility: { ...rest.compatibility, rulesSchemaVersion: 3 as const },
      rules: { ...content, releaseDigest: digest(content) } } as unknown as ExecutionRuntimeBundleWithoutVersionV1;
    const value = { ...withoutVersion, runtimeBundleVersion: runtimeVersion(withoutVersion) };
    const authorized = await createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) }).authorizeDiscovery(TARGET);
    if (!authorized.ok) throw new Error(authorized.code);
    const resolved = await resolveStoredDiscoveryRuntimeAuthority({ stored: stored(value), authorization: authorized.value,
      nowMs: NOW, extensionVersion: '0.0.0' });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.code);
    expect(readResolvedDiscoveryWizardDeclaration(resolved.value)?.wizardKey).toBe('test-wizard');
    expect(readResolvedDiscoveryWizardDeclaration({ ...resolved.value })).toBeNull();
    expect(JSON.stringify(resolved.value)).not.toContain('applicationRootSelector');
    const wizardOnly = await resolveStoredWizardRuntimeAuthority({ stored: stored(value), authorization: authorized.value,
      nowMs: NOW, extensionVersion: '0.0.0' });
    if (!wizardOnly.ok) throw new Error(wizardOnly.code);
    expect(readResolvedDiscoveryWizardDeclaration(wizardOnly.value)?.wizardKey).toBe('test-wizard');
    expect(readResolvedDiscoveryWizardDeclaration({ ...wizardOnly.value })).toBeNull();
    expect(Object.keys(wizardOnly.value)).toEqual(['authorization', 'freshUntilMs', 'notAfterMs']);
    expect((await resolveStoredWizardRuntimeAuthority({ stored: { ...stored(value), rawBody: '{}' }, authorization: authorized.value,
      nowMs: NOW, extensionVersion: '0.0.0' })).ok).toBe(false);
    document.body.innerHTML = '<main id="application"><nav id="steps"><span id="personal" aria-current="step" aria-controls="panel">Step</span></nav><section id="panel"></section></main>';
    let current = true, time = NOW;
    const runtime = createPilotWizardRuntime({ authority: resolved.value, document, location: window.location,
      now: () => time, isAuthorityCurrent: () => current });
    expect(runtime).not.toBeNull();
    if (runtime === null) throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
    expect(Object.keys(runtime)).toEqual(['scope', 'rulesetDigest', 'runtimeBundleVersion']);
    expect(readPilotWizardRuntimeStep(runtime, () => true)).toMatchObject({ ok: true, value: { stepIndex: 0 } });
    expect(isPilotWizardRuntimeCurrent({ ...runtime })).toBe(false);
    current = false;
    expect(isPilotWizardRuntimeCurrent(runtime)).toBe(false);
    current = true;
    expect(isPilotWizardRuntimeCurrent(runtime)).toBe(false);
    const expiring = createPilotWizardRuntime({ authority: resolved.value, document, location: window.location,
      now: () => time, isAuthorityCurrent: () => current });
    expect(expiring).not.toBeNull();
    time = Date.parse(value.freshUntil);
    expect(isPilotWizardRuntimeCurrent(expiring!)).toBe(false);
    const stale = await resolveStoredDiscoveryRuntimeAuthority({ stored: stored(value), authorization: authorized.value,
      nowMs: Date.parse(value.freshUntil), extensionVersion: '0.0.0' });
    expect(stale.ok).toBe(false);
    const mismatch = await resolveStoredDiscoveryRuntimeAuthority({ stored: stored(base), authorization: authorized.value,
      nowMs: NOW, extensionVersion: '0.0.0' });
    expect(mismatch.ok).toBe(false);
  });
});

function digest(value: unknown): `sha256:${string}` {
  const canonical = canonicalizeExecutionRuntimeJsonV1(value);
  if (!canonical.ok) throw new Error(canonical.code);
  return `sha256:${createHash('sha256').update(canonical.value).digest('hex')}`;
}

function runtimeVersion(value: ExecutionRuntimeBundleWithoutVersionV1): `rb1_${string}` {
  return `rb1_${digest(value).slice('sha256:'.length)}`;
}

function bundle(): ExecutionRuntimeBundleV1 {
  const withoutVersion = {
    schemaVersion: 1,
    releaseRevision: '7',
    issuedAt: '2026-08-24T11:50:00.000Z',
    notBefore: '2026-08-24T11:51:00.000Z',
    freshUntil: '2026-08-24T12:10:00.000Z',
    notAfter: '2026-08-24T13:00:00.000Z',
    compatibility: {
      minExtensionVersion: '0.0.0',
      rulesSchemaVersion: 2,
      contractVersion: 1,
    },
    policy: {
      version: 'policy-v1',
      killSwitchVersion: '7',
      enabled: true,
      automationLevelCeiling: 'L1_FILL_STOP_BEFORE_SUBMIT',
      allowedActions: ['FILL'],
      allowedFieldKeys: ['email', 'firstName', 'lastName'],
      vendors: {
        greenhouse: true,
        lever: true,
        ashby: true,
        workable: true,
        workday: false,
        icims: false,
        smartrecruiters: false,
        bamboohr: false,
        avature: false,
      },
      capabilities: {
        'set-text': true,
        'set-select': true,
        'set-combobox': false,
        'set-file': false,        'set-attestation': false,
      },
      minConfidence: 0.7,
      inferredRequiresConfirm: true,
      deniedHostSuffixes: [],
    },
    rules: APPLY_RULES_RUNTIME_RELEASE_V1,
  } as unknown as ExecutionRuntimeBundleWithoutVersionV1;
  return {
    runtimeBundleVersion: runtimeVersion(withoutVersion),
    ...withoutVersion,
  };
}

const TARGET: VerifiedIntentRuntimeTarget = {
  canonicalOrigin: 'https://careers.acme.test',
  atsProvider: 'GREENHOUSE',
  pathRuleId: 'greenhouse-application-v1',
  policyVersion: 'policy-v1',
  killSwitchVersion: '7',
  automationLevel: 'L1_FILL_STOP_BEFORE_SUBMIT',
  allowedActions: ['FILL'],
  fieldKeys: ['email', 'firstName', 'lastName'],
};

function clientFor(value: ExecutionRuntimeBundleV1) {
  return {
    refresh: async () => ({
      ok: true as const,
      source: 'NETWORK' as const,
      etag: `"${value.runtimeBundleVersion}"`,
      bundle: value,
    }),
  };
}

function stored(value: ExecutionRuntimeBundleV1) {
  const canonical = canonicalizeExecutionRuntimeJsonV1(value);
  if (!canonical.ok) throw new Error(canonical.code);
  return {
    schemaVersion: 1,
    etag: `"${value.runtimeBundleVersion}"`,
    runtimeBundleVersion: value.runtimeBundleVersion,
    releaseRevision: value.releaseRevision,
    rawBody: canonical.value,
  };
}

function withPolicy(
  value: ExecutionRuntimeBundleV1,
  patch: Partial<ExecutionRuntimeBundleV1['policy']>,
): ExecutionRuntimeBundleV1 {
  const { runtimeBundleVersion: _old, ...withoutOldVersion } = value;
  const withoutVersion = {
    ...withoutOldVersion,
    policy: { ...value.policy, ...patch },
  } as ExecutionRuntimeBundleWithoutVersionV1;
  return {
    runtimeBundleVersion: runtimeVersion(withoutVersion),
    ...withoutVersion,
  };
}

function mountGreenhouseForm(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First name*</label>
      <input id="first_name" type="text" required />
      <label for="last_name">Last name*</label>
      <input id="last_name" type="text" required />
      <label for="email">Email*</label>
      <input id="email" type="email" required />
      <button type="submit">Submit</button>
    </form>`;
}

function runtimeScanGate(): RuntimeKernelScanGate {
  return {
    openShadowRoot: (element) => element.shadowRoot,
    armMutationGuard: (policy) => ({
      isCurrent: () => policy.isCurrent(),
      dispose: () => {},
    }),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('verified intent → exact backend runtime mapping', () => {
  it('authorizes exactly one mapping and content independently rebuilds the same remote adapter/policy', async () => {
    const value = bundle();
    const authority = createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) });
    const authorized = await authority.authorize(TARGET);
    expect(authorized).toMatchObject({
      ok: true,
      value: {
        runtimeBundleVersion: value.runtimeBundleVersion,
        releaseRevision: '7',
        atsProvider: 'GREENHOUSE',
        pathRuleId: 'greenhouse-application-v1',
        vendor: 'greenhouse',
      },
    });
    if (!authorized.ok) throw new Error(authorized.code);

    const resolved = await resolveStoredExecutionRuntimeAuthority({
      stored: stored(value),
      authorization: authorized.value,
      nowMs: NOW,
      extensionVersion: '1.0.0',
    });
    expect(resolved).toMatchObject({
      ok: true,
      value: {
        policy: { source: 'remote', enabled: true },
        freshUntilMs: Date.parse(value.freshUntil),
        notAfterMs: Date.parse(value.notAfter),
      },
    });
    if (!resolved.ok) throw new Error(resolved.code);

    mountGreenhouseForm();
    const outcome = await scanCurrentPageWithRuntimeAuthority(
      resolved.value,
      document,
      {
        // This custom hostname has no bundled/static vendor attribution. The
        // exact verified intent + backend mapping is the sole vendor source.
        hostname: 'careers.acme.test',
        origin: 'https://careers.acme.test',
        pathname: '/acme/jobs/12345',
      },
      runtimeScanGate(),
    );
    expect(outcome.vendor).toBe('greenhouse');
    expect(outcome.scan?.fieldKeys).toEqual(['email', 'firstName', 'lastName']);
    expect(outcome.scan?.runtimeAuthorization).toEqual(authorized.value);
    expect(outcome.scan?.runtimeFreshUntilMs).toBe(Date.parse(value.freshUntil));
    expect(outcome.scan?.runtimeNotAfterMs).toBe(Date.parse(value.notAfter));
  });

  it('unknown pathRuleId, policy drift, or release drift fail before any content connection', async () => {
    const value = bundle();
    const authority = createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) });
    await expect(authority.authorize({
      ...TARGET,
      pathRuleId: 'greenhouse-application-unknown',
    })).resolves.toEqual({ ok: false, code: 'RUNTIME_AUTHORITY_MAPPING_UNAVAILABLE' });
    await expect(authority.authorize({
      ...TARGET,
      policyVersion: 'policy-v2',
    })).resolves.toEqual({ ok: false, code: 'RUNTIME_AUTHORITY_INTENT_MISMATCH' });
    await expect(authority.authorize({
      ...TARGET,
      killSwitchVersion: '8',
    })).resolves.toEqual({ ok: false, code: 'RUNTIME_AUTHORITY_INTENT_MISMATCH' });
  });

  it('rejects a legacy LAST_KNOWN_GOOD success result at the runtime authority boundary', async () => {
    const value = bundle();
    const legacyClient = {
      refresh: async () => ({
        ok: true,
        source: 'LAST_KNOWN_GOOD',
        etag: `"${value.runtimeBundleVersion}"`,
        bundle: value,
      }),
    } as unknown as ExecutionRuntimeBundleClient;
    const authority = createBackgroundExecutionRuntimeAuthority({ client: legacyClient });

    await expect(authority.authorize(TARGET)).resolves.toEqual({
      ok: false,
      code: 'RUNTIME_AUTHORITY_UNAVAILABLE',
    });
  });

  it.each([
    ['network reject', () => new Error('offline')],
    ['503 response', () => new Response('{"code":"unavailable"}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })],
  ] as const)(
    'fresh allow cache cannot authorize or revalidate after %s and produces zero new attach/scan/fill/DOM write',
    async (_label, remoteFailure) => {
      const value = bundle();
      const etag = `"${value.runtimeBundleVersion}"`;
      const queue: Array<Response | Error> = [
        new Response(null, { status: 304, headers: { etag } }),
        remoteFailure(),
        remoteFailure(),
      ];
      const client = createExecutionRuntimeBundleClient({
        apiBase: 'https://api.example.test',
        store: {
          read: async () => stored(value),
          write: async () => {
            throw new Error('unexpected cache write');
          },
        },
        extensionVersion: () => '1.0.0',
        now: () => NOW,
        fetchFn: (async () => {
          const next = queue.shift();
          if (next instanceof Error) throw next;
          if (next === undefined) throw new Error('unexpected fetch');
          return next;
        }) as typeof fetch,
      });
      const authority = createBackgroundExecutionRuntimeAuthority({ client });

      const scanResult: PageScan = {
        jobId: '/acme/jobs/12345',
        canonicalOrigin: TARGET.canonicalOrigin,
        fieldKeys: ['email'],
        scanDigest: `sha256:${'e'.repeat(64)}`,
      };
      const grant: ExecutionGrant = {
        missionId: 'mission-1',
        missionStepId: 'mission-step-1',
        fieldKeys: ['email'],
        allowedActions: ['FILL'],
        executionLease: 'lease-1',
        leaseExpiresAt: 9_999_999_999,
        intentVersion: 1,
        planDigest: `sha256:${'b'.repeat(64)}`,
        jobIdentityHash: `sha256:${'a'.repeat(64)}`,
        fieldSchemaVersion: 1,
        profileSnapshot: {
          revision: '7',
          deletionEpoch: '0',
          snapshotDigest: `sha256:${'c'.repeat(64)}`,
        },
      };
      const bridgeRequests: BridgeRequest[] = [];
      const authorizationResults: boolean[] = [];
      const revalidationResults: boolean[] = [];
      let connectionCount = 0;
      let profileReadCount = 0;
      let domWriteCount = 0;
      mountGreenhouseForm();
      const email = document.querySelector<HTMLInputElement>('#email');
      if (email === null) throw new Error('missing test input');

      const bridge = createTabKernelBridge({
        resolveTargetOrigin: () => TARGET.canonicalOrigin,
        resolveTargetPathname: async () => '/acme/jobs/12345',
        queryTabs: async () => [{
          id: 7,
          url: `${TARGET.canonicalOrigin}/acme/jobs/12345`,
          lastAccessed: 1,
        }],
        runtimeAuthority: {
          mode: 'REQUIRED',
          resolve: async () => {
            const result = await authority.authorize(TARGET);
            authorizationResults.push(result.ok);
            return result.ok ? result.value : null;
          },
          revalidate: async (authorization) => {
            const result = await authority.revalidate(authorization);
            revalidationResults.push(result);
            return result;
          },
        },
        connectToTab: () => {
          connectionCount += 1;
          const messageListeners: Array<(message: unknown) => void> = [];
          const disconnectListeners: Array<() => void> = [];
          const port: BridgePortLike = {
            postMessage(raw) {
              const request = raw as BridgeRequest;
              bridgeRequests.push(request);
              setTimeout(() => {
                let event: BridgeEvent | null = null;
                if (request.kind === 'bridge/scan') {
                  event = { kind: 'bridge/scan-result', requestId: request.requestId, scan: scanResult };
                } else if (request.kind === 'bridge/revalidate-scan') {
                  event = {
                    kind: 'bridge/revalidate-scan-result',
                    requestId: request.requestId,
                    accepted: true,
                  };
                } else if (request.kind === 'bridge/fill') {
                  domWriteCount += 1;
                  email.value = 'must-not-write@example.test';
                  event = { kind: 'bridge/fill-result', requestId: request.requestId, outcomes: [] };
                }
                if (event !== null) messageListeners.forEach((listener) => listener(event));
              }, 0);
            },
            onMessage: { addListener: (listener) => messageListeners.push(listener) },
            onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
            disconnect: () => disconnectListeners.forEach((listener) => listener()),
          };
          return port;
        },
        getProfile: async () => {
          profileReadCount += 1;
          return { ok: true, draft: { email: 'candidate@example.test' } };
        },
        timeoutMs: 1_000,
      });

      const firstScan = await bridge.scanner.scan(
        {
          clientRequestId: 'request-1',
          missionId: 'mission-1',
          missionStepId: 'mission-step-1',
          missionRevision: '8',
        },
        { jws: 'header.payload.signature' },
      );
      expect(firstScan).toEqual(scanResult);
      if (firstScan === null) throw new Error('expected authorized initial scan');

      const outcomes: Parameters<FillProgress['onOutcome']>[0][] = [];
      const fill = await bridge.filler.fill(grant, firstScan, {
        onOutcome: (outcome) => outcomes.push(outcome),
        onNeedsUserInput: () => {},
        shouldStop: () => false,
      });
      expect(fill).toEqual([{ key: 'email', ok: false, reason: 'POLICY_DISABLED' }]);
      expect(outcomes).toEqual(fill);

      await expect(bridge.scanner.scan(
        {
          clientRequestId: 'request-2',
          missionId: 'mission-1',
          missionStepId: 'mission-step-1',
          missionRevision: '8',
        },
        { jws: 'header.payload.signature' },
      )).resolves.toBeNull();
      expect(authorizationResults).toEqual([true, false]);
      expect(revalidationResults).toEqual([false]);
      expect(connectionCount).toBe(1);
      expect(profileReadCount).toBe(0);
      expect(bridgeRequests.filter((request) => request.kind === 'bridge/scan')).toHaveLength(1);
      expect(bridgeRequests.some((request) => request.kind === 'bridge/fill')).toBe(false);
      expect(domWriteCount).toBe(0);
      expect(email.value).toBe('');
    },
  );

  it.each([
    ['BAMBOOHR', 'bamboohr-application-v1'],
    ['ICIMS', 'icims-application-v1'],
    ['SMARTRECRUITERS', 'smartrecruiters-application-v1'],
    ['WORKDAY', 'workday-application-v1'],
  ] as const)('keeps candidate provider %s disabled by backend policy', async (
    atsProvider,
    pathRuleId,
  ) => {
    const value = bundle();
    const authority = createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) });
    await expect(authority.authorize({
      ...TARGET,
      atsProvider,
      pathRuleId,
    })).resolves.toEqual({ ok: false, code: 'RUNTIME_AUTHORITY_POLICY_DISABLED' });
  });
  it('missing cache and same-run bundle identity drift both fail closed', async () => {
    const value = bundle();
    const authority = createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) });
    const authorized = await authority.authorize(TARGET);
    if (!authorized.ok) throw new Error(authorized.code);

    await expect(resolveStoredExecutionRuntimeAuthority({
      stored: undefined,
      authorization: authorized.value,
      nowMs: NOW,
      extensionVersion: '1.0.0',
    })).resolves.toEqual({ ok: false, code: 'RUNTIME_AUTHORITY_UNAVAILABLE' });

    await expect(resolveStoredExecutionRuntimeAuthority({
      stored: { ...stored(value), rawBody: JSON.stringify(value) },
      authorization: authorized.value,
      nowMs: NOW,
      extensionVersion: '1.0.0',
    })).resolves.toEqual({ ok: false, code: 'RUNTIME_AUTHORITY_UNAVAILABLE' });

    await expect(resolveStoredExecutionRuntimeAuthority({
      stored: stored(value),
      authorization: {
        ...authorized.value,
        runtimeBundleVersion: `rb1_${'f'.repeat(64)}`,
      },
      nowMs: NOW,
      extensionVersion: '1.0.0',
    })).resolves.toEqual({ ok: false, code: 'RUNTIME_AUTHORITY_DRIFTED' });
  });

  it('never authorizes or revalidates from a last-known-good cache after remote failure', async () => {
    const value = bundle();
    const online = createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) });
    const initial = await online.authorize(TARGET);
    if (!initial.ok) throw new Error(initial.code);
    const refresh = vi.fn().mockResolvedValue({
      ok: true as const,
      source: 'LAST_KNOWN_GOOD' as const,
      etag: `"${value.runtimeBundleVersion}"`,
      bundle: value,
    });
    const offline = createBackgroundExecutionRuntimeAuthority({ client: { refresh } });

    await expect(offline.authorize(TARGET)).resolves.toEqual({
      ok: false,
      code: 'RUNTIME_AUTHORITY_UNAVAILABLE',
    });
    await expect(offline.authorizeDiscovery({
      atsProvider: TARGET.atsProvider,
      pathRuleId: TARGET.pathRuleId,
    })).resolves.toEqual({
      ok: false,
      code: 'RUNTIME_AUTHORITY_UNAVAILABLE',
    });
    await expect(offline.revalidate(initial.value)).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('uses a Greenhouse-only L0 profile for read-only discovery without creating write authority', async () => {
    const value = withPolicy(bundle(), {
      automationLevelCeiling: 'L0_PREVIEW_ONLY',
      allowedActions: [],
      vendors: {
        greenhouse: true,
        lever: false,
        ashby: false,
        workable: false,
        workday: false,
        icims: false,
        smartrecruiters: false,
        bamboohr: false,
        avature: false,
      },
      capabilities: {
        'set-text': false,
        'set-select': false,
        'set-combobox': false,
        'set-file': false,        'set-attestation': false,
      },
    });
    const authority = createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) });
    const discovery = await authority.authorizeDiscovery({
      atsProvider: TARGET.atsProvider,
      pathRuleId: TARGET.pathRuleId,
    });
    expect(discovery).toMatchObject({
      ok: true,
      value: { purpose: 'DISCOVERY', vendor: 'greenhouse' },
    });
    if (!discovery.ok) throw new Error(discovery.code);

    const execution = await authority.authorize(TARGET);
    expect(execution.ok).toBe(false);
    const resolved = await resolveStoredDiscoveryRuntimeAuthority({
      stored: stored(value),
      authorization: discovery.value,
      nowMs: NOW,
      extensionVersion: '1.0.0',
    });
    expect(resolved).toMatchObject({
      ok: true,
      value: {
        authorization: { purpose: 'DISCOVERY' },
        hostPolicy: {
          enabled: false,
          vendors: {
            greenhouse: false,
            lever: false,
            ashby: false,
            workable: false,
            workday: false,
            icims: false,
            smartrecruiters: false,
            bamboohr: false,
            avature: false,
          },
          capabilities: {
            'set-text': false,
            'set-select': false,
            'set-combobox': false,
            'set-file': false,            'set-attestation': false,
          },
        },
      },
    });
    if (!resolved.ok) throw new Error(resolved.code);
    await expect(resolveStoredExecutionRuntimeAuthority({
      stored: stored(value),
      authorization: discovery.value,
      nowMs: NOW,
      extensionVersion: '1.0.0',
    })).resolves.toEqual({
      ok: false,
      code: 'RUNTIME_AUTHORITY_POLICY_DISABLED',
    });

    mountGreenhouseForm();
    const outcome = await scanCurrentPageWithDiscoveryAuthority(
      resolved.value,
      document,
      {
        hostname: 'careers.acme.test',
        origin: 'https://careers.acme.test',
        pathname: '/acme/jobs/12345',
      },
      { openShadowRoot: (element) => element.shadowRoot },
    );
    expect(outcome.scan?.fieldKeys).toEqual(['email', 'firstName', 'lastName']);
    expect(outcome.scan?.runtimeAuthorization?.purpose).toBe('DISCOVERY');
  });

  /**
   * 策略没点名的键，只该让**那一栏**不写，不该让整张表消失。
   *
   * 这一条闸原先是「扫出来的键里只要有一个不在 allowedFieldKeys 里，整个扫描作废」。
   * 粒度错了，而且代价是全量的：下发的规则自己就认得出 `education.school`
   * 这类集合键，而下发的策略只列了 22 个扁平档案键——于是**任何带学历那一段的
   * 申请页都扫不出表单**，浮层报 NO_FORM_FOUND，读起来像「这一页不支持」。
   *
   * 2026-09-18 在真实 Greenhouse 页上实测到：44 个控件、规则扫出 12 个键，
   * 其中 3 个是 `education.*`，于是另外 9 个能填的也一起没了。
   *
   * 收窄成交集是**更严**而不是更松：没点名的键根本不进 `scan.fieldKeys`，
   * 于是它不进摘要、不进 claim、也不进写入面。写入那一侧本来就各自围栏
   * （mission 路按 grant.fieldKeys，手势路按 APPLY_FIELD_KEYS），这里只是别再
   * 把「有一栏不归我们管」当成「这一页没有表」。
   */
  it('策略没点名的键只是不写那一栏，不是整张表作废', async () => {
    const value = bundle();
    const authority = createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) });
    const discovery = await authority.authorizeDiscovery(TARGET);
    if (!discovery.ok) throw new Error(discovery.code);
    const resolved = await resolveStoredDiscoveryRuntimeAuthority({
      stored: stored(value),
      authorization: discovery.value,
      nowMs: NOW,
      extensionVersion: '1.0.0',
    });
    if (!resolved.ok) throw new Error(resolved.code);

    mountGreenhouseForm();
    // 策略比这一页窄一档：页面有 firstName / lastName / email，策略只点名两个。
    const narrowed = Object.freeze({
      ...resolved.value,
      allowedFieldKeys: Object.freeze(['email', 'firstName']),
    });
    const outcome = await scanCurrentPageWithDiscoveryAuthority(
      narrowed,
      document,
      {
        hostname: 'careers.acme.test',
        origin: 'https://careers.acme.test',
        pathname: '/acme/jobs/12345',
      },
      { openShadowRoot: (element) => element.shadowRoot },
    );

    expect(outcome.scan, '扫描不该因为多出一个没点名的键就整个作废').not.toBeNull();
    expect(outcome.scan?.fieldKeys).toEqual(['email', 'firstName']);
  });

  /**
   * 厂商路上整页都是雇主自定义题的那一步（2026-09-22 nvidia.wd5 第 3 步 Application Questions）：
   * 一个键都没有。从前这里判 NO_AUTHORIZED_FIELD、整页交不出去，按题干作答的逻辑（工作授权按岗位国家
   * 预填、居住地、答案记忆）一次都跑不到。手势填写（DISCOVERY）的厂商路上照样交出去，`fieldKeys` 为空——
   * 写入面仍由手势路自己的键围栏与能力位管。「有键、但策略一个都没点名」照旧停下。
   */
  it('手势填写的厂商路：整页都是没有键的自定义题 → 照样交出去，fieldKeys 为空', async () => {
    const value = bundle();
    const authority = createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) });
    const discovery = await authority.authorizeDiscovery({ atsProvider: TARGET.atsProvider, pathRuleId: TARGET.pathRuleId });
    if (!discovery.ok) throw new Error(discovery.code);
    const resolved = await resolveStoredDiscoveryRuntimeAuthority({
      stored: stored(value), authorization: discovery.value, nowMs: NOW, extensionVersion: '1.0.0',
    });
    if (!resolved.ok) throw new Error(resolved.code);
    document.body.innerHTML = `
      <form id="application-form">
        <label for="question_1">Why do you want to work at Acme?</label>
        <textarea id="question_1"></textarea>
        <label for="question_2">Describe a project you are proud of.</label>
        <textarea id="question_2"></textarea>
        <button type="submit">Submit</button>
      </form>`;
    const outcome = await scanCurrentPageWithDiscoveryAuthority(
      resolved.value,
      document,
      { hostname: 'careers.acme.test', origin: 'https://careers.acme.test', pathname: '/acme/jobs/12345' },
      { openShadowRoot: (element) => element.shadowRoot },
    );
    expect(outcome.stop, '整页没有键就判成「没有表」，按题干作答的逻辑一次都跑不到').toBeUndefined();
    expect(outcome.scan?.fieldKeys).toEqual([]);
    expect(outcome.scan?.descriptor.fields).toHaveLength(2);
  });

  it('有键、但策略一个都没点名 → 照旧停在 NO_AUTHORIZED_FIELD', async () => {
    const value = withPolicy(bundle(), { allowedFieldKeys: ['phone'] });
    const authority = createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) });
    const discovery = await authority.authorizeDiscovery({ atsProvider: TARGET.atsProvider, pathRuleId: TARGET.pathRuleId });
    if (!discovery.ok) throw new Error(discovery.code);
    const resolved = await resolveStoredDiscoveryRuntimeAuthority({
      stored: stored(value), authorization: discovery.value, nowMs: NOW, extensionVersion: '1.0.0',
    });
    if (!resolved.ok) throw new Error(resolved.code);
    mountGreenhouseForm();
    const outcome = await scanCurrentPageWithDiscoveryAuthority(
      resolved.value,
      document,
      { hostname: 'careers.acme.test', origin: 'https://careers.acme.test', pathname: '/acme/jobs/12345' },
      { openShadowRoot: (element) => element.shadowRoot },
    );
    expect(outcome.scan).toBeNull();
    expect(outcome.stop).toBe('NO_AUTHORIZED_FIELD');
  });

  it.each([
    ['www.linkedin.com', 'LOCAL_AUTOMATION_DENY'],
    ['apply.indeed.com', 'LOCAL_AUTOMATION_DENY'],
    ['smartapply.indeed.com', 'LOCAL_AUTOMATION_DENY'],
    ['www.usajobs.gov', 'PUBLIC_SECTOR'],
  ])('a verified mapping and remote empty denylist cannot inject on %s', async (hostname, refusal) => {
    const value = bundle();
    expect(value.policy.deniedHostSuffixes).toEqual([]);
    const target = { ...TARGET, canonicalOrigin: `https://${hostname}` };
    const authority = createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) });
    const execution = await authority.authorize(target);
    const discovery = await authority.authorizeDiscovery(target);
    if (!execution.ok || !discovery.ok) throw new Error('SYNTHETIC_MAPPING_UNAVAILABLE');
    const resolved = await resolveStoredExecutionRuntimeAuthority({ stored: stored(value), authorization: execution.value, nowMs: NOW, extensionVersion: '1.0.0' });
    const readOnly = await resolveStoredDiscoveryRuntimeAuthority({ stored: stored(value), authorization: discovery.value, nowMs: NOW, extensionVersion: '1.0.0' });
    if (!resolved.ok || !readOnly.ok) throw new Error('SYNTHETIC_POLICY_UNAVAILABLE');
    expect(resolved.value.policy.deniedHostSuffixes).toEqual(['linkedin.com', 'indeed.com']);
    expect(readOnly.value.hostPolicy.deniedHostSuffixes).toEqual(['linkedin.com', 'indeed.com']);
    mountGreenhouseForm();
    const loc = { hostname, origin: target.canonicalOrigin, pathname: '/acme/jobs/12345' };
    const gate = runtimeScanGate();
    const apply = await scanCurrentPageWithRuntimeAuthority(resolved.value, document, loc, gate);
    const preview = await scanCurrentPageWithDiscoveryAuthority(readOnly.value, document, loc, gate);
    expect(apply).toMatchObject({ scan: null, refusal, vendor: null });
    expect(preview).toMatchObject({ scan: null, refusal, vendor: null });
  });

  it('retains the remote denied-host suffixes in the physically write-disabled discovery policy', async () => {
    const value = withPolicy(bundle(), {
      automationLevelCeiling: 'L0_PREVIEW_ONLY',
      allowedActions: [],
      vendors: {
        greenhouse: true,
        lever: false,
        ashby: false,
        workable: false,
        workday: false,
        icims: false,
        smartrecruiters: false,
        bamboohr: false,
        avature: false,
      },
      capabilities: {
        'set-text': false,
        'set-select': false,
        'set-combobox': false,
        'set-file': false,        'set-attestation': false,
      },
      deniedHostSuffixes: ['acme.test'],
    });
    const authority = createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) });
    const discovery = await authority.authorizeDiscovery({
      atsProvider: TARGET.atsProvider,
      pathRuleId: TARGET.pathRuleId,
    });
    if (!discovery.ok) throw new Error(discovery.code);
    const resolved = await resolveStoredDiscoveryRuntimeAuthority({
      stored: stored(value),
      authorization: discovery.value,
      nowMs: NOW,
      extensionVersion: '1.0.0',
    });
    if (!resolved.ok) throw new Error(resolved.code);
    mountGreenhouseForm();
    const outcome = await scanCurrentPageWithDiscoveryAuthority(
      resolved.value,
      document,
      {
        hostname: 'careers.acme.test',
        origin: 'https://careers.acme.test',
        pathname: '/acme/jobs/12345',
      },
      { openShadowRoot: (element) => element.shadowRoot },
    );
    expect(outcome.scan).toBeNull();
    expect(outcome.refusal).toBe('REMOTE_DENYLIST');
  });

  it('remote policy is sole availability authority but cannot exceed code compatibility ceiling', async () => {
    const value = withPolicy(bundle(), {
      capabilities: {
        'set-text': true,
        'set-select': true,
        'set-combobox': true,
        'set-file': true,
        // The remote authority may request it, but installed code keeps this
        // sensitive primitive physically unavailable.
        'set-attestation': true,
      },
      minConfidence: 0,
      inferredRequiresConfirm: false,
    });
    const authority = createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) });
    const authorized = await authority.authorize(TARGET);
    if (!authorized.ok) throw new Error(authorized.code);
    const resolved = await resolveStoredExecutionRuntimeAuthority({
      stored: stored(value),
      authorization: authorized.value,
      nowMs: NOW,
      extensionVersion: '1.0.0',
    });
    if (!resolved.ok) throw new Error(resolved.code);
    expect(resolved.value.policy).toMatchObject({
      source: 'remote',
      enabled: true,
      notAfter: Date.parse(value.notAfter),
      minConfidence: 0.7,
      inferredRequiresConfirm: true,
      capabilities: { 'set-attestation': false },
    });
  });

  /**
   * 未知厂商开着，也投影不出任何东西。
   *
   * 2026-09-22 之前这条保证是在契约层用「拒整包」实现的：`policy.vendors` 里出现
   * 一个未知厂商且为 true → 整个 bundle malformed。代价是实测出来的——后端一放行
   * 新厂商，所有还没升级的商店包连同**认得的那十家**一起停掉，而商店审核 + 用户
   * 升级决定了两边永远有一段版本不一致的窗口。
   *
   * 那条闸被放开了，保证挪到这里：`remoteApplyPolicy` 按**本地已知的键集**重建
   * 策略，包里多出来的键根本不在循环里。这是比「拒整包」更准的做法——它拦的是
   * 泄漏本身，而不是拦住整份下发。
   */
  it('后端放行了这一版不认识的厂商：认得的照常授权，未知那家一个字都进不来', async () => {
    const value = withPolicy(bundle(), {
      vendors: { ...bundle().policy.vendors, paradox: true } as never,
    });
    const authority = createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) });
    // 整份没有被拖垮：认得的厂商照常拿到授权。
    const authorized = await authority.authorize(TARGET);
    if (!authorized.ok) throw new Error(authorized.code);
    const resolved = await resolveStoredExecutionRuntimeAuthority({
      stored: stored(value),
      authorization: authorized.value,
      nowMs: NOW,
      extensionVersion: '1.0.0',
    });
    if (!resolved.ok) throw new Error(resolved.code);
    expect(resolved.value.policy.vendors).toMatchObject({ greenhouse: true });
    // 而那家未知厂商在投影里**不存在**——不是 false，是根本没有这个键。
    expect(Object.keys(resolved.value.policy.vendors)).not.toContain('paradox');
  });

  it('actual pathname is only a page observation and must still satisfy the mapped remote rule', async () => {
    const value = bundle();
    const authority = createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) });
    const authorized = await authority.authorize(TARGET);
    if (!authorized.ok) throw new Error(authorized.code);
    const resolved = await resolveStoredExecutionRuntimeAuthority({
      stored: stored(value),
      authorization: authorized.value,
      nowMs: NOW,
      extensionVersion: '1.0.0',
    });
    if (!resolved.ok) throw new Error(resolved.code);
    mountGreenhouseForm();
    const outcome = await scanCurrentPageWithRuntimeAuthority(
      resolved.value,
      document,
      {
        hostname: 'careers.acme.test',
        origin: 'https://careers.acme.test',
        pathname: '/careers',
      },
      runtimeScanGate(),
    );
    expect(outcome.scan).toBeNull();
  });

  it('fails closed when production closed-shadow access is unavailable', () => {
    expect(() => openVerifiedHostShadowRoot(document.createElement('div')))
      .toThrow('SHADOW_ROOT_API_UNAVAILABLE');
    // 挂不了影子根的元素也一样：API 不在是边界验不了，不是「反正没有」。
    expect(() => openVerifiedHostShadowRoot(document.createElement('option')))
      .toThrow('SHADOW_ROOT_API_UNAVAILABLE');
  });

  it('只问挂得了影子根的元素（2026-09-23：Palantir 页上 3323 个 option 让扫描等了 12 秒）', () => {
    const asked: string[] = [];
    const shadowHost = document.createElement('x-application-form');
    const closed = shadowHost.attachShadow({ mode: 'closed' });
    const holder = globalThis as { chrome?: unknown };
    const saved = holder.chrome;
    holder.chrome = {
      dom: {
        openOrClosedShadowRoot: (element: Element) => {
          asked.push(element.localName);
          return element === shadowHost ? closed : null;
        },
      },
    };
    try {
      for (const name of ['option', 'select', 'input', 'textarea', 'label', 'li', 'a', 'button', 'td', 'img']) {
        expect(openVerifiedHostShadowRoot(document.createElement(name)), name).toBeNull();
      }
      // SVG 里的元素不在 HTML 命名空间，同样挂不了。
      expect(openVerifiedHostShadowRoot(document.createElementNS('http://www.w3.org/2000/svg', 'g'))).toBeNull();
      expect(asked, '一次都不该问').toEqual([]);
      for (const name of ['div', 'span', 'section', 'p']) openVerifiedHostShadowRoot(document.createElement(name));
      expect(openVerifiedHostShadowRoot(shadowHost), '自定义元素的闭合根照样拿得到').toBe(closed);
      expect(asked).toEqual(['div', 'span', 'section', 'p', 'x-application-form']);
    } finally {
      holder.chrome = saved;
    }
  });
});

/**
 * 远程策略的能力位投影必须带全 wire 上的十个位（P1-8b 前置，2026-09-21 查到）。
 *
 * 从前 `CODE_COMPATIBILITY_CEILING.capabilities` 只写了六个键，而 `remoteApplyPolicy` 按
 * 天花板的键重建能力表——`set-richtext / manage-rows / set-self-identification /
 * set-work-authorization` 四个位在投影里**根本不存在**，读出来是 undefined。argoland
 * 2026-09-18 已经把自我认同 / 工作授权 / 富文本跟 fill 一起放行（#513），插件这边却从来
 * 没接上：内核 2026-08-19 在 policy.ts 里踩过一模一样的坑（「那一位被整个丢掉」）。
 */
describe('远程策略投影带全十个能力位', () => {
  it('后端放行的自我认同 / 工作授权 / 富文本 / 加行进 fillPolicy；他人信息、法律确认仍被代码天花板压住', async () => {
    const value = withPolicy(bundle(), {
      capabilities: {
        'set-text': true, 'set-select': true, 'set-combobox': true, 'set-file': true,
        'set-attestation': true, 'set-richtext': true, 'manage-rows': true, 'set-other-person': true,
        'set-self-identification': true, 'set-work-authorization': true, 'set-referral': true,
      },
    });
    const authority = createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) });
    const discovery = await authority.authorizeDiscovery({
      atsProvider: TARGET.atsProvider,
      pathRuleId: TARGET.pathRuleId,
    });
    if (!discovery.ok) throw new Error(discovery.code);
    const resolved = await resolveStoredDiscoveryRuntimeAuthority({
      stored: stored(value),
      authorization: discovery.value,
      nowMs: NOW,
      extensionVersion: '1.0.0',
    });
    if (!resolved.ok) throw new Error(resolved.code);
    expect(resolved.value.fillPolicy.capabilities).toEqual({
      'set-text': true,
      'set-select': true,
      'set-combobox': true,
      'set-richtext': true,
      'manage-rows': true,
      'set-file': true,
      'set-other-person': false,
      'set-attestation': false,
      'set-self-identification': true,
      'set-work-authorization': true,
      'set-referral': true,
      // 这份包里没有这一位：缺席读作 false，不是「沿用某个默认」。
      'advance-step': false,
      // 连填（2026-09-28）同上：后端没发这一位 → 读作 false，回到每一页一颗「继续到下一页」。
      'advance-steps': false,
      // 同上：代填条款、声明与签名（2026-09-23）缺席读作 false。
      'sign-on-behalf': false,
      // 在插件里提交（2026-09-23）：后端没发这一位 → 读作 false，「提交」只提示去网站上点。
      'submit-application': false,
      // 替他注册、登录招聘网站（2026-09-28）同上：缺席读作 false，账号墙上主按钮照旧是「自动填写」。
      'account-access': false,
    });
  });

  it('worker 读这一家的写策略（账号位的第一把钥匙）：不编译规则、不签授权；填写没放行、映射对不上就是 null', async () => {
    const policyFor = async (value: ReturnType<typeof bundle>, vendor = 'greenhouse') =>
      createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) }).fillPolicyForVendor(vendor);
    const on = await policyFor(withPolicy(bundle(), { capabilities: { 'set-text': true, 'account-access': true } }));
    expect(on?.capabilities['account-access']).toBe(true);
    const off = await policyFor(withPolicy(bundle(), { capabilities: { 'set-text': true } }));
    expect(off?.capabilities['account-access']).toBe(false);
    // 这一家没放行（包里 workday: false）、认不得的厂商：null。
    expect(await policyFor(withPolicy(bundle(), { capabilities: { 'set-text': true, 'account-access': true } }), 'workday')).toBeNull();
    expect(await policyFor(bundle(), 'no-such-vendor')).toBeNull();
  });

  it('账号位（2026-09-28）：包里缺席就是关；后端明说 true 才进 fillPolicy', async () => {
    const resolve = async (capabilities: Record<string, boolean>) => {
      const value = withPolicy(bundle(), { capabilities });
      const authority = createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) });
      const discovery = await authority.authorizeDiscovery({
        atsProvider: TARGET.atsProvider,
        pathRuleId: TARGET.pathRuleId,
      });
      if (!discovery.ok) throw new Error(discovery.code);
      const resolved = await resolveStoredDiscoveryRuntimeAuthority({
        stored: stored(value),
        authorization: discovery.value,
        nowMs: NOW,
        extensionVersion: '1.0.0',
      });
      if (!resolved.ok) throw new Error(resolved.code);
      return resolved.value.fillPolicy.capabilities['account-access'];
    };
    // 旧后端（argoland 还没发这一位）：缺席就是关。
    expect(await resolve({ 'set-text': true })).toBe(false);
    expect(await resolve({ 'set-text': true, 'account-access': false })).toBe(false);
    expect(await resolve({ 'set-text': true, 'account-access': true })).toBe(true);
  });

  it('代填签署位（2026-09-23）：包里缺席就是关；后端明说 true 才进 fillPolicy', async () => {
    const resolve = async (capabilities: Record<string, boolean>) => {
      const value = withPolicy(bundle(), { capabilities });
      const authority = createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) });
      const discovery = await authority.authorizeDiscovery({
        atsProvider: TARGET.atsProvider,
        pathRuleId: TARGET.pathRuleId,
      });
      if (!discovery.ok) throw new Error(discovery.code);
      const resolved = await resolveStoredDiscoveryRuntimeAuthority({
        stored: stored(value),
        authorization: discovery.value,
        nowMs: NOW,
        extensionVersion: '1.0.0',
      });
      if (!resolved.ok) throw new Error(resolved.code);
      return resolved.value.fillPolicy.capabilities['sign-on-behalf'];
    };
    expect(await resolve({ 'set-text': true })).toBe(false);
    expect(await resolve({ 'set-text': true, 'sign-on-behalf': false })).toBe(false);
    expect(await resolve({ 'set-text': true, 'sign-on-behalf': true })).toBe(true);
  });

  it('翻页位（2026-09-22）：包里缺席就是关；后端明说 true 才进 fillPolicy', async () => {
    const resolve = async (capabilities: Record<string, boolean>) => {
      const value = withPolicy(bundle(), { capabilities });
      const authority = createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) });
      const discovery = await authority.authorizeDiscovery({
        atsProvider: TARGET.atsProvider,
        pathRuleId: TARGET.pathRuleId,
      });
      if (!discovery.ok) throw new Error(discovery.code);
      const resolved = await resolveStoredDiscoveryRuntimeAuthority({
        stored: stored(value),
        authorization: discovery.value,
        nowMs: NOW,
        extensionVersion: '1.0.0',
      });
      if (!resolved.ok) throw new Error(resolved.code);
      return resolved.value.fillPolicy.capabilities['advance-step'];
    };
    expect(await resolve({ 'set-text': true })).toBe(false);
    expect(await resolve({ 'set-text': true, 'advance-step': false })).toBe(false);
    expect(await resolve({ 'set-text': true, 'advance-step': true })).toBe(true);
  });

  it('连填位（2026-09-28）：包里缺席就是关；后端明说 true 才进 fillPolicy', async () => {
    const resolve = async (capabilities: Record<string, boolean>) => {
      const value = withPolicy(bundle(), { capabilities });
      const authority = createBackgroundExecutionRuntimeAuthority({ client: clientFor(value) });
      const discovery = await authority.authorizeDiscovery({
        atsProvider: TARGET.atsProvider,
        pathRuleId: TARGET.pathRuleId,
      });
      if (!discovery.ok) throw new Error(discovery.code);
      const resolved = await resolveStoredDiscoveryRuntimeAuthority({
        stored: stored(value),
        authorization: discovery.value,
        nowMs: NOW,
        extensionVersion: '1.0.0',
      });
      if (!resolved.ok) throw new Error(resolved.code);
      return resolved.value.fillPolicy.capabilities['advance-steps'];
    };
    // 旧后端（argoland 还没发这一位）：缺席就是关，连填不开，回到每一页一颗「继续到下一页」。
    expect(await resolve({ 'set-text': true, 'advance-step': true })).toBe(false);
    expect(await resolve({ 'set-text': true, 'advance-step': true, 'advance-steps': false })).toBe(false);
    expect(await resolve({ 'set-text': true, 'advance-step': true, 'advance-steps': true })).toBe(true);
  });
});
