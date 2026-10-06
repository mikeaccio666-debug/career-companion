/**
 * Connected-dev's only content entrypoint.
 *
 * It registers one configured top-level page and accepts only the
 * private UA-5 background port. No legacy bridge, telemetry, or
 * submission-boundary runtime is imported into this artifact.
 *
 * It does carry the product dock — the surface the user sees and acts through.
 * Nothing of it reaches the page until the background answers the page-ready
 * report with a face: the content script must not touch host DOM before a
 * verified authorization, and whether this browser is connected and whether the
 * page belongs to a Mission are facts only the worker holds.
 */

import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { mountAutofillDock, parseAutofillDockInstruction, type AutofillDockHandle } from '../lib/autofillDock';
import { createDockFillIntent } from '../lib/dockFillIntent';
import { createDirectoryRequest } from '../lib/directoryRequest';
import { createProfileDirectoryClient } from '../lib/profileDirectoryClient';
import { dockProgressFromRunEvent } from '../product-panel/runProgress';
import { installPilotUa5ConnectedContent } from '../connected-dev/contentRuntime';
import { createPilotUa5ConnectedLiveRun } from '../connected-dev/liveRun';
import { EXECUTION_RUNTIME_BUNDLE_STORAGE_KEY } from '../lib/executionRuntimeBundleStore';
import { PILOT_UA5_CONTROLLED_LOCAL_AUTHORITY } from '../lib/pilotUa5ControlledLocalAdmission';
import {
  createPilotUa5ConnectedPageReady,
  pilotUa5ConnectedFailure,
  type PilotUa5ConnectedPort,
} from '../lib/pilotUa5ConnectedProtocol';

function disabledLiveRun() {
  return Object.assign(
    async () => pilotUa5ConnectedFailure(),
    Object.freeze({
      undoCurrentPage: async () => 'UNAVAILABLE' as const,
      getCurrentResult: () => null,
      getWizardProjection: () => undefined,
      resetWizard: () => {},
      rescanCurrentPage: async () => Object.freeze({
        ok: false as const,
        code: 'PILOT_DISCOVERY_UNAVAILABLE' as const,
      }),
      dispose: () => {},
    }),
  );
}

export default defineContentScript({
  matches: ['https://job-boards.greenhouse.io/*'],
  runAt: 'document_start',
  main() {
    if (
      typeof __VIBE_EXTENSION_CONNECTED_DEV_ENABLED__ === 'undefined' ||
      !__VIBE_EXTENSION_CONNECTED_DEV_ENABLED__ ||
      window.top !== window.self
    ) return;

    const pageReady = createPilotUa5ConnectedPageReady(
      location.origin,
      location.pathname,
    );
    if (pageReady === null) return;

    let dock: AutofillDockHandle | null = null;
    const extensionId = browser.runtime.id;
    const expectedBackgroundUrl = browser.runtime.getURL('/background.js');
    let wizardAuthorityEpoch: object = {};
    const writeArtifact =
      typeof __VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED__ !== 'undefined' &&
      __VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED__ === true;
    // P1 is wired. Worker admission and every leaf's original-Profile proof
    // remain mandatory; fill-first keeps Undo frozen.
    // The ordinary connected artifact has no write lease or deadline. Keep its
    // content realm fail-closed and omit the live writer/compiler/wizard graph;
    // only an explicitly admitted write artifact carries the live composition.
    const liveRun = writeArtifact
      ? createPilotUa5ConnectedLiveRun({
          enabled: true,
          controlledLocalTextOnly:
            typeof __VIBE_EXTENSION_CONNECTED_DEV_LOCAL_AUTHORITY__ === 'string' &&
            __VIBE_EXTENSION_CONNECTED_DEV_LOCAL_AUTHORITY__ === PILOT_UA5_CONTROLLED_LOCAL_AUTHORITY,
          extensionId,
          expectedBackgroundUrl,
          wizard: {
            readStoredRuntimeBundle: async () => (await browser.storage.local.get(EXECUTION_RUNTIME_BUNDLE_STORAGE_KEY))[EXECUTION_RUNTIME_BUNDLE_STORAGE_KEY],
            extensionVersion: () => browser.runtime.getManifest().version,
            readAuthorityEpoch: () => wizardAuthorityEpoch,
          },
          // Static ceiling only; each worker grant carries the earlier action-lease
          // deadline, which the live session tightens again before the setter.
          writeNotAfterMs:
            typeof __VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER_MS__ === 'number'
              ? __VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER_MS__
              : 0,
        })
      : disabledLiveRun();
    const resetWizard = (): void => { wizardAuthorityEpoch = {}; liveRun.resetWizard(); };
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (Object.hasOwn(changes, 'authSession') || Object.hasOwn(changes, EXECUTION_RUNTIME_BUNDLE_STORAGE_KEY))) resetWizard();
    });
    window.addEventListener('pagehide', () => { resetWizard(); dock?.dismiss(); dock = null; });
    window.addEventListener('pageshow', resetWizard);
    /**
     * The same run, reported to the panel as well as to whoever asked for it.
     *
     * The panel is where the user is looking — a fill that reports only into the
     * side panel leaves whoever started it from the page watching nothing happen.
     * It is a second reader of the same events, never a second run: the original
     * sink is still called, with the same event, whatever the panel does with it.
     */
    let runId = 0;
    const reportingRun: typeof liveRun = Object.assign(
      (discovery: Parameters<typeof liveRun>[0], onProgress: Parameters<typeof liveRun>[1], options: Parameters<typeof liveRun>[2]) => {
        runId += 1;
        const id = `dock-run-${runId}`;
        let handedOver = false;
        return liveRun(discovery, (event) => {
          const progress = dockProgressFromRunEvent(id, event);
          // A phase the panel cannot name changes nothing on screen; the run is
          // unaffected either way.
          if (progress !== null) {
            try {
              // The first event of a run takes the sheet; the rest refresh it.
              // update() refuses a run that is not the one on screen — which is
              // right, two applications must never share a sheet — so without
              // the hand-over every fill after the first was silently dropped
              // and the panel sat on the previous run's numbers.
              if (handedOver) dock?.update(progress);
              else { dock?.beginRun(progress); handedOver = true; }
            } catch { /* display only */ }
          }
          onProgress(event);
        }, options);
      },
      liveRun,
    );

    installPilotUa5ConnectedContent({
      enabled: true,
      extensionId,
      expectedBackgroundUrl,
      runtime: {
        onConnect: browser.runtime.onConnect as unknown as {
          addListener(listener: (port: PilotUa5ConnectedPort) => void): void;
        },
      },
      runCurrentPage: reportingRun,
      undoCurrentPage: liveRun.undoCurrentPage,
      getCurrentResult: liveRun.getCurrentResult,
      getWizardProjection: liveRun.getWizardProjection,
      rescanCurrentPage: liveRun.rescanCurrentPage,
      retireCurrentResult: liveRun.dispose,
      lifecycle: window,
    });
    /**
     * The panel's own door to the saved profile.
     *
     * The checking lives here, where the values are used, rather than in the
     * worker: the worker holds the token and the routes, and everything it
     * returns is unchecked text until this client opens it. Text has no fields,
     * so there is no path that renders an answer nobody looked at.
     */
    const directory = createProfileDirectoryClient({
      run: async (operation, body) => {
        const request = createDirectoryRequest(operation, body);
        if (request === null) return { ok: false as const, code: 'UNAVAILABLE' as const };
        try {
          return await browser.runtime.sendMessage(request) as Awaited<ReturnType<
            Parameters<typeof createProfileDirectoryClient>[0]['run']
          >>;
        } catch {
          // A worker that is not listening has no answer; it has not failed a
          // check, so say what is true rather than inventing a verdict.
          return { ok: false as const, code: 'UNAVAILABLE' as const };
        }
      },
    });

    const showFace = (candidate: unknown): void => {
      const face = parseAutofillDockInstruction(candidate);
      // Untrusted boundary even though the worker is ours: a shape we cannot
      // name is not one we stand on someone's form for, and HIDDEN never means
      // mount. An unnameable face leaves whatever is there exactly as it is.
      if (face === null) return;
      dock?.dismiss();
      dock = mountAutofillDock(face, {
        // A real click on our own button is a user gesture, and the owner ruled
        // (2026-09-11) that it may authorise a fill the same way the toolbar
        // does — some vendors take the application on a surface the side panel
        // cannot reach. The button carries none of that authority itself: it
        // reports the gesture and names the page it happened on, and the worker
        // decides, against the sender and the page it already registered.
        directory,
        onAutofill: () => {
          const gesture = createDockFillIntent(location.origin, location.pathname);
          if (gesture === null) return;
          void browser.runtime.sendMessage(gesture)
            .then((reply) => {
              const started = (reply as { started?: unknown } | null)?.started === true;
              if (!started) dock?.setNotice('请先点一下浏览器工具栏上的 ArgoLand 图标打开侧边栏，再点填写。');
            })
            .catch(() => {
              // A worker that is not listening grants nothing; the user's next
              // gesture asks again.
            });
        },
        onOpenEntry: () => {},
      });
    };
    // Opening the application page first and choosing the Mission afterwards is
    // the ordinary way round, so the face cannot be decided once and frozen.
    browser.runtime.onMessage.addListener((message) => { showFace(message); });

    void browser.runtime
      .sendMessage(pageReady)
      .then(showFace)
      .catch(() => {
        // A missing worker registration keeps current-page selection closed.
      });
  },
});
