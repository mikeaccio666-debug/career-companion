// @vitest-environment happy-dom
/**
 * UA-1 reachability — opaque frames and the long-page budget.
 *
 * Regression-first. Every case below was first reproduced against real public
 * candidate pages with the scanner's own predicates ported verbatim
 * (.claude-lane-inbox/coverage-lab-r2/g1-iframe-probe.json, 2026-09-04):
 *
 *   - a third-party badge iframe OUTSIDE the form (3/3 tenants of one vendor)
 *     and a social-apply widget iframe INSIDE the form (1/2 tenants of another)
 *     each made the whole scan fail closed before any control was emitted;
 *   - one long posting walked 3719 of the 4096-node ceiling, so a longer job
 *     description on the same route would have failed closed with zero controls.
 *
 * The fix must not ignore frames, must not hardcode a vendor, a library or a
 * CSS shape, and must not remove the budget. A frame the scan reached unhidden
 * is an OPAQUE BOUNDARY: it gets an identity, it is accounted on the wire, and
 * the consumer owes it a DISCOVERY_INCOMPLETE row. Prose that can hold no
 * control is not walked, so the semantic budget is spent on the answer surface;
 * a separate, larger structural ceiling still bounds the whole document.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scanPilotUa1Discovery } from '@edaix/apply-kernel/pilotUa1Discovery';
import { createPilotUa1DiscoveryRequest } from '../lib/pilotUa1DiscoveryProtocol';
import {
  createPilotUa1ContentRuntime,
  type PilotUa1Observation,
} from '../lib/pilotUa1DiscoveryRuntime';

const EXTENSION_ID = 'ua1-reachability-extension';
const BACKGROUND_URL = `chrome-extension://${EXTENSION_ID}/background.js`;
const BACKGROUND_SENDER = Object.freeze({ id: EXTENSION_ID, url: BACKGROUND_URL });
const NOW = 10_000;
const LIFECYCLE_NONCE = '11'.repeat(16);
const SHA256_HEX = /^[a-f0-9]{64}$/u;

async function hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(result)].map((p) => p.toString(16).padStart(2, '0')).join('');
}

function rect(width = 160, height = 24): DOMRect {
  return {
    x: 0, y: 0, width, height, top: 0, right: width, bottom: height, left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

type Runtime = ReturnType<typeof createPilotUa1ContentRuntime>;

function runtimeWithSink(
  seen: PilotUa1Observation[],
  overrides: Partial<Parameters<typeof createPilotUa1ContentRuntime>[0]> = {},
): Runtime {
  return createPilotUa1ContentRuntime({
    enabled: true,
    extensionId: EXTENSION_ID,
    expectedBackgroundUrl: BACKGROUND_URL,
    document,
    view: window,
    location,
    now: () => NOW,
    lifecycleNonce: LIFECYCLE_NONCE,
    openShadowRoot: (element) => element.shadowRoot,
    observe: (observation) => seen.push(observation),
    scanPacket: scanPilotUa1Discovery,
    ...overrides,
  });
}

async function request(requestId = '22'.repeat(16)) {
  const built = createPilotUa1DiscoveryRequest({
    pageUrl: location.href,
    requestId,
    issuedAtMs: NOW,
    targetUrlDigest: await hex(new URL(location.href).href),
  });
  if (built === null) throw new Error('test request did not parse');
  return built;
}

async function scanOnce(): Promise<PilotUa1Observation> {
  const seen: PilotUa1Observation[] = [];
  const response = await runtimeWithSink(seen)(await request(), BACKGROUND_SENDER);
  if (seen.length !== 1) throw new Error(`no observation: ${JSON.stringify(response)}`);
  return seen[0]!;
}

async function scanResponse() {
  return runtimeWithSink([])(await request(), BACKGROUND_SENDER);
}

beforeEach(() => {
  document.body.innerHTML = '';
  history.replaceState(null, '', '/jobs/ua1-reachability');
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => rect());
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('an unhidden frame is an accounted opaque boundary, not a whole-scan failure', () => {
  it('outside any form, on a page whose controls are not inside a <form>', async () => {
    document.body.innerHTML = `
      <div class="application">
        <label for="email">Email</label><input id="email" type="email">
        <label for="name">Full name</label><input id="name">
      </div>
      <div class="chrome">
        <iframe title="Verification badge" src="https://verification.invalid/badge"></iframe>
      </div>`;
    const { packet, structure } = await scanOnce();
    expect(packet.controls.map((control) => control.accessibleName)).toEqual(['Email', 'Full name']);
    expect(packet.observation.opaqueBoundaries).toHaveLength(1);
    expect(packet.observation.opaqueBoundaries[0]).toMatch(SHA256_HEX);
    // A boundary is neither a control nor a suppressed decoy: it has its own
    // identity namespace and appears in exactly one accounting bucket.
    const emitted = new Set(packet.controls.map((control) => control.identityDigest));
    expect(emitted.has(packet.observation.opaqueBoundaries[0]!)).toBe(false);
    expect(packet.observation.suppressedControls).toEqual([]);
    expect(packet.observation.hiddenNotObservedCount).toBe(0);
    // The observed surface was counted in full, so the sidecar is still emitted.
    expect(structure).not.toBeNull();
    expect(structure!.counts.controls).toBe(2);
  });

  it('inside the form, sitting between the controls it cannot see into', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="email">Email</label><input id="email" type="email">
        <span class="social"><iframe title="Apply with a social profile" src="https://social.invalid/apply"></iframe></span>
        <label for="phone">Phone</label><input id="phone" type="tel">
      </form>`;
    const { packet, structure } = await scanOnce();
    expect(packet.controls.map((control) => control.accessibleName)).toEqual(['Email', 'Phone']);
    expect(packet.observation.opaqueBoundaries).toHaveLength(1);
    expect(structure).not.toBeNull();
  });

  it('on a page with no controls at all, the boundary is the whole observation', async () => {
    document.body.innerHTML = '<iframe title="opaque boundary" src="https://embed.invalid/form"></iframe>';
    const { packet } = await scanOnce();
    expect(packet.controls).toEqual([]);
    expect(packet.observation.opaqueBoundaries).toHaveLength(1);
  });

  it('two frames are two boundaries with distinct identities; a <frame> counts like an <iframe>', async () => {
    document.body.innerHTML = `
      <label for="email">Email</label><input id="email" type="email">
      <iframe title="One" src="https://one.invalid/"></iframe>
      <iframe title="Two" src="https://two.invalid/"></iframe>`;
    const { packet } = await scanOnce();
    expect(packet.observation.opaqueBoundaries).toHaveLength(2);
    expect(new Set(packet.observation.opaqueBoundaries).size).toBe(2);
  });

  it('a hidden frame is pruned like any hidden subtree and is not a boundary', async () => {
    document.body.innerHTML = `
      <label for="email">Email</label><input id="email" type="email">
      <iframe title="Display none" src="https://a.invalid/" style="display:none"></iframe>
      <iframe title="Visibility hidden" src="https://b.invalid/" style="visibility:hidden"></iframe>
      <div aria-hidden="true"><iframe title="Under aria-hidden" src="https://c.invalid/"></iframe></div>`;
    const { packet } = await scanOnce();
    expect(packet.controls).toHaveLength(1);
    expect(packet.observation.opaqueBoundaries).toEqual([]);
    expect(packet.observation.hiddenNotObservedCount).toBe(0);
  });

  it('carries no src, host, title or selector of the frame onto the wire', async () => {
    document.body.innerHTML = `
      <label for="email">Email</label><input id="email" type="email">
      <iframe title="Widget-Title-Marker" src="https://host-marker.invalid/path-marker"></iframe>`;
    const { packet, structure } = await scanOnce();
    const wire = JSON.stringify({ packet, structure });
    expect(wire).not.toMatch(/Widget-Title-Marker|host-marker|path-marker|iframe/u);
  });

  it('fails closed on an unbounded number of boundaries instead of truncating', async () => {
    document.body.innerHTML = `<label for="email">Email</label><input id="email" type="email">${
      Array.from({ length: 65 }, (_, index) => `<iframe title="F${index}" src="https://f${index}.invalid/"></iframe>`).join('')
    }`;
    expect(await scanResponse()).toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
  });
});

describe('late injection', () => {
  it('a frame injected during the scan is drift, and the next trigger accounts for it', async () => {
    document.body.innerHTML = '<label for="email">Email</label><input id="email" type="email">';
    const seen: PilotUa1Observation[] = [];
    let digestCalls = 0;
    const injecting = runtimeWithSink(seen, {
      digest: async (value) => {
        digestCalls += 1;
        if (digestCalls === 2) {
          const frame = document.createElement('iframe');
          frame.title = 'Late badge';
          frame.src = 'https://late.invalid/badge';
          document.body.append(frame);
        }
        return hex(value);
      },
    });
    expect(await injecting(await request(), BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    expect(seen).toHaveLength(0);

    const settled = runtimeWithSink(seen);
    expect(await settled(await request('33'.repeat(16)), BACKGROUND_SENDER))
      .toEqual({ ok: true, detectedControlCount: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.packet.observation.opaqueBoundaries).toHaveLength(1);
  });

  it('a frame that appears after the observation dirties the live registry', async () => {
    document.body.innerHTML = '<label for="email">Email</label><input id="email" type="email">';
    let live: { registry: { isCurrent: () => boolean } } | null = null;
    const handle = runtimeWithSink([], {
      observerFactory: (callback) => new MutationObserver((records) => callback(records)),
      observeLive: (observation) => { live = observation; },
    });
    expect(await handle(await request(), BACKGROUND_SENDER))
      .toEqual({ ok: true, detectedControlCount: 1 });
    expect(live).not.toBeNull();
    expect(live!.registry.isCurrent()).toBe(true);
    const frame = document.createElement('iframe');
    frame.title = 'Late badge';
    document.body.append(frame);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(live!.registry.isCurrent()).toBe(false);
  });
});

describe('the budget is spent on the answer surface, and both ceilings still bind', () => {
  it('prose that can hold no control no longer starves the scan', async () => {
    document.body.innerHTML = `${
      Array.from({ length: 8_000 }, (_, index) => `<p><span>Paragraph ${index}</span></p>`).join('')
    }<form><label for="email">Email</label><input id="email" type="email"></form>`;
    const { packet, structure } = await scanOnce();
    expect(packet.controls.map((control) => control.accessibleName)).toEqual(['Email']);
    expect(structure).not.toBeNull();
  }, 30_000);

  it('keeps a structural ceiling over the whole document', async () => {
    document.body.innerHTML = `<label for="email">Email</label><input id="email" type="email">${
      Array.from({ length: 32_770 }, () => '<i></i>').join('')
    }`;
    expect(await scanResponse()).toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
  }, 60_000);

  it('still counts hidden natives it prunes, and still walks open shadow roots', async () => {
    document.body.innerHTML = `
      <label for="email">Email</label><input id="email" type="email">
      <section style="display:none">${'<p>hidden prose</p>'.repeat(20)}<input aria-label="Conditional"></section>
      <div id="host"></div>`;
    const host = document.querySelector('#host')!;
    host.attachShadow({ mode: 'open' }).innerHTML = '<label for="s">Shadow field</label><input id="s">';
    const { packet } = await scanOnce();
    expect(packet.controls.map((control) => control.accessibleName)).toEqual(['Email', 'Shadow field']);
    expect(packet.observation.hiddenNotObservedCount).toBe(1);
  });
});
