// @vitest-environment happy-dom
/**
 * A2 — visible-surface enumeration and value-free drop accounting.
 *
 * Regression-first. Each case below was reproduced against the real scanner
 * first: a required question that a human can plainly see disappears from the
 * packet entirely, and the wire has no field that could report the drop, so
 * downstream coverage reads as complete. That is the false-green this closes.
 *
 * What must NOT change: a honeypot stays suppressed, and a control that is
 * genuinely not focusable stays out. Widening the surface must not widen what
 * counts as fillable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scanPilotUa1Discovery } from '@edaix/apply-kernel/pilotUa1Discovery';
import { createPilotUa1DiscoveryRequest } from '../lib/pilotUa1DiscoveryProtocol';
import {
  createPilotUa1ContentRuntime,
  type PilotUa1Observation,
} from '../lib/pilotUa1DiscoveryRuntime';

const EXTENSION_ID = 'ua1-surface-extension';
const BACKGROUND_URL = `chrome-extension://${EXTENSION_ID}/background.js`;
const BACKGROUND_SENDER = Object.freeze({ id: EXTENSION_ID, url: BACKGROUND_URL });
const NOW = 10_000;
const LIFECYCLE_NONCE = '11'.repeat(16);

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

async function scanOnce(): Promise<PilotUa1Observation> {
  const seen: PilotUa1Observation[] = [];
  const handle = createPilotUa1ContentRuntime({
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
  });
  const request = createPilotUa1DiscoveryRequest({
    pageUrl: location.href,
    requestId: '22'.repeat(16),
    issuedAtMs: NOW,
    targetUrlDigest: await hex(new URL(location.href).href),
  });
  if (request === null) throw new Error('test request did not parse');
  const response = await handle(request, BACKGROUND_SENDER);
  if (seen.length !== 1) throw new Error(`no observation: ${JSON.stringify(response)}`);
  return seen[0]!;
}

beforeEach(() => {
  document.body.innerHTML = '';
  history.replaceState(null, '', '/jobs/ua1?step=1#form');
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => rect());
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('a visible question reaches the packet even when its native is visually hidden', () => {
  it('keeps a checkbox whose only visible surface carries no ARIA role', async () => {
    document.body.innerHTML = `
      <div class="field">
        <input type="checkbox" id="agree" style="opacity:0;position:absolute">
        <span class="box" aria-hidden="true"></span>
        <span>I agree to the terms</span>
      </div>`;
    const { packet } = await scanOnce();
    const checkbox = packet.controls.filter((control) => control.inputType === 'checkbox');
    expect(checkbox, 'the whole question vanished from the packet').toHaveLength(1);
    expect(checkbox[0]!.accessibleName).toBe('I agree to the terms');
  });

  it('keeps an anonymous file input behind a styled activator', async () => {
    document.body.innerHTML = `
      <div class="dropzone">
        <button type="button">Attach a file</button>
        <input type="file" style="opacity:0;width:1px;height:1px">
      </div>`;
    const { packet } = await scanOnce();
    const file = packet.controls.filter((control) => control.inputType === 'file');
    expect(file, 'the anonymous file slot never reached the packet').toHaveLength(1);
    expect(file[0]!.accessibleName).toBe('Attach a file');
  });

  it('still refuses a honeypot and a genuinely unfocusable control', async () => {
    document.body.innerHTML = `
      <div class="field">
        <input type="checkbox" id="ok" style="opacity:0;position:absolute">
        <span>I agree to the terms</span>
      </div>
      <div class="field">
        <input aria-label="Website" style="opacity:0;position:absolute">
        <span>Please leave this field blank</span>
      </div>
      <div class="field">
        <input type="checkbox" style="display:none">
        <span>Never focusable</span>
      </div>`;
    const { packet } = await scanOnce();
    expect(packet.controls.map((control) => control.accessibleName))
      .toEqual(['I agree to the terms']);
  });
});

describe('drop accounting is reportable rather than silent', () => {
  it('reports a suppressed honeypot and a hidden native on the wire', async () => {
    document.body.innerHTML = `
      <label for="email">Email</label><input id="email" type="email">
      <label>Please leave this field blank<input aria-label="Website"></label>
      <input aria-label="Truly hidden" style="display:none">`;
    const { packet } = await scanOnce();
    expect(packet.controls).toHaveLength(1);
    expect(packet.observation.suppressedControls.length).toBe(1);
    expect(packet.observation.hiddenNotObservedCount).toBeGreaterThanOrEqual(1);
  });

  it('emits a sidecar with truthful counts once drops are reportable', async () => {
    document.body.innerHTML = `
      <label for="email">Email</label><input id="email" type="email">
      <label>Please leave this field blank<input aria-label="Website"></label>`;
    const observation = await scanOnce();
    expect(observation.structure).not.toBeNull();
    expect(observation.structure!.counts.suppressed)
      .toBe(observation.packet.observation.suppressedControls.length);
    expect(observation.structure!.counts.hiddenNotObserved)
      .toBe(observation.packet.observation.hiddenNotObservedCount);
  });

  it('carries no selector, HTML, text or value in the accounting block', async () => {
    document.body.innerHTML = `
      <label>Please leave this field blank<input aria-label="Website" name="trap_url"></label>
      <label for="e">Email</label><input id="e" type="email" value="alex@example.test">`;
    const { packet } = await scanOnce();
    const serialized = JSON.stringify(packet.observation);
    for (const secret of ['trap_url', 'Website', 'leave this field blank', 'alex@example.test']) {
      expect(serialized, `accounting leaked ${secret}`).not.toContain(secret);
    }
  });
});

describe('author-declared file acceptance is a closed shape, never its text', () => {
  it('classifies a document accept list without carrying the list', async () => {
    document.body.innerHTML = `
      <label for="cv">Resume</label><input id="cv" type="file" accept=".pdf,.doc,.docx">`;
    const { packet } = await scanOnce();
    expect(packet.controls[0]!.fileAccept).toBe('DOCUMENT');
    expect(JSON.stringify(packet.controls[0])).not.toContain('pdf');
  });

  it('separates image-only and unrestricted file slots', async () => {
    document.body.innerHTML = `
      <label for="photo">Photo</label><input id="photo" type="file" accept="image/*">
      <label for="any">Anything</label><input id="any" type="file">`;
    const { packet } = await scanOnce();
    expect(packet.controls.map((control) => control.fileAccept)).toEqual(['IMAGE', 'ANY']);
  });

  it('reports a mixed or unrecognized accept list as OTHER, never as a guess', async () => {
    document.body.innerHTML = `
      <label for="mix">Mixed</label><input id="mix" type="file" accept=".pdf,image/png">
      <label for="odd">Odd</label><input id="odd" type="file" accept=".xyz">`;
    const { packet } = await scanOnce();
    expect(packet.controls.map((control) => control.fileAccept)).toEqual(['OTHER', 'OTHER']);
  });

  it('leaves fileAccept null for every control that is not a file input', async () => {
    document.body.innerHTML = '<label for="t">Name</label><input id="t">';
    const { packet } = await scanOnce();
    expect(packet.controls[0]!.fileAccept).toBeNull();
  });
});

describe('a narrow but focusable control is not a honeypot', () => {
  it('keeps a few-pixel-wide search input inside a listbox-owning wrapper', async () => {
    document.body.innerHTML = `
      <label for="country">Country</label>
      <div class="control">
        <div class="value">United States</div>
        <input id="country" role="combobox" aria-expanded="false" aria-controls="opts">
      </div>
      <div id="opts" role="listbox" hidden></div>`;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this.id === 'country' ? rect(4, 20) : rect();
    });
    const { packet } = await scanOnce();
    const combobox = packet.controls.filter((control) => control.role === 'combobox');
    expect(combobox, 'a narrow but focusable combobox input was dropped').toHaveLength(1);
    expect(combobox[0]!.accessibleName).toBe('Country');
  });
});

describe('an unprovable prune withholds the sidecar rather than understating it', () => {
  it('counts a provably-scanned hidden subtree exactly and still emits a sidecar', async () => {
    document.body.innerHTML = `
      <label for="ok">Email</label><input id="ok" type="email">
      <div style="display:none"><input aria-label="a"><input aria-label="b"></div>`;
    const observation = await scanOnce();
    expect(observation.packet.controls).toHaveLength(1);
    expect(observation.packet.observation.hiddenNotObservedCount).toBe(2);
    expect(observation.structure, 'a provable prune should still conserve').not.toBeNull();
    expect(observation.structure!.counts.hiddenNotObserved).toBe(2);
  });

  it('emits no sidecar when the hidden subtree is too large to prove', async () => {
    const deep = Array.from({ length: 400 }, () => '<div>').join('')
      + '<input aria-label="buried">'
      + Array.from({ length: 400 }, () => '</div>').join('');
    document.body.innerHTML = `
      <label for="ok2">Email</label><input id="ok2" type="email">
      <div style="display:none">${deep}</div>`;
    const observation = await scanOnce();
    expect(
      observation.structure,
      'an unprovable prune was reported as an exact conservation count',
    ).toBeNull();
  });
});

describe('the prune probe crosses shadow boundaries it can open', () => {
  it('counts a control inside a pruned shadow root instead of proving it absent', async () => {
    document.body.innerHTML = `
      <label for="ok5">Email</label><input id="ok5" type="email">
      <div id="shost" style="display:none"></div>`;
    document.getElementById('shost')!.attachShadow({ mode: 'open' }).innerHTML =
      '<input aria-label="hidden shadow">';
    const observation = await scanOnce();
    expect(observation.packet.controls).toHaveLength(1);
    expect(observation.packet.observation.hiddenNotObservedCount).toBe(1);
    expect(observation.structure!.counts.hiddenNotObserved).toBe(1);
  });
});

describe('a fieldset-disabled control is not answerable', () => {
  it('refuses an ordinary descendant of a disabled fieldset', async () => {
    document.body.innerHTML = `
      <label for="live">Email</label><input id="live" type="email">
      <fieldset disabled>
        <div class="field">
          <input type="checkbox" id="dead" style="opacity:0;position:absolute">
          <span>I agree to the terms</span>
        </div>
      </fieldset>`;
    const { packet } = await scanOnce();
    expect(
      packet.controls.map((control) => control.accessibleName),
      'a fieldset-disabled control was admitted as answerable',
    ).toEqual(['Email']);
  });

  it('follows the HTML first-legend exception inside a disabled fieldset', async () => {
    document.body.innerHTML = `
      <fieldset disabled>
        <legend>
          <div class="field">
            <input type="checkbox" id="legendbox" style="opacity:0;position:absolute">
            <span>Enable this section</span>
          </div>
        </legend>
        <label for="inner">Inner</label><input id="inner">
      </fieldset>`;
    const observation = await scanOnce();
    const byName = new Map(observation.packet.controls.map((c, i) => [c.accessibleName, i]));
    // The first legend escapes the inheritance, so its hidden checkbox is still
    // rescued by its field-group surface. The body control stays visible and is
    // still emitted -- disabled is evidence about a control, not a reason to
    // drop it -- but it is marked disabled and the legend control is not.
    expect(byName.has('Enable this section'), 'the first-legend exception was not applied').toBe(true);
    expect(byName.has('Inner')).toBe(true);
    const entries = observation.structure!.entries;
    expect(entries[byName.get('Enable this section')!]!.disabled).toBe(false);
    expect(entries[byName.get('Inner')!]!.disabled).toBe(true);
  });

  it('never lets the proxy path and the sidecar evidence disagree', async () => {
    document.body.innerHTML = `
      <fieldset disabled>
        <label for="sel">Country</label>
        <select id="sel"><option value="us">United States</option></select>
      </fieldset>`;
    const observation = await scanOnce();
    for (const entry of observation.structure?.entries ?? []) {
      expect(entry.disabled, 'sidecar evidence disagreed with proxy admission').toBe(true);
    }
  });
});

describe('the field-group fallback needs exactly one answerable target', () => {
  it('refuses a wrapper whose only controls are hidden activators', async () => {
    document.body.innerHTML = `
      <label for="real">Email</label><input id="real" type="email">
      <div class="field">
        <button type="submit" style="opacity:0;position:absolute">Continue</button>
        <button type="button" style="opacity:0;position:absolute">Cancel</button>
        <span>Ready to continue?</span>
      </div>`;
    const { packet } = await scanOnce();
    expect(
      packet.controls.map((control) => control.accessibleName),
      'an activator-only wrapper became a visible question',
    ).toEqual(['Email']);
  });
});

describe('an invalid accept declaration is never read as unrestricted', () => {
  const shapes = async () => (await scanOnce()).packet.controls.map((c) => c.fileAccept);

  it('maps comma-only, trailing-comma and mixed-empty declarations to OTHER', async () => {
    document.body.innerHTML = `
      <label for="f1">A</label><input id="f1" type="file" accept=",">
      <label for="f2">B</label><input id="f2" type="file" accept=".pdf,">
      <label for="f3">C</label><input id="f3" type="file" accept=".pdf,,.doc">`;
    expect(await shapes()).toEqual(['OTHER', 'OTHER', 'OTHER']);
  });

  it('maps unknown and mixed recognized/unknown tokens to OTHER', async () => {
    document.body.innerHTML = `
      <label for="g1">A</label><input id="g1" type="file" accept=".xyz">
      <label for="g2">B</label><input id="g2" type="file" accept=".pdf,.xyz">`;
    expect(await shapes()).toEqual(['OTHER', 'OTHER']);
  });

  it('still maps an absent or whitespace-only declaration to ANY', async () => {
    document.body.innerHTML = `
      <label for="h1">A</label><input id="h1" type="file">
      <label for="h2">B</label><input id="h2" type="file" accept="   ">`;
    expect(await shapes()).toEqual(['ANY', 'ANY']);
  });
});

describe('fieldset disabled inheritance stops at the tree boundary', () => {
  // A light-DOM <fieldset disabled> disables descendants in its own tree. It
  // does not reach into the shadow root of a descendant host: that is a
  // separate tree, and its controls stay answerable. Crossing the boundary here
  // would mark a live field disabled and then drop it for not being focusable.
  it('does not disable a native inside a descendant host shadow root', async () => {
    document.body.innerHTML = `
      <label for="live">Email</label><input id="live" type="email">
      <fieldset disabled><div id="shost"></div></fieldset>`;
    document.getElementById('shost')!.attachShadow({ mode: 'open' }).innerHTML = `
      <div class="field">
        <input type="checkbox" style="opacity:0;position:absolute">
        <span>I agree to the terms</span>
      </div>`;
    const observation = await scanOnce();
    const names = observation.packet.controls.map((c) => c.accessibleName);
    expect(names, 'an outer light-DOM fieldset disabled a shadow-root native')
      .toContain('I agree to the terms');
    const index = names.indexOf('I agree to the terms');
    // Proxy admission and sidecar evidence must agree: admitted implies enabled.
    expect(observation.structure!.entries[index]!.disabled).toBe(false);
  });

  it('still disables a native under a disabled fieldset in its own shadow tree', async () => {
    document.body.innerHTML = '<div id="shost2"></div>';
    document.getElementById('shost2')!.attachShadow({ mode: 'open' }).innerHTML = `
      <fieldset disabled>
        <label for="inner">Inner</label><input id="inner">
      </fieldset>`;
    const observation = await scanOnce();
    const names = observation.packet.controls.map((c) => c.accessibleName);
    expect(names).toEqual(['Inner']);
    expect(
      observation.structure!.entries[0]!.disabled,
      'same-tree fieldset inheritance was lost',
    ).toBe(true);
  });

  it('keeps the first-direct-legend exception scoped to the same tree', async () => {
    document.body.innerHTML = '<div id="shost3"></div>';
    document.getElementById('shost3')!.attachShadow({ mode: 'open' }).innerHTML = `
      <fieldset disabled>
        <legend><label for="lg">Enable</label><input id="lg"></legend>
        <label for="body">Body</label><input id="body">
      </fieldset>`;
    const observation = await scanOnce();
    const names = observation.packet.controls.map((c) => c.accessibleName);
    const entries = observation.structure!.entries;
    expect(entries[names.indexOf('Enable')]!.disabled).toBe(false);
    expect(entries[names.indexOf('Body')]!.disabled).toBe(true);
  });
});
