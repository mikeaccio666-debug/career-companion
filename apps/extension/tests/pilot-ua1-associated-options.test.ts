// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scanPilotUa1Discovery } from '@edaix/apply-kernel/pilotUa1Discovery';
import { compileGraph } from '../../../packages/apply-kernel/src/semantic/graph';
import { sha256 } from '../../../packages/apply-kernel/tests/semantic/harness';
import { createPilotUa1DiscoveryRequest } from '../lib/pilotUa1DiscoveryProtocol';
import {
  createPilotUa1ContentRuntime,
  type PilotUa1LiveObservation,
  type PilotUa1Observation,
} from '../lib/pilotUa1DiscoveryRuntime';

const EXTENSION_ID = 'ua1-associated-options';
const BACKGROUND_URL = `chrome-extension://${EXTENSION_ID}/background.js`;
const SENDER = Object.freeze({ id: EXTENSION_ID, url: BACKGROUND_URL });
const NOW = 10_000;

async function hex(value: string): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function scan(overrides: Partial<Parameters<typeof createPilotUa1ContentRuntime>[0]> = {}) {
  const seen: PilotUa1Observation[] = [];
  const request = createPilotUa1DiscoveryRequest({
    pageUrl: location.href,
    requestId: '22'.repeat(16),
    issuedAtMs: NOW,
    targetUrlDigest: await hex(new URL(location.href).href),
  });
  if (request === null) throw new Error('TEST_REQUEST_INVALID');
  const handle = createPilotUa1ContentRuntime({
    enabled: true,
    extensionId: EXTENSION_ID,
    expectedBackgroundUrl: BACKGROUND_URL,
    document,
    view: window,
    location,
    now: () => NOW,
    lifecycleNonce: '11'.repeat(16),
    openShadowRoot: (element) => element.shadowRoot,
    scanPacket: scanPilotUa1Discovery,
    observe: (observation) => seen.push(observation),
    ...overrides,
  });
  return { response: await handle(request, SENDER), seen };
}

function comboboxOptions(observation: PilotUa1Observation) {
  const compiled = compileGraph([{
    cause: 'USER_TRIGGER',
    binding: observation.packet.binding,
    controls: observation.packet.controls,
    structure: observation.structure,
    suppressedControls: observation.packet.observation.suppressedControls,
    hiddenNotObservedCount: observation.packet.observation.hiddenNotObservedCount,
    attributedAddRowGroup: null,
  }], sha256);
  if (!compiled.ok) throw new Error(compiled.reason);
  const question = compiled.graph.nodes.find(
    (node) => node.kind === 'QUESTION' && node.control.kind === 'COMBOBOX',
  );
  if (question?.kind !== 'QUESTION') throw new Error('TEST_COMBOBOX_MISSING');
  return question.control.options.map((option) => option.accessibleName);
}

const externalList = `<ul role="listbox" id="locations">
  <li role="option">Remote</li><li role="option">On site</li>
</ul>`;

beforeEach(() => {
  document.body.innerHTML = '';
  history.replaceState(null, '', '/jobs/associated-options');
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, width: 160, height: 24, top: 0, right: 160, bottom: 24, left: 0,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('UA-1 explicitly associated combobox options', () => {
  it('carries portalled listbox options through the real scanner and compiler', async () => {
    document.body.innerHTML = `
      <label for="location">Work location</label>
      <input id="location" role="combobox" aria-expanded="true" aria-controls="locations">
      ${externalList}
      <ul role="listbox"><li role="option">Unrelated option</li></ul>`;
    const click = vi.spyOn(HTMLElement.prototype, 'click');
    const dispatch = vi.spyOn(EventTarget.prototype, 'dispatchEvent');
    const { response, seen } = await scan();
    expect(response.ok).toBe(true);
    expect(comboboxOptions(seen[0]!)).toEqual(['Remote', 'On site']);
    expect(click).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(document.querySelector('input')!.value).toBe('');
  });

  it('keeps the stable observed option set as exact content-local references', async () => {
    document.body.innerHTML = `<input aria-label="Work location" role="combobox"
      aria-expanded="true" aria-controls="locations">${externalList}`;
    const live: PilotUa1LiveObservation[] = [];
    const { response } = await scan({ observeLive: (observation) => live.push(observation) });
    expect(response.ok).toBe(true);
    const control = live[0]!.observation.packet.controls[0]!;
    const entry = live[0]!.observation.structure!.entries[0]!;
    const optionElements = [...document.querySelectorAll('[role="option"]')];

    const resolved = live[0]!.registry.resolveOptionsForWrite({
      identityDigest: control.identityDigest,
      elementToken: entry.elementToken,
    });

    expect(resolved?.options.map((option) => option.identityDigest))
      .toEqual(control.options.map((option) => option.identityDigest));
    expect(resolved?.options.map((option) => option.element)).toEqual(optionElements);
    expect(resolved?.container).toBe(document.querySelector('#locations'));
    expect(live[0]!.registry.resolveOptionsForWrite({
      identityDigest: control.identityDigest,
      elementToken: '00'.repeat(32),
    })).toBeNull();
  });
  it('uses the same shadow tree even when the document has a conflicting id', async () => {
    document.body.innerHTML = `<div id="host"></div>
      <ul role="listbox" id="locations"><li role="option">Wrong tree</li></ul>`;
    document.querySelector('#host')!.attachShadow({ mode: 'open' }).innerHTML = `
      <input aria-label="Work location" role="combobox" aria-controls="locations">
      ${externalList}`;
    const { response, seen } = await scan();
    expect(response.ok).toBe(true);
    expect(comboboxOptions(seen[0]!)).toEqual(['Remote', 'On site']);
  });

  it('does not duplicate a listbox already inside its combobox', async () => {
    document.body.innerHTML = `<div role="combobox" aria-label="Work location" aria-controls="locations">
      ${externalList}</div>`;
    const { response, seen } = await scan();
    expect(response.ok).toBe(true);
    expect(comboboxOptions(seen[0]!)).toEqual(['Remote', 'On site']);
  });

  it('uses the declared popup instead of harvesting another nested widget', async () => {
    document.body.innerHTML = `<div role="combobox" aria-label="Work location" aria-controls="locations">
      <div role="listbox"><div role="option">Another widget</div></div>
    </div>${externalList}`;
    const { response, seen } = await scan();
    expect(response.ok).toBe(true);
    expect(comboboxOptions(seen[0]!)).toEqual(['Remote', 'On site']);
  });

  it('supports the explicit legacy aria-owns popup relation', async () => {
    document.body.innerHTML = `<input aria-label="Work location" role="combobox" aria-owns="locations">${externalList}`;
    const { response, seen } = await scan();
    expect(response.ok).toBe(true);
    expect(comboboxOptions(seen[0]!)).toEqual(['Remote', 'On site']);
  });

  it('does not fall back to local options when its explicit popup is missing', async () => {
    document.body.innerHTML = `<div role="combobox" aria-label="Work location" aria-controls="missing">
      <div role="listbox"><div role="option">Another widget</div></div></div>`;
    const { response, seen } = await scan();
    expect(response.ok).toBe(true);
    expect(comboboxOptions(seen[0]!)).toEqual([]);
  });

  it('prefers aria-controls over a stale legacy aria-owns relation', async () => {
    document.body.innerHTML = `<input aria-label="Work location" role="combobox" aria-controls="locations" aria-owns="old">${externalList}
      <ul id="old" role="listbox"><li role="option">Stale widget</li></ul>`;
    const { response, seen } = await scan();
    expect(response.ok).toBe(true);
    expect(comboboxOptions(seen[0]!)).toEqual(['Remote', 'On site']);
  });

  it('never follows an id reference into a different shadow tree', async () => {
    document.body.innerHTML = `<input aria-label="Work location" role="combobox" aria-controls="locations"><div id="host"></div>`;
    document.querySelector('#host')!.attachShadow({ mode: 'open' }).innerHTML = externalList;
    const { response, seen } = await scan();
    expect(response.ok).toBe(true);
    expect(comboboxOptions(seen[0]!)).toEqual([]);
  });

  it('rejects multiple distinct popup lists instead of mixing their options', async () => {
    document.body.innerHTML = `<input aria-label="Work location" role="combobox" aria-controls="locations other">${externalList}
      <ul role="listbox" id="other"><li role="option">Another widget</li></ul>`;
    const { response, seen } = await scan();
    expect(response).toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
    expect(seen).toEqual([]);
  });

  it.each(['document', 'shadow'] as const)(
    'rejects an ambiguous popup id in the same %s tree', async (tree) => {
      const markup = `<input aria-label="Work location" role="combobox" aria-controls="locations">
        ${externalList}<ul role="listbox" id="locations"><li role="option">Wrong list</li></ul>`;
      if (tree === 'document') document.body.innerHTML = markup;
      else {
        document.body.innerHTML = '<div id="host"></div>';
        document.querySelector('#host')!.attachShadow({ mode: 'open' }).innerHTML = markup;
      }
      const { response, seen } = await scan();
      expect(response).toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
      expect(seen).toEqual([]);
    },
  );

  it.each(['<div id="locations"></div>', '<ul id="locations" role="listbox" hidden></ul>'])(
    'rejects a duplicate id even when the duplicate is not an available listbox: %s', async (duplicate) => {
      document.body.innerHTML = `<input aria-label="Work location" role="combobox" aria-controls="locations">
        ${externalList}${duplicate}`;
      const { response, seen } = await scan();
      expect(response).toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
      expect(seen).toEqual([]);
    },
  );

  it('allows a repeated reference to one uniquely identified popup', async () => {
    document.body.innerHTML = `<input aria-label="Work location" role="combobox" aria-controls="locations locations">${externalList}`;
    const { response, seen } = await scan();
    expect(response.ok).toBe(true);
    expect(comboboxOptions(seen[0]!)).toEqual(['Remote', 'On site']);
  });

  it('keeps a bound on id references, even when most do not exist', async () => {
    document.body.innerHTML = `<input aria-label="Work location" role="combobox" aria-controls="${
      Array.from({ length: 17 }, (_, index) => `list${index}`).join(' ')
    }">`;
    const { response, seen } = await scan();
    expect(response).toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
    expect(seen).toEqual([]);
  });

  it('excludes hidden options without revealing their text on the wire', async () => {
    document.body.innerHTML = `<input aria-label="Work location" role="combobox" aria-controls="locations">
      <ul role="listbox" id="locations"><li role="option">Remote</li>
        <li role="option" style="display:none">PRIVATE_HIDDEN_OPTION</li></ul>`;
    const live: PilotUa1LiveObservation[] = [];
    const { response, seen } = await scan({
      observeLive: (observation) => live.push(observation),
    });
    expect(response.ok).toBe(true);
    expect(comboboxOptions(seen[0]!)).toEqual(['Remote']);
    expect(JSON.stringify(seen[0])).not.toContain('PRIVATE_HIDDEN_OPTION');
    const control = live[0]!.observation.packet.controls[0]!;
    const entry = live[0]!.observation.structure!.entries[0]!;
    // Discovery remains useful, but an observed hidden member prevents this
    // DOM window from becoming exact write membership.
    expect(live[0]!.registry.resolveOptionsForWrite({
      identityDigest: control.identityDigest,
      elementToken: entry.elementToken,
    })).toBeNull();
  });

  it('does not borrow a shared popup while its combobox explicitly reports collapsed', async () => {
    document.body.innerHTML = `<input aria-label="Work location" role="combobox" aria-expanded="false" aria-controls="locations">${externalList}`;
    const { response, seen } = await scan();
    expect(response.ok).toBe(true);
    expect(comboboxOptions(seen[0]!)).toEqual([]);
  });

  it('does not absorb another listbox nested inside the declared popup', async () => {
    document.body.innerHTML = `<input aria-label="Work location" role="combobox" aria-controls="locations">
      <ul role="listbox" id="locations"><li role="option">Remote</li>
        <li><ul role="listbox"><li role="option">Another widget</li></ul></li></ul>`;
    const { response, seen } = await scan();
    expect(response.ok).toBe(true);
    expect(comboboxOptions(seen[0]!)).toEqual(['Remote']);
  });

  it.each([
    '<ul role="listbox" id="locations" hidden><li role="option">Hidden option</li></ul>',
    '<ul id="locations"><li role="option">Not a listbox</li></ul>',
    '<ul role="listbox" id="another"><li role="option">Unrelated option</li></ul>',
  ])('does not infer options from an unavailable or unrelated popup: %s', async (popup) => {
    document.body.innerHTML = `<input aria-label="Work location" role="combobox" aria-controls="locations">${popup}`;
    const { response, seen } = await scan();
    expect(response.ok).toBe(true);
    expect(comboboxOptions(seen[0]!)).toEqual([]);
  });

  it('rejects mutation of the associated options during the scan', async () => {
    document.body.innerHTML = `<input aria-label="Work location" role="combobox" aria-controls="locations">${externalList}`;
    let calls = 0;
    const { response, seen } = await scan({
      digest: async (value) => {
        calls += 1;
        if (calls === 2) {
          document.querySelector('[role="option"]')!.textContent = 'Changed';
        }
        return hex(value);
      },
    });
    expect(response).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    expect(seen).toEqual([]);
  });

  it('invalidates an observed registry when the popup association changes', async () => {
    document.body.innerHTML = `<input aria-label="Work location" role="combobox" aria-controls="locations">${externalList}`;
    const live: PilotUa1LiveObservation[] = [];
    const { response } = await scan({ observeLive: (observation) => live.push(observation) });
    expect(response.ok).toBe(true);
    expect(live[0]!.registry.isCurrent()).toBe(true);
    document.querySelector('input')!.setAttribute('aria-controls', 'another');
    expect(live[0]!.registry.isCurrent()).toBe(false);
    live[0]!.registry.dispose();
  });
});
