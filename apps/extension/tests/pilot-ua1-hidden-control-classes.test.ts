// @vitest-environment happy-dom
/**
 * Hidden natives are not one class. Regression-first, against the real scanner.
 *
 * Measured 2026-09-05 on ten public candidate pages (clone probe mirroring this
 * scanner, value-free): every page carried 4–11 hidden natives that the scan
 * pruned and counted in `hiddenNotObservedCount`, and UA-5 stopped all ten
 * runs. Three shapes made up that count:
 *
 *   A · the author's own declaration that an element is not a human input
 *       (`aria-hidden="true"` AND `tabindex="-1"`, the kernel's existing
 *       `isSiteDeclaredNonInput`) sitting beside exactly one visible answerable
 *       control in the same field container -- a validation shim or the native
 *       carrier behind a visible ARIA widget. It is a proxy of that visible
 *       control, not a second question, and today it inflated the "hidden
 *       questions" count that stops the run.
 *   · hidden activators (buttons): never a question by HTML semantics, and the
 *     scanner already says so (`isActivatorKind`), yet they were counted too.
 *   B/C · hidden natives that could be questions (conditional sections, natives
 *       with only half a declaration, unlabelled hidden inputs). These keep
 *       their exact count and the run still stops; this slice does not touch
 *       that semantic.
 *
 * What must NOT change: a shim with no visible control in reach stays an
 * honest hidden count; a partial declaration stays a hidden count; a visually
 * hidden but focusable file input behind a label is still emitted once; a
 * conditional question is re-discovered under a new DOM generation; nothing
 * about identity, authorization or readback moves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scanPilotUa1Discovery } from '@edaix/apply-kernel/pilotUa1Discovery';
import { createPilotUa1DiscoveryRequest } from '../lib/pilotUa1DiscoveryProtocol';
import {
  createPilotUa1ContentRuntime,
  type PilotUa1Observation,
} from '../lib/pilotUa1DiscoveryRuntime';

const EXTENSION_ID = 'ua1-hidden-classes-extension';
const BACKGROUND_URL = `chrome-extension://${EXTENSION_ID}/background.js`;
const BACKGROUND_SENDER = Object.freeze({ id: EXTENSION_ID, url: BACKGROUND_URL });
const NOW = 10_000;
const LIFECYCLE_NONCE = '33'.repeat(16);

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

/** One content-script lifecycle, so a second request lands in a new generation. */
function lifecycle() {
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
  let n = 0;
  return async (): Promise<PilotUa1Observation> => {
    n += 1;
    const request = createPilotUa1DiscoveryRequest({
      pageUrl: location.href,
      requestId: String(n).padStart(2, '0').repeat(16),
      issuedAtMs: NOW,
      targetUrlDigest: await hex(new URL(location.href).href),
    });
    if (request === null) throw new Error('test request did not parse');
    const before = seen.length;
    const response = await handle(request, BACKGROUND_SENDER);
    if (seen.length !== before + 1) {
      throw new Error(`scan produced no observation: ${JSON.stringify(response)}`);
    }
    return seen[seen.length - 1]!;
  };
}

const scanOnce = (): Promise<PilotUa1Observation> => lifecycle()();

const accounting = (observation: PilotUa1Observation) => ({
  controls: observation.packet.controls.map((control) => control.accessibleName),
  suppressed: observation.packet.observation.suppressedControls.length,
  hidden: observation.packet.observation.hiddenNotObservedCount,
  sidecar: observation.structure === null ? null : {
    suppressed: observation.structure.counts.suppressed,
    hiddenNotObserved: observation.structure.counts.hiddenNotObserved,
  },
});

/** The shape react-select leaves beside every combobox (measured on Greenhouse and Workable). */
const COMBOBOX_WITH_SHIM = `
  <div class="field">
    <label id="country-label" for="country">Country</label>
    <input id="country" type="text" role="combobox" aria-autocomplete="list" aria-labelledby="country-label">
    <input required tabindex="-1" aria-hidden="true" class="remix-css-1a0ro4n-requiredInput" value=""
           style="opacity:0;position:absolute;pointer-events:none">
  </div>`;

beforeEach(() => {
  document.body.innerHTML = '';
  history.replaceState(null, '', '/jobs/hidden-classes?step=1#form');
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => rect());
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('A · an author-declared non-input beside exactly one visible control is that control\'s shim', () => {
  it('suppresses a react-select validation shim by identity instead of counting a hidden question', async () => {
    document.body.innerHTML = COMBOBOX_WITH_SHIM;
    const observation = await scanOnce();
    expect(accounting(observation)).toEqual({
      controls: ['Country'],
      suppressed: 1,
      hidden: 0,
      sidecar: { suppressed: 1, hiddenNotObserved: 0 },
    });
    // Observed, deliberately not emitted, and never a second question: the
    // shim's identity is on the wire but shares nothing with the combobox.
    const [shim] = observation.packet.observation.suppressedControls;
    expect(observation.packet.controls.map((control) => control.identityDigest)).not.toContain(shim);
  });

  it('handles every widget on the page the same way, once each', async () => {
    document.body.innerHTML = COMBOBOX_WITH_SHIM + COMBOBOX_WITH_SHIM.replaceAll('country', 'state').replace('Country', 'State');
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: ['Country', 'State'], suppressed: 2, hidden: 0 });
    expect(new Set(observation.packet.observation.suppressedControls).size).toBe(2);
  });

  it('treats a declared native radio behind a visible ARIA radio as that radio\'s carrier, not a question', async () => {
    // Measured on Workable: the label wraps a hidden, declared native radio and
    // the visible role=radio the user actually operates.
    document.body.innerHTML = `
      <div role="radiogroup" aria-labelledby="auth-q">
        <span id="auth-q">Are you authorized to work here?</span>
        <label><input type="radio" name="auth" required tabindex="-1" aria-hidden="true" style="opacity:0">
          <span role="radio" tabindex="0" aria-checked="false" aria-label="Yes"></span></label>
        <label><input type="radio" name="auth" required tabindex="-1" aria-hidden="true" style="opacity:0">
          <span role="radio" tabindex="0" aria-checked="false" aria-label="No"></span></label>
      </div>`;
    const observation = await scanOnce();
    expect(observation.packet.controls.filter((control) => control.role === 'radio').map((c) => c.accessibleName))
      .toEqual(['Yes', 'No']);
    expect(observation.packet.controls.filter((control) => control.inputType === 'radio')).toHaveLength(0);
    expect(observation.packet.observation.suppressedControls).toHaveLength(2);
    expect(observation.packet.observation.hiddenNotObservedCount).toBe(0);
  });

  it('keeps an honest hidden count for a declared non-input with no visible control in reach', async () => {
    // Measured on Workable: three declared text inputs whose four nearest
    // ancestors hold no visible answerable control at all. The declaration
    // alone does not make it a shim of anything, so it is not dismissed.
    document.body.innerHTML = `
      <div class="field"><label>Phone
        <input type="text" tabindex="-1" aria-hidden="true" style="opacity:0"></label></div>
      <div class="field"><label for="e">Email</label><input id="e" type="email"></div>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: ['Email'], suppressed: 0, hidden: 1 });
  });

  it('never lets the form, body or a container with two visible controls stand in for a field container', async () => {
    document.body.innerHTML = `
      <form>
        <input type="text" tabindex="-1" aria-hidden="true" style="opacity:0">
        <label for="e">Email</label><input id="e" type="email">
      </form>
      <div class="pair">
        <input type="text" tabindex="-1" aria-hidden="true" style="opacity:0">
        <label for="a">First</label><input id="a">
        <label for="b">Last</label><input id="b">
      </div>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: ['Email', 'First', 'Last'], suppressed: 0, hidden: 2 });
  });
});

describe('ownership is shown against the final emitted questions, never a shared wrapper (independent review P2-2)', () => {
  it('does not attach an independently labelled field to a sibling field through a shared layout wrapper', async () => {
    document.body.innerHTML = `
      <div class="application-section">
        <div class="phone-field"><label>Phone<input type="tel" required aria-hidden="true" tabindex="-1"></label></div>
        <div class="email-field"><label>Email<input type="email"></label></div>
      </div>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: ['Email'], hidden: 1, suppressed: 0 });
  });

  it('does not attach a declared field to a visible honeypot that is itself suppressed', async () => {
    document.body.innerHTML = `
      <div>
        <label>Phone<input type="tel" required aria-hidden="true" tabindex="-1"></label>
        <label>Please leave this field blank<input aria-label="Website"></label>
      </div>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: [], hidden: 1, suppressed: 1 });
  });

  it('owns a declared native beside a lone label-wrapped question in the same parent (label-wrapping react-select variant)', async () => {
    document.body.innerHTML = `
      <div class="field">
        <label>Country<input type="text" role="combobox"></label>
        <input aria-hidden="true" tabindex="-1" style="opacity:0">
      </div>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: ['Country'], hidden: 0, suppressed: 1 });
  });

  it('fails closed at the existing 64 suppressed-identity ceiling instead of truncating', async () => {
    document.body.innerHTML = '<div><label>Country<input></label>' + '<input aria-hidden="true" tabindex="-1">'.repeat(65) + '</div>';
    await expect(scanOnce()).rejects.toThrow('PILOT_DISCOVERY_UNAVAILABLE');
    document.body.innerHTML = '<div><label>Country<input></label>' + '<input aria-hidden="true" tabindex="-1">'.repeat(64) + '</div>';
    const observation = await scanOnce();
    expect(accounting(observation)).toEqual({ controls: ['Country'], suppressed: 64, hidden: 0, sidecar: { suppressed: 64, hiddenNotObserved: 0 } });
    expect(new Set(observation.packet.observation.suppressedControls).size).toBe(64);
  });

  it('does not attach across kinds: a declared checkbox is not the shim of a text input', async () => {
    document.body.innerHTML = `
      <div class="field">
        <label for="city">City</label><input id="city" type="text">
        <input type="checkbox" aria-hidden="true" tabindex="-1" style="opacity:0">
      </div>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: ['City'], hidden: 1, suppressed: 0 });
  });

  it('never treats a declared file input as a shim, whatever sits beside it', async () => {
    document.body.innerHTML = `
      <div class="field">
        <label for="n">Name</label><input id="n" type="text">
        <input type="file" aria-hidden="true" tabindex="-1" style="opacity:0">
      </div>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: ['Name'], hidden: 1, suppressed: 0 });
  });

  it('accepts the measured Workable shape: a declared native inside the visible ARIA radio that owns it', async () => {
    document.body.innerHTML = `
      <div role="radiogroup" aria-labelledby="q">
        <span id="q">Are you authorized to work here?</span>
        <div role="radio" tabindex="0" aria-checked="false" aria-label="Yes">
          <label><input type="radio" name="auth" required aria-hidden="true" tabindex="-1" style="opacity:0"><span>Yes</span></label>
        </div>
        <div role="radio" tabindex="0" aria-checked="false" aria-label="No">
          <label><input type="radio" name="auth" required aria-hidden="true" tabindex="-1" style="opacity:0"><span>No</span></label>
        </div>
      </div>`;
    const observation = await scanOnce();
    expect(observation.packet.controls.filter((control) => control.role === 'radio').map((c) => c.accessibleName))
      .toEqual(['Yes', 'No']);
    expect(accounting(observation)).toMatchObject({ suppressed: 2, hidden: 0 });
  });

  it('does not let a group role own a declared native: a radiogroup ancestor is not a leaf widget', async () => {
    document.body.innerHTML = `
      <div role="radiogroup" aria-labelledby="q">
        <span id="q">Choice</span>
        <div><input type="radio" name="c" aria-hidden="true" tabindex="-1" style="opacity:0"><span>Only</span></div>
      </div>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ hidden: 1, suppressed: 0 });
  });
});

describe('an anchor is a visible, emitted, same-family leaf widget; a declared native with its own name is a field (incremental review P2-2)', () => {
  it('keeps two independently for-labelled fields under one parent as two fields', async () => {
    document.body.innerHTML = `
      <div>
        <label for="phone">Phone</label><input id="phone" type="tel" required aria-hidden="true" tabindex="-1">
        <label for="email">Email</label><input id="email" type="email">
      </div>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: ['Email'], hidden: 1, suppressed: 0 });
  });

  it.each(['aria-label="Phone"', 'aria-labelledby="phone-label"'])('treats a declared native carrying its own name (%s) as an independent field', async (naming) => {
    document.body.innerHTML = `
      <div class="field">
        <span id="phone-label">Phone</span>
        <input type="text" ${naming} aria-hidden="true" tabindex="-1" style="opacity:0">
        <label for="city">City</label><input id="city" type="text" role="combobox">
      </div>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: ['City'], hidden: 1, suppressed: 0 });
  });

  it.each(['file', 'password'] as const)('never lets an emitted %s input own a declared text native', async (type) => {
    document.body.innerHTML = `
      <div>
        <input aria-hidden="true" tabindex="-1">
        <label for="anchor">Independent ${type}</label><input id="anchor" type="${type}">
      </div>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ hidden: 1, suppressed: 0 });
  });

  it('never lets an emitted radiogroup container stand in for an answer-carrying radio leaf', async () => {
    document.body.innerHTML = `
      <div>
        <input type="radio" aria-hidden="true" tabindex="-1">
        <div role="radiogroup" aria-label="Unobserved choices"></div>
      </div>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ hidden: 1, suppressed: 0 });
  });

  it('never uses an emitted but visually hidden file proxy as a visible anchor, and keeps that proxy emitted', async () => {
    document.body.innerHTML = `
      <div>
        <input aria-hidden="true" tabindex="-1">
        <label for="resume">Resume</label><input id="resume" type="file" tabindex="0" style="opacity:0;position:absolute">
      </div>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: ['Resume'], hidden: 1, suppressed: 0 });
  });

  it('does not let an enclosing widget own a declared native when independent questions are emitted inside it (path parity)', async () => {
    // The scan emits Address, Street and City as three questions; the outer
    // combobox role alone is not proof that the hidden native is its carrier.
    document.body.innerHTML = `
      <div role="combobox" aria-label="Address" tabindex="0">
        <span role="textbox" aria-label="Street" tabindex="0"></span>
        <span role="textbox" aria-label="City" tabindex="0"></span>
        <input aria-hidden="true" tabindex="-1">
      </div>`;
    const observation = await scanOnce();
    expect(observation.packet.controls.map((c) => c.accessibleName)).toEqual(['Address', 'Street', 'City']);
    expect(accounting(observation)).toMatchObject({ hidden: 1, suppressed: 0 });
  });

  it('still lets a single enclosing leaf with nothing else inside own its declared carrier', async () => {
    document.body.innerHTML = `
      <div role="combobox" aria-label="Country" tabindex="0"><input aria-hidden="true" tabindex="-1"></div>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: ['Country'], hidden: 0, suppressed: 1 });
  });

  it('stops at the nearer enclosing leaf: other family or disabled is not owned, whatever the outer leaf is', async () => {
    document.body.innerHTML = `
      <div role="combobox" aria-label="Outer" tabindex="0">
        <span role="checkbox" aria-label="Separate" tabindex="0"><input aria-hidden="true" tabindex="-1"></span>
      </div>
      <div role="combobox" aria-label="Outer two" tabindex="0">
        <span role="textbox" aria-label="Disabled" aria-disabled="true" tabindex="0"><input aria-hidden="true" tabindex="-1"></span>
      </div>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ hidden: 2, suppressed: 0 });
  });

  it('treats a second question in the field container as ambiguity, not evidence', async () => {
    document.body.innerHTML = `
      <div class="field">
        <label for="a">First</label><input id="a" type="text" role="combobox">
        <input type="file" aria-label="Attachment">
        <input aria-hidden="true" tabindex="-1" style="opacity:0">
      </div>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: ['First', 'Attachment'], hidden: 1, suppressed: 0 });
  });
});

describe('a pure activator is the compiler\'s BUTTON kind, nothing wider (independent review P2-1)', () => {
  it.each(['surface', 'subtree'] as const)('keeps a hidden native file input counted even with role=button (%s)', async (where) => {
    const hidden = `<label for="resume">Resume</label><input id="resume" type="file" role="button" required ${where === 'surface' ? 'style="display:none"' : ''}>`;
    document.body.innerHTML = `<label>Email<input type="email"></label>` +
      (where === 'subtree' ? `<section style="display:none">${hidden}</section>` : hidden);
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: ['Email'], hidden: 1, suppressed: 0 });
  });

  it.each(['surface', 'subtree'] as const)('keeps a hidden native button with a real checkbox role counted (%s)', async (where) => {
    const hidden = `<button type="button" role="checkbox" aria-checked="false" aria-required="true" ${where === 'surface' ? 'style="display:none"' : ''}>May we contact you?</button>`;
    document.body.innerHTML = `<label>Email<input type="email"></label>` +
      (where === 'subtree' ? `<section style="display:none">${hidden}</section>` : hidden);
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: ['Email'], hidden: 1, suppressed: 0 });
  });

  it('still suppresses provable pure activators: a plain button, a submit, and role=button on a text input', async () => {
    document.body.innerHTML = `
      <label for="e">Email</label><input id="e" type="email">
      <button type="button" style="display:none">Add another</button>
      <input type="submit" role="button" value="Go" style="display:none">
      <div role="button" tabindex="0" style="display:none">Custom action</div>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: ['Email'], hidden: 0, suppressed: 3 });
  });
});

describe('hidden activators are not hidden questions', () => {
  it('suppresses a hidden button on the surface by identity and does not count one inside a pruned subtree', async () => {
    document.body.innerHTML = `
      <label for="e">Email</label><input id="e" type="email">
      <button type="button" style="display:none">Add another</button>
      <section style="display:none">
        <button type="button">Remove</button>
        <label for="c">Conditional</label><input id="c">
      </section>`;
    const observation = await scanOnce();
    // The conditional input is the only hidden question; both buttons are
    // observed and accounted, neither as a question.
    expect(accounting(observation)).toEqual({
      controls: ['Email'],
      suppressed: 1,
      hidden: 1,
      sidecar: { suppressed: 1, hiddenNotObserved: 1 },
    });
  });
});

describe('B/C · everything that could still be a question keeps its exact count', () => {
  it('counts a declared non-input inside a hidden subtree, where no attachment can be shown', async () => {
    document.body.innerHTML = `
      <label for="e">Email</label><input id="e" type="email">
      <section style="display:none">${COMBOBOX_WITH_SHIM}</section>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: ['Email'], suppressed: 0, hidden: 2 });
  });

  it('counts half a declaration as a hidden question', async () => {
    document.body.innerHTML = `
      <div class="field">
        <label id="l" for="c">Country</label>
        <input id="c" type="text" role="combobox" aria-labelledby="l">
        <input aria-hidden="true" tabindex="0" style="opacity:0;position:absolute">
      </div>
      <div class="field">
        <label for="f">Resume</label>
        <input id="f" type="file" tabindex="-1" style="clip-path:inset(50%);position:absolute">
      </div>
      <div class="field">
        <input type="checkbox" tabindex="-1" style="display:none">
        <span>Remote only</span>
      </div>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: ['Country'], suppressed: 0, hidden: 3 });
  });

  it('still refuses a honeypot and keeps a display:none conditional question counted', async () => {
    document.body.innerHTML = `
      <label for="e">Email</label><input id="e" type="email">
      <label>Please leave this field blank<input aria-label="Website"></label>
      <div style="display:none"><label for="deep">Buried</label><input id="deep"></div>`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: ['Email'], suppressed: 1, hidden: 1 });
  });
});

describe('what must not move', () => {
  it('still emits a visually hidden, focusable file input behind its label exactly once', async () => {
    document.body.innerHTML = `
      <label for="resume">Attach</label>
      <input id="resume" type="file" class="visually-hidden" tabindex="0" style="opacity:0;position:absolute">`;
    const observation = await scanOnce();
    expect(accounting(observation)).toMatchObject({ controls: ['Attach'], suppressed: 0, hidden: 0 });
  });

  it('re-discovers a shim that the host turns into a real control under the next generation', async () => {
    document.body.innerHTML = COMBOBOX_WITH_SHIM;
    const scan = lifecycle();
    const first = await scan();
    expect(accounting(first)).toMatchObject({ controls: ['Country'], suppressed: 1, hidden: 0 });
    const shim = document.querySelector<HTMLInputElement>('input[aria-hidden]')!;
    shim.removeAttribute('aria-hidden');
    shim.removeAttribute('tabindex');
    shim.setAttribute('aria-label', 'Region');
    shim.setAttribute('style', '');
    const second = await scan();
    expect(second.packet.binding.domGeneration).not.toBe(first.packet.binding.domGeneration);
    expect(accounting(second)).toMatchObject({ controls: ['Country', 'Region'], suppressed: 0, hidden: 0 });
  });

  it('re-discovers a conditional question when the host reveals it under the next generation', async () => {
    document.body.innerHTML = `
      <label for="e">Email</label><input id="e" type="email">
      <section id="cond" style="display:none"><label for="why">Why us?</label><input id="why"></section>`;
    const scan = lifecycle();
    const first = await scan();
    expect(accounting(first)).toMatchObject({ controls: ['Email'], hidden: 1 });
    document.querySelector('#cond')!.setAttribute('style', '');
    const second = await scan();
    expect(second.packet.binding.domGeneration).not.toBe(first.packet.binding.domGeneration);
    expect(accounting(second)).toMatchObject({ controls: ['Email', 'Why us?'], hidden: 0 });
  });

  it('carries no class name, id, attribute or vendor token for a suppressed shim', async () => {
    document.body.innerHTML = COMBOBOX_WITH_SHIM;
    const observation = await scanOnce();
    const serialized = JSON.stringify(observation);
    for (const secret of ['remix-css', 'requiredInput', 'aria-hidden', 'tabindex', 'pointer-events']) {
      expect(serialized, `wire leaked ${secret}`).not.toContain(secret);
    }
  });
});
