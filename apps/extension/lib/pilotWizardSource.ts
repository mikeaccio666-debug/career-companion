import { parseGetMissionApplicationTargetResponse, type MissionApplicationTargetView } from '@edaix/contracts';
import { parsePilotWizardContextSelection, parsePilotWizardScanContext,
  type PilotWizardContextSelection, type PilotWizardScanContext } from '@edaix/contracts/draft/pilot-wizard-context';
import type { MissionApplicationTargetClient } from './missionApplicationTargetClient';
import type { BackgroundExecutionRuntimeAuthority } from './executionRuntimeAuthority';
import type { PilotUa5ExactPageFacts } from '../connected-dev/exactPageLease';

/**
 * Read-only adaptation of Portal's selected Mission and the existing target /
 * runtime clients. No URL-to-Mission inference, persistence, lease, claim,
 * payload, writer or automatic action belongs to this source.
 */
export function createPilotWizardSource(input: Readonly<{
  allowedPortalOrigins: readonly string[];
  getCurrentUserId(): Promise<string | null>;
  readConnectionReadiness(expectedOwnerId: string): Promise<string>;
  resolveTarget: MissionApplicationTargetClient['resolve'];
  runtimeAuthority: Pick<BackgroundExecutionRuntimeAuthority, 'authorizeDiscovery' | 'revalidate'>;
  readPageFacts(tabId: number): Promise<PilotUa5ExactPageFacts | null>;
  now?: () => number;
  newSessionId?: () => string;
}>) {
  const now = input.now ?? Date.now;
  type Selection = Readonly<{ request: PilotWizardContextSelection; target: MissionApplicationTargetView; selectedAtMs: number }>;
  type Scope = Readonly<{ selection: Selection; page: PilotUa5ExactPageFacts; target: MissionApplicationTargetView; runtime: string; sessionId: string }>;
  let selected: Selection | null = null, selectionAttempt: object | null = null;
  let latestResolveAttempt: object | null = null;
  let lastTime: number | null = null;
  const correlations = new Set<string>(), scopes = new Map<number, Scope>(), attempts = new Map<number, object>();
  const currentContexts = new Map<number, PilotWizardScanContext>();
  const issuedContexts = new WeakMap<PilotWizardScanContext, Scope>();
  const reset = (): void => { selected = null; selectionAttempt = null; latestResolveAttempt = null; scopes.clear(); attempts.clear(); currentContexts.clear(); };
  const time = (): number | null => {
    try {
      const current = now();
      if (!Number.isSafeInteger(current) || current < 0 || (lastTime !== null && current < lastTime)) { reset(); return null; }
      lastTime = current;
      return current;
    } catch { reset(); return null; }
  };
  const sameTarget = (left: MissionApplicationTargetView, right: MissionApplicationTargetView): boolean => JSON.stringify(left) === JSON.stringify(right);
  const samePage = (left: PilotUa5ExactPageFacts, right: PilotUa5ExactPageFacts): boolean =>
    left.tabId === right.tabId && left.pageEpoch === right.pageEpoch && left.origin === right.origin &&
    left.pathname === right.pathname && left.targetUrlDigest === right.targetUrlDigest;
  const readTarget = async (request: PilotWizardContextSelection): Promise<MissionApplicationTargetView | null> => {
    const raw = await input.resolveTarget(request.missionId);
    const parsed = raw && parseGetMissionApplicationTargetResponse({ schemaVersion: 1, target: raw });
    const current = time();
    return parsed && current !== null && parsed.target.missionRevision === request.missionRevision &&
      Date.parse(parsed.target.verifiedAt) <= current && Date.parse(parsed.target.freshUntil) > current ? parsed.target : null;
  };
  const active = (selection: Selection): boolean => {
    const current = time();
    return selected === selection && current !== null && current >= selection.selectedAtMs &&
      current < Math.min(selection.selectedAtMs + 600_000, Date.parse(selection.target.freshUntil));
  };
  const readPage = async (tabId: number, target: MissionApplicationTargetView): Promise<PilotUa5ExactPageFacts | null> => {
    const page = await input.readPageFacts(tabId);
    return page && page.tabId === tabId && Number.isSafeInteger(page.pageEpoch) && page.pageEpoch >= 0 &&
      page.origin === target.canonicalOrigin && page.pathname === target.pathname && /^[a-f0-9]{64}$/u.test(page.targetUrlDigest)
      ? Object.freeze({ ...page }) : null;
  };

  return Object.freeze({
    async select(candidate: unknown, senderOrigin: string | undefined): Promise<boolean> {
      if (!senderOrigin || !input.allowedPortalOrigins.includes(senderOrigin)) return false;
      const request = parsePilotWizardContextSelection(candidate);
      if (!request || correlations.has(request.correlationId) || correlations.size >= 256) return false;
      correlations.add(request.correlationId);
      reset();
      const attempt = {}; selectionAttempt = attempt;
      try {
        if (await input.getCurrentUserId() !== request.expectedOwnerId ||
            await input.readConnectionReadiness(request.expectedOwnerId) !== 'READY') return false;
        const target = await readTarget(request), selectedAtMs = time();
        if (!target || selectedAtMs === null || selectionAttempt !== attempt ||
            await input.getCurrentUserId() !== request.expectedOwnerId || selectionAttempt !== attempt) return false;
        selected = Object.freeze({ request, target, selectedAtMs });
        return true;
      } catch { if (selectionAttempt === attempt) reset(); return false; }
    },

    /**
     * Whether this exact tab is the application page of a live selection.
     *
     * A display decision, not an authorization: it issues no context, stores
     * nothing, and grants nothing — every run still goes through resolve() with
     * the full owner, target and runtime checks. The dock needs it because
     * offering Autofill on a page the selected Mission has nothing to do with
     * is a promise we cannot keep, and answering "some Mission is selected"
     * would do exactly that.
     */
    async missionBound(tabId: number): Promise<boolean> {
      const selection = selected;
      if (!selection || !active(selection) || !Number.isSafeInteger(tabId) || tabId < 0) return false;
      try {
        return await readPage(tabId, selection.target) !== null;
      } catch {
        // An unreadable page is not a bound one. Fail closed and stay silent:
        // the reason belongs to the run that asks for authority, not to a face.
        return false;
      }
    },

    async resolve(tabId: number, requestId: string): Promise<PilotWizardScanContext | null> {
      const selection = selected;
      if (!selection || !active(selection) || !Number.isSafeInteger(tabId) || tabId < 0 || !/^[a-f0-9]{32}$/u.test(requestId)) return null;
      const attempt = {}; attempts.set(tabId, attempt); latestResolveAttempt = attempt; currentContexts.delete(tabId);
      try {
        if (await input.getCurrentUserId() !== selection.request.expectedOwnerId) {
          if (selected === selection && attempts.get(tabId) === attempt && latestResolveAttempt === attempt) reset();
          return null;
        }
        const target = await readTarget(selection.request);
        if (!target || !sameTarget(target, selection.target)) {
          if (attempts.get(tabId) === attempt) scopes.delete(tabId);
          return null;
        }
        const page = await readPage(tabId, target);
        if (!page) return null;
        const runtime = await input.runtimeAuthority.authorizeDiscovery({ atsProvider: target.atsProvider, pathRuleId: target.pathRuleId });
        if (!runtime.ok || runtime.value.purpose !== 'DISCOVERY') return null;
        const afterTarget = await readTarget(selection.request), afterPage = await readPage(tabId, target), current = time();
        if (!afterTarget || !sameTarget(target, afterTarget) || !afterPage || !samePage(page, afterPage) || current === null ||
            await input.getCurrentUserId() !== selection.request.expectedOwnerId || !active(selection) || attempts.get(tabId) !== attempt) return null;
        const runtimeIdentity = JSON.stringify(runtime.value);
        let scope = scopes.get(tabId);
        if (!scope || scope.selection !== selection || !samePage(scope.page, page) || !sameTarget(scope.target, target) || scope.runtime !== runtimeIdentity) {
          if (scopes.size >= 64 && !scopes.has(tabId)) return null;
          const sessionId = input.newSessionId?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
          if (!/^[a-f0-9]{32}$/u.test(sessionId)) return null;
          scope = Object.freeze({ selection, page, target, runtime: runtimeIdentity, sessionId });
          scopes.set(tabId, scope);
        }
        const context = parsePilotWizardScanContext({ schemaVersion: 1, scope: 'LOCAL_SESSION', sessionId: scope.sessionId,
          requestId, expiresAtMs: Math.min(current + 30_000, Date.parse(target.freshUntil), selection.selectedAtMs + 600_000), authorization: runtime.value });
        const issuedAtMs = time();
        if (!context || issuedAtMs === null || issuedAtMs >= context.expiresAtMs) return null;
        issuedContexts.set(context, scope); currentContexts.set(tabId, context);
        return context;
      } catch {
        if (attempts.get(tabId) === attempt) currentContexts.delete(tabId);
        return null;
      }
    },

    async validate(context: PilotWizardScanContext): Promise<boolean> {
      const scope = issuedContexts.get(context);
      if (!scope || currentContexts.get(scope.page.tabId) !== context || !active(scope.selection)) return false;
      const reject = (): false => {
        if (currentContexts.get(scope.page.tabId) === context) {
          currentContexts.delete(scope.page.tabId);
          if (scopes.get(scope.page.tabId) === scope) scopes.delete(scope.page.tabId);
        }
        return false;
      };
      try {
        const before = time();
        if (before === null || before >= context.expiresAtMs || await input.getCurrentUserId() !== scope.selection.request.expectedOwnerId) return reject();
        const target = await readTarget(scope.selection.request), page = await readPage(scope.page.tabId, scope.target);
        if (!target || !sameTarget(target, scope.target) || !page || !samePage(page, scope.page) ||
            !await input.runtimeAuthority.revalidate(context.authorization)) return reject();
        const afterTarget = await readTarget(scope.selection.request), afterPage = await readPage(scope.page.tabId, scope.target);
        if (!afterTarget || !sameTarget(afterTarget, scope.target) || !afterPage || !samePage(afterPage, scope.page) ||
            await input.getCurrentUserId() !== scope.selection.request.expectedOwnerId ||
            !active(scope.selection) || currentContexts.get(scope.page.tabId) !== context) return reject();
        const after = time();
        if (after === null || after >= context.expiresAtMs) return reject();
        return true;
      } catch { return reject(); }
    },
    reset,
  });
}
