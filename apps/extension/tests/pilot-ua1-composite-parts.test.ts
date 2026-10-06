// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scanPilotUa1Discovery } from '@edaix/apply-kernel/pilotUa1Discovery';
import { compileGraph } from '../../../packages/apply-kernel/src/semantic/graph';
import { sha256 } from '../../../packages/apply-kernel/tests/semantic/harness';
import { createPilotUa1DiscoveryRequest } from '../lib/pilotUa1DiscoveryProtocol';
import {
  createPilotUa1ContentRuntime,
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


function questionCount(observation: PilotUa1Observation) {
  const result = compileGraph([{ cause: 'USER_TRIGGER', binding: observation.packet.binding,
    controls: observation.packet.controls, structure: observation.structure,
    suppressedControls: observation.packet.observation.suppressedControls,
    hiddenNotObservedCount: observation.packet.observation.hiddenNotObservedCount,
    attributedAddRowGroup: null }], sha256);
  if (!result.ok) throw new Error(result.reason);
  return result.graph.nodes.filter(node => node.kind === 'QUESTION').length;
}
const trigger = '<input aria-label="City" role="combobox" aria-expanded="true" aria-controls="locations">';
describe('UA-1 explicitly owned popup parts are one logical question', () => {
  it.each(['document', 'shadow', 'inline'])('accounts popup and options by identity in %s', async (surface) => {
    if (surface === 'shadow') {
      document.body.innerHTML = '<div id="host"></div>';
      document.querySelector('#host')!.attachShadow({ mode: 'open' }).innerHTML = trigger + externalList;
    } else document.body.innerHTML = surface === 'inline'
      ? `<div aria-label="City" role="combobox" aria-controls="locations">${externalList}</div>`
      : trigger + externalList;
    const { response, seen } = await scan();
    expect(response.ok).toBe(true);
    expect(questionCount(seen[0]!)).toBe(1);
    expect(seen[0]!.packet.controls).toHaveLength(1);
    expect(seen[0]!.packet.observation.suppressedControls).toHaveLength(3);
    expect(comboboxOptions(seen[0]!)).toEqual(['Remote', 'On site']);
  });
  it.each([
    { scenario: 'shared popup', markup: trigger + trigger + externalList },
    { scenario: 'independently named popup', markup: trigger + externalList.replace('id="locations"', 'id="locations" aria-label="Citizenship"') },
    { scenario: 'conflicting secondary popup caption', markup: trigger + '<fieldset><legend>Citizenship</legend>' + externalList.replace('id="locations"', 'id="locations" aria-label="City"') + '</fieldset>' },
    { scenario: 'mismatched popup multiplicity', markup: trigger + externalList.replace('id="locations"', 'id="locations" aria-multiselectable="true"') },
    { scenario: 'hidden member', markup: trigger + externalList.replace('<li role="option">Remote', '<li role="option" hidden>Remote') },
    { scenario: 'missing relation', markup: trigger.replace('aria-controls="locations"', '') + externalList },
    { scenario: 'collapsed owner', markup: trigger.replace('aria-expanded="true"', 'aria-expanded="false"') + externalList },
    { scenario: 'standalone listbox', markup: externalList },
    { scenario: 'owner is hidden', markup: trigger.replace('<input ', '<input hidden ') + externalList },
  ])('retains uncertain question ownership: $scenario', async ({ markup }) => {
    document.body.innerHTML = markup;
    const { response, seen } = await scan();
    expect(response.ok).toBe(true);
    expect(seen[0]!.packet.observation.suppressedControls).toHaveLength(0);
  });
  it.each(['native', 'editable'])('preserves an independent %s field carrying role=option', async (kind) => {
    document.body.innerHTML = trigger + '<ul role="listbox" id="locations"><li role="option">Remote</li>' +
      (kind === 'native' ? '<input role="option" aria-label="On site">' : '<div role="option" contenteditable="true">On site</div>') + '</ul>';
    const { response, seen } = await scan();
    expect(response.ok).toBe(true);
    // A native field may own the listbox as its visible proxy, so that
    // popup is not an emitted anchor and its parts remain unproven.
    expect(questionCount(seen[0]!)).toBe(kind === 'native' ? 3 : 2);
    expect(seen[0]!.packet.controls).toHaveLength(kind === 'native' ? 3 : 2);
    expect(seen[0]!.packet.controls.some(control => control.inputType === (kind === 'native' ? 'text' : null) && control.role === 'option' && (kind === 'native' || control.accessibleName === 'On site'))).toBe(true);
    expect(seen[0]!.packet.observation.suppressedControls).toHaveLength(kind === 'native' ? 0 : 2);
  });
});
