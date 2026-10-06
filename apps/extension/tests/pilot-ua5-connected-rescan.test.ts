// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPilotUa5ConnectedLiveRun } from '../connected-dev/liveRun';
import { createPilotUa1DiscoveryRequest } from '../lib/pilotUa1DiscoveryProtocol';

beforeEach(() => {
  history.replaceState(null, '', '/acme/jobs/123');
  document.body.innerHTML = '<form><input type="text" autocomplete="given-name" value="existing"><input type="text" style="display:none"></form>';
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, width: 180, height: 28, top: 0, right: 180, bottom: 28, left: 0, toJSON: () => ({}),
  });
});
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

function harness(enabled = true) {
  const request = createPilotUa1DiscoveryRequest({
    pageUrl: location.href, requestId: 'a'.repeat(32), issuedAtMs: 1_000,
    targetUrlDigest: createHash('sha256').update(location.href).digest('hex'),
  })!;
  const run = createPilotUa5ConnectedLiveRun({
    enabled, extensionId: 'test-extension', expectedBackgroundUrl: 'chrome-extension://test-extension/background.js',
    document, view: window, location, now: () => 1_000, openShadowRoot: (element) => element.shadowRoot,
  });
  return { run, request };
}

it('reuses UA-1 for fresh counts without writing or claiming wizard identity', async () => {
  const { run, request } = harness();
  const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
  const submit = vi.spyOn(document.querySelector('form')!, 'submit');
  const requestSubmit = vi.spyOn(document.querySelector('form')!, 'requestSubmit');
  const result = await run.rescanCurrentPage(request, new AbortController().signal);
  expect(result).toEqual({ ok: true, scan: {
    schemaVersion: 1, observedControls: 1, hiddenNotObservedCount: 1,
    unobservedRegions: 0, structureAvailable: true, pageIdentity: 'UNVERIFIED',
  } });
  expect(setter).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  expect(requestSubmit).not.toHaveBeenCalled();
  expect(run.getCurrentResult()).toBeNull();
  document.querySelector('form')!.append(document.createElement('textarea'));
  const fresh = await run.rescanCurrentPage({ ...request, requestId: 'b'.repeat(32) }, new AbortController().signal);
  expect(fresh).toMatchObject({ ok: true, scan: { observedControls: 2, pageIdentity: 'UNVERIFIED' } });
});

it('rejects disabled, aborted and wrong-URL requests without a scan result', async () => {
  const disabled = harness(false);
  await expect(disabled.run.rescanCurrentPage(disabled.request, new AbortController().signal)).resolves.toMatchObject({ ok: false });
  const { run, request } = harness();
  const abort = new AbortController(); abort.abort();
  await expect(run.rescanCurrentPage(request, abort.signal)).resolves.toMatchObject({ ok: false });
  await expect(run.rescanCurrentPage({ ...request, targetUrlDigest: 'f'.repeat(64) }, new AbortController().signal)).resolves.toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
});
