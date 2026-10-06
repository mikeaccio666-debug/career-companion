// @vitest-environment happy-dom
/**
 * UA-1 editing-host containment — regression-first.
 *
 * One rich-text answer box compiled into two questions: the editor and an inner
 * editable node inside it were both emitted as controls, and the compiler --
 * correctly, given what it was told -- made a question of each. The inner one
 * has no accessible name and no answer of its own, so the second question could
 * never be resolved, and it inflated the denominator of a form that was in fact
 * complete.
 *
 * The distinction is HTML's, not a heuristic: an element with contenteditable
 * true or plaintext-only is an editing host, and a nested one is part of the
 * same answer surface UNLESS a contenteditable="false" region separates them.
 * That false region ends the editable flow, so an editing host re-formed inside
 * it is genuinely its own question and must stay one.
 *
 * Nothing here creates a second grouping authority: the scan only stops
 * emitting a control it should never have emitted, and records it through the
 * conservation channel that already exists, so the compiler sees a decoy rather
 * than a question.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scanPilotUa1Discovery } from '@edaix/apply-kernel/pilotUa1Discovery';
import { compileGraph } from '../../../packages/apply-kernel/src/semantic/graph';
import { sha256 } from '../../../packages/apply-kernel/tests/semantic/harness';
import { createPilotUa1DiscoveryRequest } from '../lib/pilotUa1DiscoveryProtocol';
import {
  createPilotUa1ContentRuntime,
  type PilotUa1Observation,
} from '../lib/pilotUa1DiscoveryRuntime';

const EXTENSION_ID = 'ua1-editing-host';
const BACKGROUND_URL = `chrome-extension://${EXTENSION_ID}/background.js`;
const BACKGROUND_SENDER = Object.freeze({ id: EXTENSION_ID, url: BACKGROUND_URL });
const NOW = 10_000;
const LIFECYCLE_NONCE = '11'.repeat(16);

async function hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(result)].map((p) => p.toString(16).padStart(2, '0')).join('');
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

/** Compile exactly what a consumer builds from one observation. */
function nodesOf(observation: PilotUa1Observation) {
  const result = compileGraph([{
    cause: 'USER_TRIGGER',
    binding: observation.packet.binding,
    controls: observation.packet.controls,
    structure: observation.structure,
    suppressedControls: observation.packet.observation.suppressedControls,
    hiddenNotObservedCount: observation.packet.observation.hiddenNotObservedCount,
    attributedAddRowGroup: null,
  }], sha256);
  if (!result.ok) throw new Error(`compile failed: ${result.reason}`);
  return {
    questions: result.graph.nodes.filter((node) => node.kind === 'QUESTION'),
    decoys: result.graph.nodes.filter((node) => node.kind === 'DECOY'),
  };
}

const names = (observation: PilotUa1Observation) =>
  observation.packet.controls.map((control) => control.accessibleName);

beforeEach(() => {
  document.body.innerHTML = '';
  history.replaceState(null, '', '/jobs/ua1?step=1#form');
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    x: 0, y: 0, width: 160, height: 24, top: 0, right: 160, bottom: 24, left: 0,
    toJSON: () => ({}),
  } as DOMRect));
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('a nested editable descendant is part of its host, not a second question', () => {
  it('compiles one rich-text editor into exactly one question', async () => {
    document.body.innerHTML = `
      <div role="textbox" aria-label="Cover letter" contenteditable="true">
        <div contenteditable="true"><p>draft</p></div>
      </div>`;
    const observation = await scanOnce();
    expect(names(observation)).toEqual(['Cover letter']);
    const { questions, decoys } = nodesOf(observation);
    expect(questions).toHaveLength(1);
    // Observed and deliberately not emitted: a decoy, never a silent drop.
    expect(observation.packet.observation.suppressedControls).toHaveLength(1);
    expect(decoys).toHaveLength(1);
  });

  it('treats a plaintext-only host the same way', async () => {
    document.body.innerHTML = `
      <div role="textbox" aria-label="Plain answer" contenteditable="plaintext-only">
        <div contenteditable="plaintext-only"></div>
      </div>`;
    const observation = await scanOnce();
    expect(names(observation)).toEqual(['Plain answer']);
    expect(nodesOf(observation).questions).toHaveLength(1);
  });

  it('suppresses every nested descendant, however deep', async () => {
    document.body.innerHTML = `
      <div role="textbox" aria-label="Editor" contenteditable="true">
        <div contenteditable="true"><div contenteditable="true"></div></div>
      </div>`;
    const observation = await scanOnce();
    expect(names(observation)).toEqual(['Editor']);
    expect(observation.packet.observation.suppressedControls).toHaveLength(2);
  });
});

describe('a false region ends the editable flow', () => {
  it('keeps an editing host re-formed inside a contenteditable=false island', async () => {
    document.body.innerHTML = `
      <div contenteditable="false" aria-label="Read-only body">
        <div role="textbox" aria-label="Inline reply" contenteditable="true"></div>
      </div>`;
    const observation = await scanOnce();
    expect(names(observation)).toEqual(['Inline reply']);
    expect(nodesOf(observation).questions).toHaveLength(1);
  });

  it('separates an inner host from an outer one across a false region', async () => {
    document.body.innerHTML = `
      <div role="textbox" aria-label="Outer" contenteditable="true">
        <div contenteditable="false">
          <div role="textbox" aria-label="Inner" contenteditable="true"></div>
        </div>
      </div>`;
    const observation = await scanOnce();
    expect(names(observation).sort()).toEqual(['Inner', 'Outer']);
    expect(nodesOf(observation).questions).toHaveLength(2);
  });

  it('still suppresses a descendant nested under that re-formed host', async () => {
    document.body.innerHTML = `
      <div contenteditable="false">
        <div role="textbox" aria-label="Independent" contenteditable="true">
          <div contenteditable="true"></div>
        </div>
      </div>`;
    const observation = await scanOnce();
    expect(names(observation)).toEqual(['Independent']);
    expect(observation.packet.observation.suppressedControls).toHaveLength(1);
  });
});

describe('containment evidence stays value-free', () => {
  it('carries no text, HTML, selector or value for a suppressed descendant', async () => {
    document.body.innerHTML = `
      <div role="textbox" aria-label="Cover letter" contenteditable="true">
        <div contenteditable="true" id="inner-editor" class="ProseMirror-inner">private draft</div>
      </div>`;
    const observation = await scanOnce();
    const serialized = JSON.stringify(observation.packet.observation);
    for (const secret of ['inner-editor', 'ProseMirror-inner', 'private draft', 'Cover letter']) {
      expect(serialized, `containment evidence leaked ${secret}`).not.toContain(secret);
    }
  });

  it('never contains a native control: containment is between editing hosts', async () => {
    document.body.innerHTML = `
      <div role="textbox" aria-label="Editor" contenteditable="true">
        <label for="n">Attachment name</label><input id="n">
      </div>`;
    const observation = await scanOnce();
    // Only an editing host can be contained by an editing host. The native
    // control keeps its own question and is never suppressed by containment.
    expect(names(observation)).toContain('Attachment name');
    expect(observation.packet.observation.suppressedControls).toHaveLength(0);
  });
});

describe('containment is bounded by the tree and by the exact enumerated keyword', () => {
  /** Everything a consumer sees, asserted together so no layer can drift. */
  function surfaces(observation: PilotUa1Observation) {
    const { questions, decoys } = nodesOf(observation);
    return {
      controls: names(observation),
      suppressed: observation.packet.observation.suppressedControls,
      sidecarEntries: observation.structure?.entries.length ?? null,
      sidecarSuppressed: observation.structure?.counts.suppressed ?? null,
      questions: questions.length,
      decoys: decoys.length,
    };
  }

  it('never contains an independent host inside a descendant shadow tree', async () => {
    // A light-DOM editing host cannot reach into the shadow root of a
    // descendant: that is a separate tree and its editor is its own question.
    document.body.innerHTML = `
      <div role="textbox" aria-label="Outer editor" contenteditable="true">
        <div id="host"></div>
      </div>`;
    document.getElementById('host')!.attachShadow({ mode: 'open' }).innerHTML =
      '<div role="textbox" aria-label="Shadow editor" contenteditable="true"></div>';
    const observation = await scanOnce();
    const s = surfaces(observation);
    expect(s.controls.sort(), 'a shadow-tree editor was contained by a light-DOM host')
      .toEqual(['Outer editor', 'Shadow editor']);
    expect(s.suppressed).toHaveLength(0);
    expect(s.sidecarEntries).toBe(2);
    expect(s.sidecarSuppressed).toBe(0);
    expect(s.questions).toBe(2);
    expect(s.decoys).toBe(0);
  });

  it('does not accept a whitespace-padded keyword as a false island', async () => {
    // contenteditable is an enumerated attribute: only the exact keywords are
    // legal, and an invalid value inherits. " false " is therefore not a
    // barrier, so the inner node is still part of the outer answer surface.
    document.body.innerHTML = `
      <div role="textbox" aria-label="Cover letter" contenteditable="true">
        <div contenteditable=" false ">
          <div role="textbox" aria-label="Not a question" contenteditable="true"></div>
        </div>
      </div>`;
    const observation = await scanOnce();
    const s = surfaces(observation);
    expect(s.controls, 'a padded keyword was honoured as a real false island')
      .toEqual(['Cover letter']);
    expect(s.suppressed).toHaveLength(1);
    expect(s.sidecarEntries).toBe(1);
    expect(s.sidecarSuppressed).toBe(1);
    expect(s.questions).toBe(1);
    expect(s.decoys).toBe(1);
  });
});
