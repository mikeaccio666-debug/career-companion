import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KERNEL_BRIDGE_PORT_NAME } from '../lib/bridgeProtocol';
import type { ContentBridgeDeps } from '../lib/contentBridge';
import type { RuntimeExecutionAuthorization } from '../lib/executionRuntimeAuthority';
import { EXECUTION_RUNTIME_BUNDLE_STORAGE_KEY } from '../lib/executionRuntimeBundleStore';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();


const wiring = vi.hoisted(() => ({
  addConnectListener: vi.fn(),
  addPageHideListener: vi.fn(),
  addStorageChangedListener: vi.fn(),
  getManifest: vi.fn(),
  getStorage: vi.fn(),
  handleKernelBridgePort: vi.fn(),
  fillFromGrant: vi.fn(),
  installScanMutationThrottle: vi.fn(),
  invalidateRetainedContentScan: vi.fn(),
  invalidateRetainedContentScanState: vi.fn(),
  noticeForRescan: vi.fn(),
  addNativeSubmissionActivationListener: vi.fn(),
  addExactReviewInvalidationListener: vi.fn(),
  addSubmissionEventListener: vi.fn(),
  installEarlySubmissionCaptureBroker: vi.fn(),
  captureExactFormValueSeal: vi.fn(),
  createSubmissionGestureGate: vi.fn(),
  resolveScanRootMutationPolicy: vi.fn(),
  resolveFinalSubmissionTarget: vi.fn(),
  resolveStoredExecutionRuntimeAuthority: vi.fn(),
  scanCurrentPageWithRuntimeAuthority: vi.fn(),
  sendMessage: vi.fn(() => Promise.resolve()),
  showAuditPanel: vi.fn(),
}));

const dockWiring = vi.hoisted(() => {
  const handles: Array<{ face: () => string; faceKey: () => string; hasFocus: () => boolean; dismiss: ReturnType<typeof vi.fn> }> = [];
  const mount = vi.fn((face: { kind: string; reason?: string }, handlers: unknown) => {
    // 与真句柄同一把尺：kind 加上 UNAVAILABLE 的 reason（见 affordanceFaceKey）。
    const handle = { face: () => face.kind, faceKey: () => (face.kind === 'UNAVAILABLE' ? `${face.kind}:${face.reason}` : face.kind), isOpen: () => true, hasFocus: () => false, dismiss: vi.fn(), setNotice: vi.fn(), handlers };
    handles.push(handle);
    return handle;
  });
  return { mount, handles };
});
vi.mock('wxt/utils/define-content-script', () => ({
  defineContentScript: <T>(config: T): T => config,
}));
vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      // 连着的扩展上下文总有 id（插件更新之后的孤儿页上才是 undefined，内容脚本据此不再报到）。
      id: 'test-extension',
      getManifest: wiring.getManifest,
      onConnect: { addListener: wiring.addConnectListener },
      onMessage: { addListener: vi.fn() },
      sendMessage: wiring.sendMessage,
    },
    storage: {
      local: { get: wiring.getStorage },
      onChanged: { addListener: wiring.addStorageChangedListener },
    },
  },
}));
vi.mock('../lib/autofillDock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/autofillDock')>();
  return { ...actual, mountAutofillDock: dockWiring.mount };
});
vi.mock('../lib/contentBridge', () => ({
  handleKernelBridgePort: wiring.handleKernelBridgePort,
  invalidateRetainedContentScan: wiring.invalidateRetainedContentScan,
  invalidateRetainedContentScanState: wiring.invalidateRetainedContentScanState,
}));
vi.mock('../lib/executionRuntimeAuthority', () => ({
  resolveStoredExecutionRuntimeAuthority: wiring.resolveStoredExecutionRuntimeAuthority,
}));
vi.mock('../lib/kernelScanner', () => ({
  openVerifiedHostShadowRoot: vi.fn(),
  scanCurrentPageWithRuntimeAuthority: async (...args: unknown[]) => {
    const outcome = await wiring.scanCurrentPageWithRuntimeAuthority(...args);
    const gate = args[3] as Readonly<{
      armMutationGuard?: (policy: unknown) => Readonly<{
        isCurrent: () => boolean;
        dispose: () => void;
      }> | null;
    }> | undefined;
    if (!outcome?.scan || !gate?.armMutationGuard) return outcome;
    const policy = wiring.resolveScanRootMutationPolicy(outcome.scan.descriptor.root);
    const guard = gate.armMutationGuard(policy);
    if (guard?.isCurrent() === true) return outcome;
    guard?.dispose();
    return { ...outcome, scan: null };
  },
}));
vi.mock('../lib/kernelFiller', () => ({ fillFromGrant: wiring.fillFromGrant }));
vi.mock('../lib/auditPanel', () => ({ showAuditPanel: wiring.showAuditPanel }));
vi.mock('../lib/rescanNotice', () => ({ noticeForRescan: wiring.noticeForRescan }));
vi.mock('../lib/scanMutationThrottle', () => ({
  installScanMutationThrottle: wiring.installScanMutationThrottle,
}));
vi.mock('../lib/submissionGestureGate', () => ({
  addNativeSubmissionActivationListener: wiring.addNativeSubmissionActivationListener,
  addExactReviewInvalidationListener: wiring.addExactReviewInvalidationListener,
  addSubmissionEventListener: wiring.addSubmissionEventListener,
  captureExactFormValueSeal: wiring.captureExactFormValueSeal,
  createSubmissionGestureGate: wiring.createSubmissionGestureGate,
  installEarlySubmissionCaptureBroker: wiring.installEarlySubmissionCaptureBroker,
  resolveFinalSubmissionTarget: wiring.resolveFinalSubmissionTarget,
}));
vi.mock('@edaix/apply-kernel/scanRoot', () => ({
  resolveScanRootMutationPolicy: wiring.resolveScanRootMutationPolicy,
}));

const background = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');
const content = readFileSync(new URL('../entrypoints/apply.content.ts', import.meta.url), 'utf8');
const gestureGate = readFileSync(new URL('../lib/submissionGestureGate.ts', import.meta.url), 'utf8');

beforeEach(() => {
  vi.clearAllMocks();
  const frame = Object.freeze({});
  vi.stubGlobal('window', {
    top: frame,
    self: frame,
    addEventListener: wiring.addPageHideListener,
  });
  vi.stubGlobal('document', Object.freeze({}));
  vi.stubGlobal('location', {
    hostname: 'boards.greenhouse.io',
    origin: 'https://boards.greenhouse.io',
    pathname: '/jobs/123',
    search: '',
  });
  wiring.getManifest.mockReturnValue({ version: '1.0.0' });
  wiring.getStorage.mockResolvedValue({});
  wiring.fillFromGrant.mockResolvedValue([]);
  wiring.showAuditPanel.mockReturnValue({ dismiss: vi.fn(), shadowRoot: null });
  wiring.installScanMutationThrottle.mockReturnValue({ dispose: vi.fn() });
  wiring.addNativeSubmissionActivationListener.mockReturnValue(vi.fn());
  wiring.addSubmissionEventListener.mockReturnValue(vi.fn());
  wiring.addExactReviewInvalidationListener.mockReturnValue(vi.fn());
  wiring.installEarlySubmissionCaptureBroker.mockReturnValue({
    addActivationListener: (target: unknown, listener: unknown) =>
      wiring.addNativeSubmissionActivationListener(target, listener),
    addSubmitListener: (target: unknown, listener: unknown) =>
      wiring.addSubmissionEventListener(target, listener),
    dispose: vi.fn(),
  });
  wiring.invalidateRetainedContentScan.mockReturnValue(true);
  wiring.resolveScanRootMutationPolicy.mockReturnValue({
    targets: [document],
    observerOptions: {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    },
    isCurrent: () => true,
    isExecutionCurrent: () => true,
    isRelevant: () => true,
  });
  wiring.captureExactFormValueSeal.mockReturnValue(Object.freeze({ isCurrent: () => true }));
  const exactElement = Object.freeze({
    ownerDocument: document,
    getRootNode: () => document,
  });
  const exactForm = Object.freeze({
    ownerDocument: document,
    getRootNode: () => document,
  });
  wiring.resolveFinalSubmissionTarget.mockReturnValue(Object.freeze({
    activation: 'native-submit',
    element: exactElement,
    form: exactForm,
    isCurrent: () => true,
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('T11 production entrypoint wiring', () => {
  it('retires all retained execution state when the local runtime bundle changes or is deleted', async () => {
    const { default: contentEntrypoint } = await import('../entrypoints/apply.content');
    (contentEntrypoint as unknown as { main: () => void }).main();

    const listener = wiring.addStorageChangedListener.mock.calls.at(-1)?.[0] as
      | ((changes: Record<string, unknown>, areaName: string) => void)
      | undefined;
    expect(listener).toBeTypeOf('function');

    listener?.({ unrelated: { newValue: true } }, 'local');
    listener?.({ [EXECUTION_RUNTIME_BUNDLE_STORAGE_KEY]: { newValue: undefined } }, 'sync');
    expect(wiring.invalidateRetainedContentScanState).not.toHaveBeenCalled();

    listener?.({ [EXECUTION_RUNTIME_BUNDLE_STORAGE_KEY]: { newValue: undefined } }, 'local');
    expect(wiring.invalidateRetainedContentScanState).toHaveBeenCalledOnce();
  });

  it('background owns durable runtime recovery, exact authority resolution, and the tab arm seam', () => {
    expect(background).toContain('createSubmissionBoundaryRuntime');
    expect(background).toContain('createSubmissionBoundaryClient');
    expect(background).toContain('createMissionSubmissionAuthorityClient');
    expect(background).toContain('parseSubmissionRuntimeMessage');
    expect(background).toContain('prepareSubmissionArm');
    expect(background).toContain('submissionBoundaryRuntime.recover()');
    expect(background).toContain('browser.storage.local');
    expect(background).toContain("'t11SubmissionBoundaryStateV2'");
    expect(background).toContain("'t11SubmissionBoundaryStateV1'");
    expect(background).toContain('stored[LEGACY_SUBMISSION_BOUNDARY_STORAGE_KEY]');
    expect(background).toContain('browser.storage.local.remove(LEGACY_SUBMISSION_BOUNDARY_STORAGE_KEY)');
  });

  it('content installs the capture-phase user gesture gate without ever submitting for the user', () => {
    expect(content).toContain('createSubmissionGestureGate');
    expect(content).toContain('installEarlySubmissionCaptureBroker(window, document)');
    expect(content).toContain("runAt: 'document_start'");
    expect(content).toContain('earlySubmissionCapture.addSubmitListener(target');
    expect(content).toContain('earlySubmissionCapture.addActivationListener(target');
    expect(content).toContain("installSubmissionGate({ mode: 'BLOCKED' }, input.scan, 'fill-window')");
    expect(content).toContain('enforceHostSubmissionContainmentPolicy(runtime.policy, {');
    expect(content).toContain("from '../lib/hostWriteContainment'");
    expect(content).not.toContain("document.addEventListener('submit'");
    expect(content).toContain('armSubmission');
    expect(`${content}\n${gestureGate}`).not.toMatch(/\.(?:submit|requestSubmit|click)\s*\(/);
  });

  it('routes every live rescan outcome through the current-facts notice helper', () => {
    const expectCurrentRescanWiring = (source: string) => {
      expect(source).toContain("import { noticeForRescan } from '../lib/rescanNotice'");
      expect(source).toMatch(
        /async function scanWithAuthorizedRuntime\([\s\S]*?const runtime\s*=\s*await resolveExecutionRuntime\(authorization\);[\s\S]*?return scanCurrentPageWithRuntimeAuthority\(/,
      );
      const scanWiring = source.match(/scan:\s*async[\s\S]*?\n\s*fill:/)?.[0] ?? '';
      expect(scanWiring).toMatch(
        /const outcome\s*=\s*await scanWithAuthorizedRuntime\([\s\S]*?const scan\s*=\s*noticeForRescan\(outcome\)/,
      );
      expect(scanWiring).not.toMatch(/gate\.vendor|gateRefusal\s*:\s*null|classifySiteSupport/);
    };

    expectCurrentRescanWiring(content);
    const staleMutation = content.replace('noticeForRescan(', 'classifySiteSupport(');
    expect(() => expectCurrentRescanWiring(staleMutation)).toThrow();
  });

  it('executes the real production scan dependency through authorized current facts', async () => {
    const noticeScan = Object.freeze({
      marker: 'notice-scan',
      scanDigest: `sha256:${'4'.repeat(64)}`,
      descriptor: Object.freeze({ root: Object.freeze({}) }),
    });
    const currentOutcome = Object.freeze({
      scan: noticeScan,
      refusal: null,
      vendor: 'greenhouse',
    });
    const runtimeAuthority = Object.freeze({ marker: 'runtime-authority' });
    const authorization: RuntimeExecutionAuthorization = Object.freeze({
      schemaVersion: 1,
      purpose: 'EXECUTION',
      runtimeBundleVersion: 'runtime-1.0.0',
      releaseRevision: '1',
      policyVersion: 'policy-1.0.0',
      rulesReleaseVersion: 'rules-1.0.0',
      rulesReleaseDigest: 'sha256:rules',
      atsProvider: 'GREENHOUSE',
      pathRuleId: 'greenhouse-job',
      vendor: 'greenhouse',
      rulesetVersion: 'greenhouse-1.0.0',
      rulesetDigest: 'sha256:greenhouse',
    });
    wiring.resolveStoredExecutionRuntimeAuthority.mockResolvedValue({
      ok: true,
      value: runtimeAuthority,
    });
    wiring.scanCurrentPageWithRuntimeAuthority.mockResolvedValue(currentOutcome);
    wiring.noticeForRescan.mockReturnValue(noticeScan);

    let connect: ((port: Readonly<{ name: string }>) => void) | undefined;
    wiring.addConnectListener.mockImplementation((listener) => {
      connect = listener as typeof connect;
    });

    const { default: contentEntrypoint } = await import('../entrypoints/apply.content');
    (contentEntrypoint as unknown as { main: () => void }).main();
    expect(connect).toBeTypeOf('function');

    connect?.({ name: KERNEL_BRIDGE_PORT_NAME });
    expect(wiring.handleKernelBridgePort).toHaveBeenCalledTimes(1);
    const deps = wiring.handleKernelBridgePort.mock.calls[0]?.[1] as ContentBridgeDeps;

    await expect(deps.scan(authorization)).resolves.toBe(noticeScan);
    expect(wiring.resolveStoredExecutionRuntimeAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ authorization, extensionVersion: '1.0.0' }),
    );
    expect(wiring.scanCurrentPageWithRuntimeAuthority).toHaveBeenCalledWith(
      runtimeAuthority,
      document,
      location,
      expect.objectContaining({
        armMutationGuard: expect.any(Function),
        isTopFrame: true,
      }),
    );
    expect(wiring.noticeForRescan).toHaveBeenCalledWith(currentOutcome);
    expect(wiring.installScanMutationThrottle).toHaveBeenCalledTimes(1);
    const installed = wiring.installScanMutationThrottle.mock.calls[0]?.[0] as {
      onInvalidate: () => void;
      policy: Readonly<{ targets: readonly Node[] }>;
    };
    expect(wiring.resolveScanRootMutationPolicy).toHaveBeenCalledWith(noticeScan.descriptor.root);
    expect(installed.policy.targets).toEqual([document]);
    const scannerCallsBeforeMutation = wiring.scanCurrentPageWithRuntimeAuthority.mock.calls.length;
    installed.onInvalidate();
    expect(wiring.invalidateRetainedContentScan).toHaveBeenCalledWith(noticeScan);
    expect(wiring.scanCurrentPageWithRuntimeAuthority).toHaveBeenCalledTimes(scannerCallsBeforeMutation);

    const exactScanTarget = {
      canonicalOrigin: location.origin,
      jobId: location.pathname,
    } as Parameters<ContentBridgeDeps['isCurrentScanTarget']>[0];
    expect(deps.isCurrentScanTarget(exactScanTarget)).toBe(true);

    const scannerCallCount = wiring.scanCurrentPageWithRuntimeAuthority.mock.calls.length;
    location.pathname = '/jobs/456';
    expect(deps.isCurrentScanTarget(exactScanTarget)).toBe(false);
    await expect(deps.revalidateScan(exactScanTarget, authorization)).resolves.toBeNull();
    expect(wiring.scanCurrentPageWithRuntimeAuthority).toHaveBeenCalledTimes(scannerCallCount);
  });

  it('never installs a mutation observer before a verified scan and disposes it on later authority failure', async () => {
    const authorization = Object.freeze({
      schemaVersion: 1,
      purpose: 'EXECUTION',
      runtimeBundleVersion: 'runtime-1.0.0',
      releaseRevision: '1',
      policyVersion: 'policy-1.0.0',
      rulesReleaseVersion: 'rules-1.0.0',
      rulesReleaseDigest: 'sha256:rules',
      atsProvider: 'GREENHOUSE',
      pathRuleId: 'greenhouse-job',
      vendor: 'greenhouse',
      rulesetVersion: 'greenhouse-1.0.0',
      rulesetDigest: 'sha256:greenhouse',
    }) as RuntimeExecutionAuthorization;
    const watcher = { dispose: vi.fn() };
    wiring.installScanMutationThrottle.mockReturnValue(watcher);
    wiring.resolveStoredExecutionRuntimeAuthority.mockResolvedValueOnce({
      ok: true,
      value: Object.freeze({ marker: 'runtime-authority' }),
    });
    wiring.scanCurrentPageWithRuntimeAuthority.mockResolvedValue({
      scan: Object.freeze({
        scanDigest: `sha256:${'5'.repeat(64)}`,
        descriptor: Object.freeze({ root: Object.freeze({}) }),
      }),
      refusal: null,
      vendor: 'greenhouse',
    });
    wiring.noticeForRescan.mockReturnValue(Object.freeze({
      scanDigest: `sha256:${'5'.repeat(64)}`,
      descriptor: Object.freeze({ root: Object.freeze({}) }),
    }));

    let connect: ((port: Readonly<{ name: string }>) => void) | undefined;
    wiring.addConnectListener.mockImplementation((listener) => {
      connect = listener as typeof connect;
    });
    const { default: contentEntrypoint } = await import('../entrypoints/apply.content');
    (contentEntrypoint as unknown as { main: () => void }).main();
    connect?.({ name: KERNEL_BRIDGE_PORT_NAME });
    const deps = wiring.handleKernelBridgePort.mock.calls[0]?.[1] as ContentBridgeDeps;

    expect(wiring.installScanMutationThrottle).not.toHaveBeenCalled();
    await expect(deps.scan(authorization)).resolves.not.toBeNull();
    expect(wiring.installScanMutationThrottle).toHaveBeenCalledTimes(1);

    wiring.resolveStoredExecutionRuntimeAuthority.mockResolvedValueOnce({
      ok: false,
      error: 'RUNTIME_AUTHORITY_UNAVAILABLE',
    });
    await expect(deps.scan(authorization)).resolves.toBeNull();
    expect(watcher.dispose).toHaveBeenCalledTimes(1);
    expect(wiring.installScanMutationThrottle).toHaveBeenCalledTimes(1);
  });

  it('mutation invalidation disposes the submission gesture gate bound to that scan', async () => {
    const scan = Object.freeze({
      canonicalOrigin: location.origin,
      jobId: location.pathname,
      fieldKeys: Object.freeze([]),
      scanDigest: `sha256:${'9'.repeat(64)}`,
      descriptor: Object.freeze({ root: Object.freeze({}) }),
    });
    const authorization = Object.freeze({
      schemaVersion: 1,
      purpose: 'EXECUTION',
    }) as RuntimeExecutionAuthorization;
    const targetForm = Object.freeze({
      marker: 'exact-form',
      ownerDocument: document,
      getRootNode: () => document,
    }) as unknown as HTMLFormElement;
    const target = Object.freeze({
      activation: 'native-submit' as const,
      form: targetForm,
      element: Object.freeze({
        marker: 'exact-control',
        ownerDocument: document,
        getRootNode: () => document,
      }),
      isCurrent: () => true,
    });
    wiring.resolveFinalSubmissionTarget.mockReturnValue(target);
    const gate = { dispose: vi.fn(), retireToBlockedTombstone: vi.fn() };
    wiring.createSubmissionGestureGate.mockReturnValue(gate);
    wiring.resolveStoredExecutionRuntimeAuthority.mockResolvedValue({
      ok: true,
      value: Object.freeze({ marker: 'runtime-authority' }),
    });
    wiring.scanCurrentPageWithRuntimeAuthority.mockResolvedValue({
      scan,
      refusal: null,
      vendor: 'greenhouse',
    });
    wiring.noticeForRescan.mockReturnValue(scan);

    let connect: ((port: Readonly<{ name: string }>) => void) | undefined;
    wiring.addConnectListener.mockImplementation((listener) => {
      connect = listener as typeof connect;
    });
    const { default: contentEntrypoint } = await import('../entrypoints/apply.content');
    (contentEntrypoint as unknown as { main: () => void }).main();
    connect?.({ name: KERNEL_BRIDGE_PORT_NAME });
    const deps = wiring.handleKernelBridgePort.mock.calls[0]?.[1] as ContentBridgeDeps;
    await expect(deps.scan(authorization)).resolves.toBe(scan);

    const armSubmission = deps.armSubmission;
    expect(armSubmission).toBeTypeOf('function');
    expect(armSubmission?.(
      {} as Parameters<NonNullable<ContentBridgeDeps['armSubmission']>>[0],
      scan as unknown as Parameters<NonNullable<ContentBridgeDeps['armSubmission']>>[1],
    )).toBe(true);
    const gateInput = wiring.createSubmissionGestureGate.mock.calls.at(-1)?.[0] as Readonly<{
      addActivationListener: (listener: (event: Event) => void) => () => void;
      addReviewInvalidationListener: (listener: () => void) => () => void;
    }>;
    const observeNativeSubmit = vi.fn();
    const removeNativeSubmit = vi.fn();
    wiring.addNativeSubmissionActivationListener.mockReturnValueOnce(removeNativeSubmit);
    expect(gateInput.addActivationListener(observeNativeSubmit)).toBe(removeNativeSubmit);
    expect(wiring.addNativeSubmissionActivationListener).toHaveBeenCalledWith(
      target,
      observeNativeSubmit,
    );
    const invalidateReview = vi.fn();
    const removeInvalidation = vi.fn();
    wiring.addExactReviewInvalidationListener.mockReturnValueOnce(removeInvalidation);
    expect(gateInput.addReviewInvalidationListener(invalidateReview)).toBe(removeInvalidation);
    expect(wiring.addExactReviewInvalidationListener).toHaveBeenCalledWith(
      targetForm,
      expect.any(Function),
    );
    const onValueDrift = wiring.addExactReviewInvalidationListener.mock.calls.at(-1)?.[1] as
      | (() => void)
      | undefined;
    expect(onValueDrift).toBeTypeOf('function');
    onValueDrift?.();
    expect(gate.retireToBlockedTombstone).toHaveBeenCalledOnce();
    expect(wiring.invalidateRetainedContentScan).toHaveBeenCalledWith(scan);
    const observerInput = wiring.installScanMutationThrottle.mock.calls[0]?.[0] as {
      onInvalidate: () => void;
    };
    observerInput.onInvalidate();
    expect(gate.retireToBlockedTombstone).toHaveBeenCalledTimes(1);
  });

  it('keeps the old submit blocker through revalidation, then rearms the exact refreshed generation', async () => {
    const root = Object.freeze({});
    const firstScan = Object.freeze({
      canonicalOrigin: location.origin,
      jobId: location.pathname,
      fieldKeys: Object.freeze(['email']),
      scanDigest: `sha256:${'a'.repeat(64)}`,
      descriptor: Object.freeze({ root }),
    });
    const refreshedScan = Object.freeze({
      ...firstScan,
      descriptor: Object.freeze({ root }),
    });
    const authorization = Object.freeze({
      schemaVersion: 1,
      purpose: 'EXECUTION',
    }) as RuntimeExecutionAuthorization;
    const runtime = Object.freeze({
      allowedActions: Object.freeze(['FILL']),
      allowedFieldKeys: Object.freeze(['email']),
      policy: Object.freeze({}),
    });
    const firstGate = {
      dispose: vi.fn(),
      revokeFinalReview: vi.fn(),
      retireToBlockedTombstone: vi.fn(),
      canConfirmFinalReview: vi.fn(() => false),
      confirmFinalReview: vi.fn(async () => false),
      onFinalReviewStateChange: vi.fn(() => vi.fn()),
    };
    const refreshedGate = {
      dispose: vi.fn(),
      revokeFinalReview: vi.fn(),
      retireToBlockedTombstone: vi.fn(),
      canConfirmFinalReview: vi.fn(() => true),
      confirmFinalReview: vi.fn(async () => true),
      onFinalReviewStateChange: vi.fn(() => vi.fn()),
    };
    wiring.createSubmissionGestureGate
      .mockReturnValueOnce(firstGate)
      .mockReturnValueOnce(refreshedGate);
    wiring.resolveStoredExecutionRuntimeAuthority.mockResolvedValue({ ok: true, value: runtime });
    wiring.scanCurrentPageWithRuntimeAuthority
      .mockResolvedValueOnce({ scan: firstScan, refusal: null, vendor: 'greenhouse' })
      .mockResolvedValueOnce({ scan: refreshedScan, refusal: null, vendor: 'greenhouse' });
    wiring.noticeForRescan.mockReturnValue(firstScan);
    const firstObserver = { dispose: vi.fn() };
    const refreshedObserver = { dispose: vi.fn() };
    wiring.installScanMutationThrottle
      .mockReturnValueOnce(firstObserver)
      .mockReturnValueOnce(refreshedObserver);

    let connect: ((port: Readonly<{ name: string }>) => void) | undefined;
    wiring.addConnectListener.mockImplementation((listener) => {
      connect = listener as typeof connect;
    });
    const { default: contentEntrypoint } = await import('../entrypoints/apply.content');
    (contentEntrypoint as unknown as { main: () => void }).main();
    connect?.({ name: KERNEL_BRIDGE_PORT_NAME });
    const deps = wiring.handleKernelBridgePort.mock.calls[0]?.[1] as ContentBridgeDeps;

    await expect(deps.scan(authorization)).resolves.toBe(firstScan);
    const descriptor = Object.freeze({ mode: 'ACTIVE' }) as Parameters<
      NonNullable<ContentBridgeDeps['armSubmission']>
    >[0];
    expect(deps.armSubmission?.(
      descriptor,
      firstScan as unknown as Parameters<NonNullable<ContentBridgeDeps['armSubmission']>>[1],
    )).toBe(true);

    const candidate = await deps.revalidateScan(
      firstScan as unknown as Parameters<ContentBridgeDeps['revalidateScan']>[0],
      authorization,
    );
    expect(candidate?.scan).toBe(refreshedScan);
    expect(firstGate.retireToBlockedTombstone).toHaveBeenCalledOnce();
    expect(firstGate.dispose).not.toHaveBeenCalled();
    expect(firstObserver.dispose).toHaveBeenCalledOnce();

    expect(candidate?.activate()).toBe(true);
    expect(firstGate.dispose).toHaveBeenCalledOnce();
    expect(wiring.createSubmissionGestureGate).toHaveBeenCalledTimes(2);
    expect(wiring.createSubmissionGestureGate.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ descriptor }),
    );

    const audit = {
      view: {
        rows: [{ marker: 'row' }],
        filled: 1,
        requiredTotal: 0,
        requiredHandled: 0,
        needsAttention: 0,
        blockedByUs: 0,
        awaitingUser: 0,
      },
      canUndo: () => false,
      undoAll: vi.fn(),
    };
    wiring.fillFromGrant.mockImplementation(async (input) => {
      input.onAudit?.(audit);
      return [];
    });
    await deps.fill({
      grant: { allowedActions: ['FILL'], fieldKeys: ['email'] },
      scan: refreshedScan,
      profile: {},
      progress: { onOutcome: vi.fn(), shouldStop: () => false },
      runtimeAuthorization: authorization,
    } as unknown as Parameters<ContentBridgeDeps['fill']>[0]);
    expect(refreshedGate.revokeFinalReview).toHaveBeenCalledOnce();
    const handlers = wiring.showAuditPanel.mock.calls.at(-1)?.[1] as Readonly<{
      canConfirmFinalReview: () => boolean;
      confirmFinalReview: (event: Event, root: ShadowRoot) => Promise<boolean>;
    }>;
    expect(handlers.canConfirmFinalReview()).toBe(true);
    const event = Object.freeze({}) as Event;
    const shadow = Object.freeze({}) as ShadowRoot;
    await expect(handlers.confirmFinalReview(event, shadow)).resolves.toBe(true);
    expect(refreshedGate.confirmFinalReview).toHaveBeenCalledWith(event, shadow);
    expect(firstGate.confirmFinalReview).not.toHaveBeenCalled();
  });

  it('fails candidate activation closed when the refreshed generation cannot be rearmed', async () => {
    const scan = Object.freeze({
      canonicalOrigin: location.origin,
      jobId: location.pathname,
      fieldKeys: Object.freeze([]),
      scanDigest: `sha256:${'b'.repeat(64)}`,
      descriptor: Object.freeze({ root: Object.freeze({}) }),
    });
    const refreshed = Object.freeze({ ...scan, descriptor: scan.descriptor });
    const authorization = Object.freeze({
      schemaVersion: 1,
      purpose: 'EXECUTION',
    }) as RuntimeExecutionAuthorization;
    const gate = {
      dispose: vi.fn(),
      revokeFinalReview: vi.fn(),
      retireToBlockedTombstone: vi.fn(),
      canConfirmFinalReview: vi.fn(() => false),
      confirmFinalReview: vi.fn(async () => false),
      onFinalReviewStateChange: vi.fn(() => vi.fn()),
    };
    wiring.createSubmissionGestureGate.mockReturnValue(gate);
    wiring.resolveStoredExecutionRuntimeAuthority.mockResolvedValue({
      ok: true,
      value: Object.freeze({ marker: 'runtime' }),
    });
    wiring.scanCurrentPageWithRuntimeAuthority
      .mockResolvedValueOnce({ scan, refusal: null, vendor: 'greenhouse' })
      .mockResolvedValueOnce({ scan: refreshed, refusal: null, vendor: 'greenhouse' });
    wiring.noticeForRescan.mockReturnValue(scan);

    let connect: ((port: Readonly<{ name: string }>) => void) | undefined;
    wiring.addConnectListener.mockImplementation((listener) => {
      connect = listener as typeof connect;
    });
    const { default: contentEntrypoint } = await import('../entrypoints/apply.content');
    (contentEntrypoint as unknown as { main: () => void }).main();
    connect?.({ name: KERNEL_BRIDGE_PORT_NAME });
    const deps = wiring.handleKernelBridgePort.mock.calls[0]?.[1] as ContentBridgeDeps;
    await deps.scan(authorization);
    expect(deps.armSubmission?.(
      {} as never,
      scan as unknown as Parameters<NonNullable<ContentBridgeDeps['armSubmission']>>[1],
    )).toBe(true);
    const candidate = await deps.revalidateScan(
      scan as unknown as Parameters<ContentBridgeDeps['revalidateScan']>[0],
      authorization,
    );
    wiring.resolveFinalSubmissionTarget.mockReturnValueOnce(null);

    expect(candidate?.activate()).toBe(false);
    expect(gate.retireToBlockedTombstone).toHaveBeenCalled();
    expect(gate.dispose).not.toHaveBeenCalled();
    expect(wiring.invalidateRetainedContentScan).toHaveBeenCalledWith(refreshed);
  });

  it('retires review authority at the exact remote bundle freshness boundary', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-08-24T12:00:00.000Z');
    vi.setSystemTime(now);
    const authorization = Object.freeze({
      schemaVersion: 1,
      purpose: 'EXECUTION',
    }) as RuntimeExecutionAuthorization;
    const scan = Object.freeze({
      canonicalOrigin: location.origin,
      jobId: location.pathname,
      fieldKeys: Object.freeze([]),
      scanDigest: `sha256:${'e'.repeat(64)}`,
      descriptor: Object.freeze({ root: Object.freeze({}) }),
      runtimeAuthorization: authorization,
      runtimeFreshUntilMs: now + 1_000,
      runtimeNotAfterMs: now + 10_000,
    });
    const gate = {
      dispose: vi.fn(),
      retireToBlockedTombstone: vi.fn(),
    };
    wiring.createSubmissionGestureGate.mockReturnValue(gate);
    wiring.resolveStoredExecutionRuntimeAuthority.mockResolvedValue({
      ok: true,
      value: Object.freeze({ marker: 'runtime' }),
    });
    wiring.scanCurrentPageWithRuntimeAuthority.mockResolvedValue({
      scan,
      refusal: null,
      vendor: 'greenhouse',
    });
    wiring.noticeForRescan.mockReturnValue(scan);

    let connect: ((port: Readonly<{ name: string }>) => void) | undefined;
    wiring.addConnectListener.mockImplementation((listener) => {
      connect = listener as typeof connect;
    });
    const { default: contentEntrypoint } = await import('../entrypoints/apply.content');
    (contentEntrypoint as unknown as { main: () => void }).main();
    connect?.({ name: KERNEL_BRIDGE_PORT_NAME });
    const deps = wiring.handleKernelBridgePort.mock.calls[0]?.[1] as ContentBridgeDeps;
    await expect(deps.scan(authorization)).resolves.toBe(scan);
    expect(deps.armSubmission?.(
      {} as never,
      scan as unknown as Parameters<NonNullable<ContentBridgeDeps['armSubmission']>>[1],
    )).toBe(true);
    const gateInput = wiring.createSubmissionGestureGate.mock.calls.at(-1)?.[0] as Readonly<{
      isStillAuthorized: () => boolean;
    }>;
    expect(gateInput.isStillAuthorized()).toBe(true);

    vi.setSystemTime(now + 1_000);
    expect(gateInput.isStillAuthorized()).toBe(false);
    expect(gate.retireToBlockedTombstone).toHaveBeenCalledOnce();
  });

  it('retains the fail-closed tombstone when revalidation rejects before a candidate exists', async () => {
    const scan = Object.freeze({
      canonicalOrigin: location.origin,
      jobId: location.pathname,
      fieldKeys: Object.freeze([]),
      scanDigest: `sha256:${'c'.repeat(64)}`,
      descriptor: Object.freeze({ root: Object.freeze({}) }),
    });
    const authorization = Object.freeze({
      schemaVersion: 1,
      purpose: 'EXECUTION',
    }) as RuntimeExecutionAuthorization;
    const gate = {
      dispose: vi.fn(),
      revokeFinalReview: vi.fn(),
      retireToBlockedTombstone: vi.fn(),
      canConfirmFinalReview: vi.fn(() => false),
      confirmFinalReview: vi.fn(async () => false),
      onFinalReviewStateChange: vi.fn(() => vi.fn()),
    };
    wiring.createSubmissionGestureGate.mockReturnValue(gate);
    wiring.resolveStoredExecutionRuntimeAuthority
      .mockResolvedValueOnce({ ok: true, value: Object.freeze({ marker: 'runtime' }) })
      .mockResolvedValueOnce({ ok: false, error: 'RUNTIME_AUTHORITY_UNAVAILABLE' });
    wiring.scanCurrentPageWithRuntimeAuthority.mockResolvedValue({
      scan,
      refusal: null,
      vendor: 'greenhouse',
    });
    wiring.noticeForRescan.mockReturnValue(scan);

    let connect: ((port: Readonly<{ name: string }>) => void) | undefined;
    wiring.addConnectListener.mockImplementation((listener) => {
      connect = listener as typeof connect;
    });
    const { default: contentEntrypoint } = await import('../entrypoints/apply.content');
    (contentEntrypoint as unknown as { main: () => void }).main();
    connect?.({ name: KERNEL_BRIDGE_PORT_NAME });
    const deps = wiring.handleKernelBridgePort.mock.calls[0]?.[1] as ContentBridgeDeps;
    await deps.scan(authorization);
    expect(deps.armSubmission?.(
      {} as never,
      scan as unknown as Parameters<NonNullable<ContentBridgeDeps['armSubmission']>>[1],
    )).toBe(true);

    await expect(deps.revalidateScan(
      scan as unknown as Parameters<ContentBridgeDeps['revalidateScan']>[0],
      authorization,
    )).resolves.toBeNull();
    expect(gate.retireToBlockedTombstone).toHaveBeenCalled();
    expect(gate.dispose).not.toHaveBeenCalled();
  });

  it('revokes the exact gate and retained scan on pagehide', async () => {
    const scan = Object.freeze({
      canonicalOrigin: location.origin,
      jobId: location.pathname,
      fieldKeys: Object.freeze([]),
      scanDigest: `sha256:${'d'.repeat(64)}`,
      descriptor: Object.freeze({ root: Object.freeze({}) }),
    });
    const gate = {
      dispose: vi.fn(),
      revokeFinalReview: vi.fn(),
      retireToBlockedTombstone: vi.fn(),
      canConfirmFinalReview: vi.fn(() => false),
      confirmFinalReview: vi.fn(async () => false),
      onFinalReviewStateChange: vi.fn(() => vi.fn()),
    };
    wiring.createSubmissionGestureGate.mockReturnValue(gate);
    wiring.resolveStoredExecutionRuntimeAuthority.mockResolvedValue({
      ok: true,
      value: Object.freeze({ marker: 'runtime' }),
    });
    wiring.scanCurrentPageWithRuntimeAuthority.mockResolvedValue({
      scan,
      refusal: null,
      vendor: 'greenhouse',
    });
    wiring.noticeForRescan.mockReturnValue(scan);

    let connect: ((port: Readonly<{ name: string }>) => void) | undefined;
    wiring.addConnectListener.mockImplementation((listener) => {
      connect = listener as typeof connect;
    });
    const { default: contentEntrypoint } = await import('../entrypoints/apply.content');
    (contentEntrypoint as unknown as { main: () => void }).main();
    connect?.({ name: KERNEL_BRIDGE_PORT_NAME });
    const deps = wiring.handleKernelBridgePort.mock.calls[0]?.[1] as ContentBridgeDeps;
    await deps.scan(Object.freeze({
      schemaVersion: 1,
      purpose: 'EXECUTION',
    }) as RuntimeExecutionAuthorization);
    expect(deps.armSubmission?.(
      {} as never,
      scan as unknown as Parameters<NonNullable<ContentBridgeDeps['armSubmission']>>[1],
    )).toBe(true);

    const onPageHide = wiring.addPageHideListener.mock.calls.find(([type]) => type === 'pagehide')?.[1] as
      | (() => void)
      | undefined;
    expect(onPageHide).toBeTypeOf('function');
    onPageHide?.();
    expect(gate.retireToBlockedTombstone).toHaveBeenCalledOnce();
    expect(wiring.invalidateRetainedContentScanState).toHaveBeenCalledOnce();
  });

  it('mutation aborts an in-flight fill at its next runner checkpoint', async () => {
    const scan = Object.freeze({
      canonicalOrigin: location.origin,
      jobId: location.pathname,
      fieldKeys: Object.freeze(['email']),
      scanDigest: `sha256:${'6'.repeat(64)}`,
      descriptor: Object.freeze({ root: Object.freeze({}) }),
    });
    const authorization = Object.freeze({
      schemaVersion: 1,
      purpose: 'EXECUTION',
    }) as RuntimeExecutionAuthorization;
    wiring.resolveStoredExecutionRuntimeAuthority.mockResolvedValue({
      ok: true,
      value: Object.freeze({
        allowedActions: ['FILL'],
        allowedFieldKeys: ['email'],
        policy: Object.freeze({ capabilities: Object.freeze({}) }),
      }),
    });
    wiring.scanCurrentPageWithRuntimeAuthority.mockResolvedValue({
      scan,
      refusal: null,
      vendor: 'greenhouse',
    });
    wiring.noticeForRescan.mockReturnValue(scan);

    let capturedSignal: AbortSignal | undefined;
    let capturedShouldStop: (() => boolean) | undefined;
    wiring.fillFromGrant.mockImplementation(async (input) => {
      capturedSignal = input.signal;
      capturedShouldStop = input.progress.shouldStop;
      await new Promise<void>((resolve) => input.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return [];
    });

    let connect: ((port: Readonly<{ name: string }>) => void) | undefined;
    wiring.addConnectListener.mockImplementation((listener) => {
      connect = listener as typeof connect;
    });
    const { default: contentEntrypoint } = await import('../entrypoints/apply.content');
    (contentEntrypoint as unknown as { main: () => void }).main();
    connect?.({ name: KERNEL_BRIDGE_PORT_NAME });
    const deps = wiring.handleKernelBridgePort.mock.calls[0]?.[1] as ContentBridgeDeps;
    await expect(deps.scan(authorization)).resolves.toBe(scan);
    const observerInput = wiring.installScanMutationThrottle.mock.calls[0]?.[0] as {
      onInvalidate: () => void;
    };

    const fill = deps.fill({
      grant: { allowedActions: ['FILL'], fieldKeys: ['email'] },
      scan,
      profile: {},
      progress: { onOutcome: vi.fn(), shouldStop: () => false },
      runtimeAuthorization: authorization,
    } as unknown as Parameters<ContentBridgeDeps['fill']>[0]);
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    expect(capturedSignal!.aborted).toBe(false);
    observerInput.onInvalidate();
    expect(capturedSignal!.aborted).toBe(true);
    expect(capturedShouldStop?.()).toBe(true);
    await fill;
  });

  it('leaves native Submit untouched when the ordinary-build ceiling returns zero writes', async () => {
    const scan = Object.freeze({
      canonicalOrigin: location.origin,
      jobId: location.pathname,
      fieldKeys: Object.freeze(['email']),
      scanDigest: `sha256:${'f'.repeat(64)}`,
      descriptor: Object.freeze({ root: Object.freeze({}) }),
    });
    const authorization = Object.freeze({
      schemaVersion: 1,
      purpose: 'EXECUTION',
    }) as RuntimeExecutionAuthorization;
    wiring.resolveStoredExecutionRuntimeAuthority.mockResolvedValue({
      ok: true,
      value: Object.freeze({
        allowedActions: Object.freeze(['FILL']),
        allowedFieldKeys: Object.freeze(['email']),
        policy: Object.freeze({ enabled: true, source: 'remote', capabilities: Object.freeze({}) }),
      }),
    });
    wiring.scanCurrentPageWithRuntimeAuthority.mockResolvedValue({
      scan,
      refusal: null,
      vendor: 'greenhouse',
    });
    wiring.noticeForRescan.mockReturnValue(scan);
    wiring.fillFromGrant.mockImplementation(async (input) => {
      expect(input.policy.enabled).toBe(false);
      const outcome = { key: 'email', ok: false as const, reason: 'POLICY_DISABLED' as const };
      input.progress.onOutcome(outcome);
      return [outcome];
    });

    let connect: ((port: Readonly<{ name: string }>) => void) | undefined;
    wiring.addConnectListener.mockImplementation((listener) => {
      connect = listener as typeof connect;
    });
    const { default: contentEntrypoint } = await import('../entrypoints/apply.content');
    (contentEntrypoint as unknown as { main: () => void }).main();
    connect?.({ name: KERNEL_BRIDGE_PORT_NAME });
    const deps = wiring.handleKernelBridgePort.mock.calls[0]?.[1] as ContentBridgeDeps;
    await expect(deps.scan(authorization)).resolves.toBe(scan);

    const outcomes = await deps.fill({
      grant: { allowedActions: ['FILL'], fieldKeys: ['email'] },
      scan,
      profile: { email: 'synthetic@example.test' },
      progress: { onOutcome: vi.fn(), shouldStop: () => false },
      runtimeAuthorization: authorization,
    } as unknown as Parameters<ContentBridgeDeps['fill']>[0]);

    expect(outcomes).toEqual([
      { key: 'email', ok: false, reason: 'POLICY_DISABLED' },
    ]);
    expect(wiring.createSubmissionGestureGate).not.toHaveBeenCalled();
    expect(wiring.addNativeSubmissionActivationListener).not.toHaveBeenCalled();
    expect(wiring.addSubmissionEventListener).not.toHaveBeenCalled();
  });

  it('keeps an armed review gate through writer events, then retires it on a later user edit', async () => {
    vi.stubGlobal('__VIBE_CONTROLLED_MOCK_WRITES__', true);
    Object.assign(location, {
      hostname: 'job-boards.greenhouse.io',
      origin: 'https://job-boards.greenhouse.io:8443',
      pathname: '/acme/jobs/12345',
    });
    const scan = Object.freeze({
      canonicalOrigin: location.origin,
      jobId: location.pathname,
      fieldKeys: Object.freeze(['email']),
      scanDigest: `sha256:${'1'.repeat(64)}`,
      descriptor: Object.freeze({ root: Object.freeze({}) }),
    });
    const authorization = Object.freeze({
      schemaVersion: 1,
      purpose: 'EXECUTION',
    }) as RuntimeExecutionAuthorization;
    const gate = {
      dispose: vi.fn(),
      revokeFinalReview: vi.fn(),
      retireToBlockedTombstone: vi.fn(),
      canConfirmFinalReview: vi.fn(() => true),
      confirmFinalReview: vi.fn(async () => true),
      onFinalReviewStateChange: vi.fn(() => vi.fn()),
      onStateChange: vi.fn(() => vi.fn()),
    };
    wiring.createSubmissionGestureGate.mockReturnValue(gate);
    wiring.resolveStoredExecutionRuntimeAuthority.mockResolvedValue({
      ok: true,
      value: Object.freeze({
        allowedActions: Object.freeze(['FILL', 'SUBMIT']),
        allowedFieldKeys: Object.freeze(['email']),
        policy: Object.freeze({ enabled: true, source: 'remote', capabilities: Object.freeze({}) }),
      }),
    });
    wiring.scanCurrentPageWithRuntimeAuthority.mockResolvedValue({
      scan,
      refusal: null,
      vendor: 'greenhouse',
    });
    wiring.noticeForRescan.mockReturnValue(scan);
    const audit = Object.freeze({
      view: Object.freeze({ rows: Object.freeze([]) }),
      canUndo: () => false,
      undoAll: vi.fn(),
    });
    let invalidateReview: (() => void) | undefined;
    wiring.addExactReviewInvalidationListener.mockImplementation((_form, listener) => {
      invalidateReview = listener;
      return vi.fn();
    });
    wiring.fillFromGrant.mockImplementation(async (input) => {
      invalidateReview?.();
      input.onAudit?.(audit);
      return [{ key: 'email', ok: true as const, reason: 'FILLED' as const }];
    });

    let connect: ((port: Readonly<{ name: string }>) => void) | undefined;
    wiring.addConnectListener.mockImplementation((listener) => {
      connect = listener as typeof connect;
    });
    const { default: contentEntrypoint } = await import('../entrypoints/apply.content');
    (contentEntrypoint as unknown as { main: () => void }).main();
    connect?.({ name: KERNEL_BRIDGE_PORT_NAME });
    const deps = wiring.handleKernelBridgePort.mock.calls[0]?.[1] as ContentBridgeDeps;
    await expect(deps.scan(authorization)).resolves.toBe(scan);
    expect(deps.armSubmission?.(
      Object.freeze({ mode: 'ACTIVE' }) as never,
      scan as unknown as Parameters<NonNullable<ContentBridgeDeps['armSubmission']>>[1],
    )).toBe(true);
    const gateInput = wiring.createSubmissionGestureGate.mock.calls.at(-1)?.[0] as Readonly<{
      addReviewInvalidationListener: (listener: () => void) => () => void;
    }>;
    gateInput.addReviewInvalidationListener(vi.fn());

    await deps.fill({
      grant: { allowedActions: ['FILL', 'SUBMIT'], fieldKeys: ['email'] },
      scan,
      profile: { email: 'synthetic@example.test' },
      progress: { onOutcome: vi.fn(), shouldStop: () => false },
      runtimeAuthorization: authorization,
    } as unknown as Parameters<ContentBridgeDeps['fill']>[0]);

    expect(gate.retireToBlockedTombstone).not.toHaveBeenCalled();
    expect(wiring.showAuditPanel).toHaveBeenCalledOnce();
    invalidateReview?.();
    expect(gate.retireToBlockedTombstone).toHaveBeenCalledOnce();
    expect(wiring.invalidateRetainedContentScan).toHaveBeenCalledWith(scan);
  });

  it.each([false, true])('retains explicit Undo through settled readback, including submission abort=%s', async (hostSubmitted) => {
    vi.stubGlobal('__VIBE_CONTROLLED_MOCK_WRITES__', true);
    Object.assign(location, {
      hostname: 'job-boards.greenhouse.io',
      origin: 'https://job-boards.greenhouse.io:8443',
      pathname: '/acme/jobs/12345',
    });
    const scan = Object.freeze({
      canonicalOrigin: location.origin, jobId: location.pathname,
      fieldKeys: Object.freeze(['email']), scanDigest: `sha256:${'1'.repeat(64)}`,
      descriptor: Object.freeze({ root: Object.freeze({}) }),
    });
    const authorization = Object.freeze({ schemaVersion: 1, purpose: 'EXECUTION' }) as RuntimeExecutionAuthorization;
    const gate = {
      dispose: vi.fn(), revokeFinalReview: vi.fn(), retireToBlockedTombstone: vi.fn(),
      canConfirmFinalReview: vi.fn(() => true), confirmFinalReview: vi.fn(async () => true),
      onFinalReviewStateChange: vi.fn(() => vi.fn()), onStateChange: vi.fn(() => vi.fn()),
    };
    wiring.createSubmissionGestureGate.mockReturnValue(gate);
    wiring.resolveStoredExecutionRuntimeAuthority.mockResolvedValue({
      ok: true, value: Object.freeze({
        allowedActions: Object.freeze(['FILL', 'SUBMIT']), allowedFieldKeys: Object.freeze(['email']),
        policy: Object.freeze({ enabled: true, source: 'remote', capabilities: Object.freeze({}) }),
      }),
    });
    wiring.scanCurrentPageWithRuntimeAuthority.mockResolvedValue({ scan, refusal: null, vendor: 'greenhouse' });
    wiring.noticeForRescan.mockReturnValue(scan);
    let remaining = true;
    let settle: (() => void) | undefined;
    const audit = {
      view: Object.freeze({ rows: Object.freeze([]) }), canUndo: () => remaining,
      undoAll: vi.fn(() => new Promise<void>((resolve) => { settle = resolve; })),
    };
    wiring.fillFromGrant.mockImplementation(async (input) => {
      input.onAudit?.(audit);
      return [{ key: 'email', ok: !hostSubmitted, reason: hostSubmitted ? 'HOST_SUBMITTED' : 'FILLED' }];
    });
    let connect: ((port: Readonly<{ name: string }>) => void) | undefined;
    wiring.addConnectListener.mockImplementation((listener) => { connect = listener as typeof connect; });
    const { default: contentEntrypoint } = await import('../entrypoints/apply.content');
    (contentEntrypoint as unknown as { main: () => void }).main();
    connect?.({ name: KERNEL_BRIDGE_PORT_NAME });
    const deps = wiring.handleKernelBridgePort.mock.calls[0]?.[1] as ContentBridgeDeps;
    await deps.scan(authorization);
    deps.armSubmission?.(Object.freeze({ mode: 'ACTIVE' }) as never, scan as never);
    await deps.fill({
      grant: { allowedActions: ['FILL', 'SUBMIT'], fieldKeys: ['email'] }, scan, profile: {},
      progress: { onOutcome: vi.fn(), shouldStop: () => false }, runtimeAuthorization: authorization,
    } as unknown as Parameters<ContentBridgeDeps['fill']>[0]);
    expect(wiring.showAuditPanel).toHaveBeenCalledOnce();
    const handlers = wiring.showAuditPanel.mock.calls[0]![1] as {
      canConfirmFinalReview: () => boolean;
      undoAll: (event: Event, root: ShadowRoot) => Promise<void>;
    };
    const panel = wiring.showAuditPanel.mock.results[0]!.value as { dismiss: ReturnType<typeof vi.fn> };
    if (hostSubmitted) expect(handlers.canConfirmFinalReview()).toBe(false);
    const pending = handlers.undoAll(Object.freeze({}) as Event, Object.freeze({}) as ShadowRoot);
    expect(panel.dismiss).not.toHaveBeenCalled();
    settle!();
    await pending;
    expect(panel.dismiss).not.toHaveBeenCalled(); // A failed/uncertain restore is not completion.
    const completed = handlers.undoAll(Object.freeze({}) as Event, Object.freeze({}) as ShadowRoot);
    remaining = false;
    expect(panel.dismiss).not.toHaveBeenCalled();
    settle!();
    await completed;
    expect(panel.dismiss).toHaveBeenCalledOnce();
  });

  it('disposes a FILL-only blocker immediately after the controlled write window', async () => {
    vi.stubGlobal('__VIBE_CONTROLLED_MOCK_WRITES__', true);
    Object.assign(location, {
      hostname: 'job-boards.greenhouse.io',
      origin: 'https://job-boards.greenhouse.io:8443',
      pathname: '/acme/jobs/12345',
    });
    const scan = Object.freeze({
      canonicalOrigin: location.origin,
      jobId: location.pathname,
      fieldKeys: Object.freeze(['email']),
      scanDigest: `sha256:${'2'.repeat(64)}`,
      descriptor: Object.freeze({ root: Object.freeze({}) }),
    });
    const authorization = Object.freeze({
      schemaVersion: 1,
      purpose: 'EXECUTION',
    }) as RuntimeExecutionAuthorization;
    const temporaryGate = {
      dispose: vi.fn(),
      revokeFinalReview: vi.fn(),
      retireToBlockedTombstone: vi.fn(),
      canConfirmFinalReview: vi.fn(() => false),
      confirmFinalReview: vi.fn(async () => false),
      onFinalReviewStateChange: vi.fn(() => vi.fn()),
      onStateChange: vi.fn(() => vi.fn()),
    };
    wiring.createSubmissionGestureGate.mockReturnValue(temporaryGate);
    wiring.resolveStoredExecutionRuntimeAuthority.mockResolvedValue({
      ok: true,
      value: Object.freeze({
        allowedActions: Object.freeze(['FILL']),
        allowedFieldKeys: Object.freeze(['email']),
        policy: Object.freeze({ enabled: true, source: 'remote', capabilities: Object.freeze({}) }),
      }),
    });
    wiring.scanCurrentPageWithRuntimeAuthority.mockResolvedValue({
      scan,
      refusal: null,
      vendor: 'greenhouse',
    });
    wiring.noticeForRescan.mockReturnValue(scan);
    wiring.fillFromGrant.mockResolvedValue([
      { key: 'email', ok: true, reason: 'FILLED' },
    ]);

    let connect: ((port: Readonly<{ name: string }>) => void) | undefined;
    wiring.addConnectListener.mockImplementation((listener) => {
      connect = listener as typeof connect;
    });
    const { default: contentEntrypoint } = await import('../entrypoints/apply.content');
    (contentEntrypoint as unknown as { main: () => void }).main();
    connect?.({ name: KERNEL_BRIDGE_PORT_NAME });
    const deps = wiring.handleKernelBridgePort.mock.calls[0]?.[1] as ContentBridgeDeps;
    await expect(deps.scan(authorization)).resolves.toBe(scan);

    await deps.fill({
      grant: { allowedActions: ['FILL'], fieldKeys: ['email'] },
      scan,
      profile: { email: 'synthetic@example.test' },
      progress: { onOutcome: vi.fn(), shouldStop: () => false },
      runtimeAuthorization: authorization,
    } as unknown as Parameters<ContentBridgeDeps['fill']>[0]);

    expect(wiring.createSubmissionGestureGate).toHaveBeenCalledWith(
      expect.objectContaining({ descriptor: { mode: 'BLOCKED' } }),
    );
    expect(temporaryGate.dispose).toHaveBeenCalledOnce();
    expect(temporaryGate.retireToBlockedTombstone).not.toHaveBeenCalled();
  });

  it('same-digest rescan protects the newer generation from the old observer callback', async () => {
    const root = Object.freeze({});
    const firstScan = Object.freeze({
      scanDigest: `sha256:${'7'.repeat(64)}`,
      descriptor: Object.freeze({ root }),
    });
    const secondScan = Object.freeze({
      scanDigest: firstScan.scanDigest,
      descriptor: Object.freeze({ root }),
    });
    const authorization = Object.freeze({
      schemaVersion: 1,
      purpose: 'EXECUTION',
    }) as RuntimeExecutionAuthorization;
    wiring.resolveStoredExecutionRuntimeAuthority.mockResolvedValue({
      ok: true,
      value: Object.freeze({ marker: 'runtime-authority' }),
    });
    wiring.scanCurrentPageWithRuntimeAuthority
      .mockResolvedValueOnce({ scan: firstScan, refusal: null, vendor: 'greenhouse' })
      .mockResolvedValueOnce({ scan: secondScan, refusal: null, vendor: 'greenhouse' });
    wiring.noticeForRescan
      .mockReturnValueOnce(firstScan)
      .mockReturnValueOnce(secondScan);
    const firstHandle = { dispose: vi.fn() };
    const secondHandle = { dispose: vi.fn() };
    wiring.installScanMutationThrottle
      .mockReturnValueOnce(firstHandle)
      .mockReturnValueOnce(secondHandle);

    let connect: ((port: Readonly<{ name: string }>) => void) | undefined;
    wiring.addConnectListener.mockImplementation((listener) => {
      connect = listener as typeof connect;
    });
    const { default: contentEntrypoint } = await import('../entrypoints/apply.content');
    (contentEntrypoint as unknown as { main: () => void }).main();
    connect?.({ name: KERNEL_BRIDGE_PORT_NAME });
    const deps = wiring.handleKernelBridgePort.mock.calls[0]?.[1] as ContentBridgeDeps;
    await deps.scan(authorization);
    const oldCallback = (wiring.installScanMutationThrottle.mock.calls[0]?.[0] as {
      onInvalidate: () => void;
    }).onInvalidate;
    await deps.scan(authorization);
    const newCallback = (wiring.installScanMutationThrottle.mock.calls[1]?.[0] as {
      onInvalidate: () => void;
    }).onInvalidate;

    wiring.invalidateRetainedContentScan.mockClear();
    oldCallback();
    expect(wiring.invalidateRetainedContentScan).not.toHaveBeenCalled();
    newCallback();
    expect(wiring.invalidateRetainedContentScan).toHaveBeenCalledWith(secondScan);
    expect(firstHandle.dispose).toHaveBeenCalledTimes(1);
  });

  it('observer installation failure fails the authorized scan closed', async () => {
    const scan = Object.freeze({
      scanDigest: `sha256:${'8'.repeat(64)}`,
      descriptor: Object.freeze({ root: Object.freeze({}) }),
    });
    const authorization = Object.freeze({
      schemaVersion: 1,
      purpose: 'EXECUTION',
    }) as RuntimeExecutionAuthorization;
    wiring.resolveStoredExecutionRuntimeAuthority.mockResolvedValue({
      ok: true,
      value: Object.freeze({ marker: 'runtime-authority' }),
    });
    wiring.scanCurrentPageWithRuntimeAuthority.mockResolvedValue({
      scan,
      refusal: null,
      vendor: 'greenhouse',
    });
    wiring.noticeForRescan.mockReturnValue(scan);
    wiring.installScanMutationThrottle.mockReturnValue(null);

    let connect: ((port: Readonly<{ name: string }>) => void) | undefined;
    wiring.addConnectListener.mockImplementation((listener) => {
      connect = listener as typeof connect;
    });
    const { default: contentEntrypoint } = await import('../entrypoints/apply.content');
    (contentEntrypoint as unknown as { main: () => void }).main();
    connect?.({ name: KERNEL_BRIDGE_PORT_NAME });
    const deps = wiring.handleKernelBridgePort.mock.calls[0]?.[1] as ContentBridgeDeps;
    await expect(deps.scan(authorization)).resolves.toBeNull();
  });

  // 主机不在厂商表里的子帧不装早装的提交拦截（2026-10-03）。桥连的是标签页里所有的帧，万一这样一帧也扫到了
  // 一张绑着授权的表，它拦不住宿主自己的提交，所以一律不武装：fail closed，不是「没有拦截也照样武装」。
  it('a frame without the early capture broker never arms a submission gate', async () => {
    vi.stubGlobal('window', {
      top: Object.freeze({}),
      self: Object.freeze({}),
      addEventListener: wiring.addPageHideListener,
    });
    vi.stubGlobal('location', {
      hostname: 'ads.example',
      origin: 'https://ads.example',
      pathname: '/slot/1',
      search: '',
    });
    const scan = Object.freeze({
      canonicalOrigin: 'https://ads.example',
      jobId: '/slot/1',
      fieldKeys: Object.freeze([]),
      scanDigest: `sha256:${'a'.repeat(64)}`,
      descriptor: Object.freeze({ root: Object.freeze({}) }),
    });
    const authorization = Object.freeze({
      schemaVersion: 1,
      purpose: 'EXECUTION',
    }) as RuntimeExecutionAuthorization;
    wiring.resolveStoredExecutionRuntimeAuthority.mockResolvedValue({
      ok: true,
      value: Object.freeze({ marker: 'runtime-authority' }),
    });
    wiring.scanCurrentPageWithRuntimeAuthority.mockResolvedValue({ scan, refusal: null, vendor: 'generic' });
    wiring.noticeForRescan.mockReturnValue(scan);
    let connect: ((port: Readonly<{ name: string }>) => void) | undefined;
    wiring.addConnectListener.mockImplementation((listener) => {
      connect = listener as typeof connect;
    });

    const { default: contentEntrypoint } = await import('../entrypoints/apply.content');
    (contentEntrypoint as unknown as { main: () => void }).main();
    expect(wiring.installEarlySubmissionCaptureBroker, 'this frame skips the broker').not.toHaveBeenCalled();
    connect?.({ name: KERNEL_BRIDGE_PORT_NAME });
    const deps = wiring.handleKernelBridgePort.mock.calls[0]?.[1] as ContentBridgeDeps;
    await expect(deps.scan(authorization)).resolves.toBe(scan);

    expect(deps.armSubmission?.(
      {} as Parameters<NonNullable<ContentBridgeDeps['armSubmission']>>[0],
      scan as unknown as Parameters<NonNullable<ContentBridgeDeps['armSubmission']>>[1],
    )).toBe(false);
    expect(wiring.createSubmissionGestureGate).not.toHaveBeenCalled();
  });
});

describe('the dock on the default build', () => {
  const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
  const windowListener = (name: string) =>
    (wiring.addPageHideListener.mock.calls.find((call) => call[0] === name)?.[1]) as (() => void) | undefined;

  // The panel is mounted from the worker's reply, with its own door to the
  // profile; and because this build gets no push from the portal, coming back
  // to the tab asks again — a changed face replaces the panel, never joins it.
  // 内容脚本注入后会先问一次站点知识（规则不再随包内置），再问 dock。所以用
  // "下一次调用"来表达"dock 查询返回 X"已经不成立——按消息种类分派。
  const answerDock = (reply: unknown) => {
    let served = false;
    vi.mocked(wiring.sendMessage).mockImplementation((message?: unknown) => {
      const kind = (message as { kind?: string } | undefined)?.kind;
      if (kind === 'apply-site-knowledge/get') return Promise.resolve({ rules: null }) as never;
      if (!served) { served = true; return Promise.resolve(reply) as never; }
      return Promise.resolve() as never;
    });
  };

  it('mounts with a profile door, and replaces itself when the face changes on return', async () => {
    vi.useFakeTimers();
    dockWiring.handles.length = 0;
    dockWiring.mount.mockClear();
    answerDock({ dock: { kind: 'UNAVAILABLE', reason: 'NO_MISSION' } });
    const { default: contentEntrypoint } = await import('../entrypoints/apply.content');
    (contentEntrypoint as unknown as { main: () => void }).main();
    await flush();
    expect(dockWiring.mount).toHaveBeenCalledTimes(1);
    const handlers = dockWiring.mount.mock.calls[0]?.[1] as { directory?: { personal?: unknown } };
    expect(typeof handlers.directory?.personal, 'the panel must be able to read the profile').toBe('function');

    const focus = windowListener('focus');
    expect(focus, 'coming back to the tab must ask the worker again').toBeDefined();
    vi.advanceTimersByTime(2500);
    answerDock({ dock: { kind: 'READY' } });
    focus?.();
    await flush();
    expect(dockWiring.handles[0]?.dismiss).toHaveBeenCalledTimes(1);
    expect(dockWiring.mount).toHaveBeenCalledTimes(2);
    // 旧面板开着，换脸后的新面板也开着——退出登录 / 连接完成不该把面板收成角标。
    expect((dockWiring.mount.mock.calls[1]?.[1] as { autoOpen?: boolean }).autoOpen).toBe(true);
  });
});
