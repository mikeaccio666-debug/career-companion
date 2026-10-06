// @vitest-environment happy-dom
/**
 * UA-1 false control elision — regression-first.
 *
 * Two ways a real, answerable control disappeared from discovery. Both end the
 * same way: the question is gone, the accounting reports nothing was dropped,
 * and the sidecar still asserts a conserved scan. A form that is missing four
 * required fields reads as complete.
 *
 * A — a non-form ARIA role erased a native control's intrinsic identity. ARIA
 *     supplements semantics; it does not delete a form-associated element that
 *     the user can still focus and answer.
 * B — proxy pairing consumed an independent editing host as if it were the
 *     surface of a native control inside it, so the editor's own question
 *     vanished.
 *
 * The fixes must stay narrow in both directions: genuine ARIA custom controls
 * must keep their grouping semantics, and a genuine proxy must still resolve to
 * exactly one question at the native it stands for.
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

const EXTENSION_ID = 'ua1-elision';
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

/** Every surface a consumer reads, together, so none can drift from the others. */
function surfaces(observation: PilotUa1Observation) {
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
    controls: observation.packet.controls.map((c) => c.accessibleName),
    suppressed: observation.packet.observation.suppressedControls.length,
    hiddenNotObserved: observation.packet.observation.hiddenNotObservedCount,
    sidecarEntries: observation.structure?.entries.length ?? null,
    questions: result.graph.nodes.filter((n) => n.kind === 'QUESTION').length,
    actions: result.graph.nodes.filter((n) => n.kind === 'ACTION').length,
    decoys: result.graph.nodes.filter((n) => n.kind === 'DECOY').length,
  };
}

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

describe('A · a non-form ARIA role never deletes a native control', () => {
  it('discovers required native controls that carry presentation, none or group', async () => {
    document.body.innerHTML = `
      <label for="a">Email</label>   <input id="a" type="email" required role="presentation">
      <label for="b">Cover</label>   <textarea id="b" required role="presentation"></textarea>
      <label for="c">Country</label> <select id="c" required role="none"><option>US</option></select>
      <label for="d">Resume</label>  <input id="d" type="file" required role="group">
      <label for="e">Name</label>    <input id="e" type="text" required>`;
    const s = surfaces(await scanOnce());
    expect(s.controls.sort(), 'a non-form ARIA role deleted a native control')
      .toEqual(['Country', 'Cover', 'Email', 'Name', 'Resume']);
    expect(s.questions, 'the question denominator lost required fields').toBe(5);
    // Nothing was dropped, so reporting zero drops is truthful rather than the
    // false green this closes: four required fields gone and accounting silent.
    expect(s.suppressed).toBe(0);
    expect(s.hiddenNotObserved).toBe(0);
    expect(s.sidecarEntries).toBe(5);
    expect(s.decoys).toBe(0);
  });

  it('keeps the native identity while an explicit form role still supplements it', async () => {
    document.body.innerHTML = `
      <label for="s">Rating</label><input id="s" type="range" role="slider">
      <label for="t">Search</label><input id="t" type="search" role="searchbox">`;
    const observation = await scanOnce();
    expect(observation.packet.controls.map((c) => ({ role: c.role, type: c.inputType })))
      .toEqual([
        { role: 'slider', type: 'range' },
        { role: 'searchbox', type: 'search' },
      ]);
  });

  it('still lets a non-form role suppress a non-native element', async () => {
    // The fix must not become "ignore every role". An ARIA role remains the
    // only thing that makes a plain element a control, so presentation on one
    // still means it is not.
    document.body.innerHTML = `
      <label for="k">Real</label><input id="k">
      <div role="presentation" aria-label="Decorative"></div>
      <div role="none" aria-label="Also decorative"></div>`;
    expect(surfaces(await scanOnce()).controls).toEqual(['Real']);
  });

  it('preserves genuine ARIA custom-control grouping', async () => {
    document.body.innerHTML = `
      <div role="radiogroup" aria-label="Work authorization">
        <div role="radio" aria-checked="false">Yes</div>
        <div role="radio" aria-checked="false">No</div>
      </div>`;
    const s = surfaces(await scanOnce());
    expect(s.controls).toEqual(['Work authorization', 'Yes', 'No']);
    expect(s.questions, 'ARIA grouping semantics were lost').toBe(1);
  });
});

describe('B · proxy pairing never consumes an independent editing host', () => {
  it('keeps both the editor and a native control rendered inside it', async () => {
    document.body.innerHTML = `
      <div role="textbox" aria-label="Cover letter" contenteditable="true">
        <label for="n">Attachment name</label><input id="n">
      </div>`;
    const s = surfaces(await scanOnce());
    expect(s.controls.sort(), 'the editor was consumed as the input surface')
      .toEqual(['Attachment name', 'Cover letter']);
    // Two independent questions, and neither logical control counted twice.
    expect(s.questions).toBe(2);
    expect(s.suppressed).toBe(0);
    expect(s.sidecarEntries).toBe(2);
  });

  it('keeps an editor adjacent to a native control it does not contain', async () => {
    document.body.innerHTML = `
      <div class="field">
        <div role="textbox" aria-label="Cover letter" contenteditable="true"></div>
        <label for="p">Portfolio</label><input id="p" type="url">
      </div>`;
    const s = surfaces(await scanOnce());
    expect(s.controls.sort()).toEqual(['Cover letter', 'Portfolio']);
    expect(s.questions).toBe(2);
  });

  it('still resolves a genuine proxy to exactly one question at the native', async () => {
    // The counter-example: a real styled proxy over a hidden native must still
    // collapse to one question, carried at the native the user actually writes.
    document.body.innerHTML = `
      <label for="consent" role="checkbox">I agree to the terms</label>
      <input id="consent" type="checkbox" style="opacity:0;width:1px;height:1px">`;
    const s = surfaces(await scanOnce());
    expect(s.controls).toEqual(['I agree to the terms']);
    expect(s.questions).toBe(1);
    const only = (await scanOnce()).packet.controls[0]!;
    expect(only.inputType, 'the question was carried at the proxy, not the native')
      .toBe('checkbox');
  });

  it('still resolves a styled activator over a hidden file input to one question', async () => {
    document.body.innerHTML = `
      <div class="dropzone">
        <button type="button">Attach a file</button>
        <input type="file" style="opacity:0;width:1px;height:1px">
      </div>`;
    const observation = await scanOnce();
    const file = observation.packet.controls.filter((c) => c.inputType === 'file');
    expect(file).toHaveLength(1);
    expect(file[0]!.accessibleName).toBe('Attach a file');
  });
});

describe('A2 · a non-form ARIA role never deletes an editable host either', () => {
  // Intrinsic editability is control identity in the same way a native form
  // element's tag is. A contenteditable answer box the user can focus and type
  // into does not stop being a question because the page also marked it
  // presentational -- and ARIA says as much: a presentational role is ignored
  // on a focusable element rather than applied to it.
  it('discovers an editable host under presentation, none and group', async () => {
    document.body.innerHTML = `
      <div role="presentation" contenteditable="true" aria-label="Cover letter"></div>
      <div role="none" contenteditable="true" aria-label="Why this role"></div>
      <div role="group" contenteditable="plaintext-only" aria-label="Notes"></div>
      <label for="k">Name</label><input id="k">`;
    const s = surfaces(await scanOnce());
    expect(s.controls.sort(), 'a non-form ARIA role deleted an editable host')
      .toEqual(['Cover letter', 'Name', 'Notes', 'Why this role']);
    expect(s.questions).toBe(4);
    expect(s.suppressed).toBe(0);
    expect(s.hiddenNotObserved).toBe(0);
    expect(s.sidecarEntries).toBe(4);
    expect(s.decoys).toBe(0);
  });

  it('still suppresses a plain element carrying the same roles', async () => {
    // The counterexample that holds the narrowing in place: without intrinsic
    // editability a role is the only thing that could make these controls, and
    // a presentational role is exactly the statement that they are not.
    document.body.innerHTML = `
      <label for="real">Real</label><input id="real">
      <div role="presentation" aria-label="Decorative"></div>
      <div role="none" aria-label="Also decorative"></div>
      <div role="group" aria-label="Just a wrapper"></div>`;
    const s = surfaces(await scanOnce());
    expect(s.controls).toEqual(['Real']);
    expect(s.questions).toBe(1);
    expect(s.sidecarEntries).toBe(1);
  });

  it('keeps containment: a masked nested descendant is a decoy, not a question', async () => {
    // #183 containment must still hold once the descendant is no longer
    // deleted outright: it is part of its host's answer surface, so it reaches
    // the compiler as a decoy through the conservation channel.
    document.body.innerHTML = `
      <div role="textbox" aria-label="Cover letter" contenteditable="true">
        <div role="presentation" contenteditable="true"></div>
      </div>`;
    const s = surfaces(await scanOnce());
    expect(s.controls).toEqual(['Cover letter']);
    expect(s.questions).toBe(1);
    expect(s.suppressed).toBe(1);
    expect(s.decoys).toBe(1);
  });

  it('keeps the false island independent even when the inner host is masked', async () => {
    document.body.innerHTML = `
      <div role="textbox" aria-label="Outer" contenteditable="true">
        <div contenteditable="false">
          <div role="none" contenteditable="true" aria-label="Inner"></div>
        </div>
      </div>`;
    const s = surfaces(await scanOnce());
    expect(s.controls.sort()).toEqual(['Inner', 'Outer']);
    expect(s.questions).toBe(2);
    expect(s.suppressed).toBe(0);
  });
});

describe('B2 · no surface source may consume an independent editing host', () => {
  // The rule has to hold for every way a surface is found, not just the
  // ancestor-role walk. Each of these hands a hidden native a surface from a
  // different source, and each one used to swallow the editor: the question
  // vanished while suppressed and hidden both read zero and the sidecar still
  // asserted a conserved scan.
  it('refuses the field-group fallback when the group is an editing host', async () => {
    // The editor carries visible text of its own, which is what makes it a
    // candidate field-group surface in the first place.
    document.body.innerHTML = `
      <div role="textbox" aria-label="Upload resume" contenteditable="true">
        Upload resume
        <input type="file" style="opacity:0;position:absolute">
      </div>`;
    const s = surfaces(await scanOnce());
    expect(s.controls, 'the editor was consumed as the field-group surface')
      .toEqual(['Upload resume']);
    expect(s.questions).toBe(1);
    // The native had no trustworthy surface of its own, so it is a reported
    // drop rather than a silent one.
    expect(s.hiddenNotObserved, 'the dropped native was not accounted for').toBe(1);
    expect(s.suppressed).toBe(0);
    expect(s.sidecarEntries).toBe(1);
    expect(s.decoys).toBe(0);
    const only = (await scanOnce()).packet.controls[0]!;
    expect(only.inputType, 'the editor question was replaced by the native').toBeNull();
  });

  it('refuses an associated label that is itself an editing host', async () => {
    document.body.innerHTML = `
      <label for="cv" contenteditable="true">Upload resume</label>
      <input id="cv" type="file" style="opacity:0;position:absolute">`;
    const s = surfaces(await scanOnce());
    expect(s.controls, 'an editable label was consumed as the native surface')
      .toHaveLength(1);
    expect(s.questions).toBe(1);
    expect(s.hiddenNotObserved, 'the dropped native was not accounted for').toBe(1);
    expect(s.suppressed).toBe(0);
    expect(s.sidecarEntries).toBe(1);
    const only = (await scanOnce()).packet.controls[0]!;
    // The surviving question is the editable label itself, not the native. Its
    // name is null because a textbox does not take its name from its own
    // content -- unnamed is the honest answer, and it is still a question.
    expect(only.inputType, 'the editable label lost its own question').toBeNull();
    expect(only.role).toBe('textbox');
    expect(only.accessibleName).toBeNull();
  });

  it('still pairs a hidden native with an ordinary non-editable label', async () => {
    document.body.innerHTML = `
      <label for="cv2">Upload resume</label>
      <input id="cv2" type="file" style="opacity:0;position:absolute">`;
    const s = surfaces(await scanOnce());
    expect(s.controls).toEqual(['Upload resume']);
    expect(s.questions).toBe(1);
    expect(s.hiddenNotObserved).toBe(0);
    const only = (await scanOnce()).packet.controls[0]!;
    expect(only.inputType, 'the ordinary proxy pair stopped resolving at the native')
      .toBe('file');
  });
});

describe('B3 · surface eligibility follows the editing flow, not just the attribute', () => {
  // A wrapper with no contenteditable of its own is still part of the editor if
  // it inherits an active editing flow. Judging eligibility by the candidate's
  // own attribute lets every surface source reach past that wrapper and consume
  // the editor anyway, which is the same deletion one layer down.
  const expectEditorOnly = (s: ReturnType<typeof surfaces>) => {
    expect(s.controls, 'the editor was consumed through an inheriting wrapper')
      .toEqual(['Cover letter']);
    expect(s.questions).toBe(1);
    expect(s.decoys).toBe(0);
    expect(s.suppressed).toBe(0);
    expect(s.hiddenNotObserved, 'the dropped native was not accounted for').toBe(1);
    expect(s.sidecarEntries).toBe(1);
  };

  it('refuses a field-group candidate that inherits editability', async () => {
    document.body.innerHTML = `
      <div role="textbox" aria-label="Cover letter" contenteditable="true">
        <div class="wrapper">
          Upload resume
          <input type="file" style="opacity:0;position:absolute">
        </div>
      </div>`;
    expectEditorOnly(surfaces(await scanOnce()));
  });

  it('refuses an associated label that inherits editability', async () => {
    document.body.innerHTML = `
      <div role="textbox" aria-label="Cover letter" contenteditable="true">
        <label for="cv3">Upload resume</label>
      </div>
      <input id="cv3" type="file" style="opacity:0;position:absolute">`;
    expectEditorOnly(surfaces(await scanOnce()));
  });

  it('does not let a question-bearing role inside the flow become a second question', async () => {
    // The span is not native and not an editing host of its own: it cannot hold
    // a value, and anything typed "into" it belongs to the enclosing editor. A
    // question role there confers no independent answerability, so treating it
    // as a question invents one the user can never answer separately.
    document.body.innerHTML = `
      <div role="textbox" aria-label="Editor" contenteditable="true">
        <span role="textbox" aria-label="Nested">
          <input type="file" style="opacity:0;position:absolute">
        </span>
      </div>`;
    const s = surfaces(await scanOnce());
    expect(s.controls, 'an inherited question role became a second question')
      .toEqual(['Editor']);
    expect(s.questions).toBe(1);
    expect(s.decoys).toBe(0);
    expect(s.suppressed).toBe(0);
    expect(s.hiddenNotObserved, 'the dropped native was not accounted for').toBe(1);
    expect(s.sidecarEntries).toBe(1);
  });

  it('keeps a focusable choice widget with bounded state inside an editor', async () => {
    // Focus plus a legal bounded state is evidence the widget is operable on its
    // own, unlike a bare role that only labels inert markup. Only presence and
    // closed-set legality are checked; the state value is never read out.
    document.body.innerHTML = `
      <div role="textbox" aria-label="Editor" contenteditable="true">
        <span role="checkbox" tabindex="0" aria-checked="false" aria-label="Agree"></span>
      </div>`;
    const s = surfaces(await scanOnce());
    expect(s.controls.sort(), 'an operable choice widget was deleted').toEqual(['Agree', 'Editor']);
    expect(s.questions).toBe(2);
    expect(s.sidecarEntries).toBe(2);
    expect(s.hiddenNotObserved).toBe(0);
    expect(s.suppressed).toBe(0);
  });

  it('keeps a focusable switch with bounded state inside an editor', async () => {
    document.body.innerHTML = `
      <div role="textbox" aria-label="Editor" contenteditable="true">
        <span role="switch" tabindex="0" aria-checked="false" aria-label="Notify me"></span>
      </div>`;
    const s = surfaces(await scanOnce());
    expect(s.controls.sort()).toEqual(['Editor', 'Notify me']);
    expect(s.questions).toBe(2);
    expect(s.sidecarEntries).toBe(2);
    expect(s.hiddenNotObserved).toBe(0);
  });

  // Table-driven over the formal role set, so a future blanket default cannot
  // quietly delete a role nobody wrote a fixture for.
  const FORMAL_ROLES = [
    'button', 'checkbox', 'combobox', 'listbox', 'option', 'radio',
    'radiogroup', 'searchbox', 'slider', 'spinbutton', 'switch', 'textbox',
  ] as const;

  it('keeps every formal role inside an editor when the author declared it focusable', async () => {
    for (const role of FORMAL_ROLES) {
      document.body.innerHTML = `
        <div role="textbox" aria-label="Editor" contenteditable="true">
          <span role="${role}" tabindex="0" aria-label="Widget"></span>
        </div>`;
      const s = surfaces(await scanOnce());
      expect(s.controls.sort(), `role=${role} was deleted inside an editor`)
        .toEqual(['Editor', 'Widget']);
      expect(s.suppressed, `role=${role} was suppressed`).toBe(0);
      expect(s.hiddenNotObserved, `role=${role} produced a drop`).toBe(0);
      expect(s.sidecarEntries, `role=${role} lost sidecar conservation`).toBe(2);
    }
  });

  it('elides only an ARIA-only role with no evidence, and never an activator', async () => {
    for (const role of FORMAL_ROLES) {
      document.body.innerHTML = `
        <div role="textbox" aria-label="Editor" contenteditable="true">
          <span role="${role}" aria-label="Bare"></span>
        </div>`;
      const s = surfaces(await scanOnce());
      if (role === 'button') {
        // An activator carries no answer and compiles to an ACTION, so it is
        // never elided and never inflates the question denominator.
        expect(s.controls.sort(), 'a bare activator was elided').toEqual(['Bare', 'Editor']);
        expect(s.actions).toBe(1);
        expect(s.questions).toBe(1);
      } else {
        expect(s.controls, `bare role=${role} became a question`).toEqual(['Editor']);
        expect(s.questions).toBe(1);
        expect(s.suppressed).toBe(0);
        expect(s.decoys).toBe(0);
      }
    }
  });

  it('keeps a combobox whose options the ordinary collection observed', async () => {
    document.body.innerHTML = `
      <div role="textbox" aria-label="Editor" contenteditable="true">
        <div role="combobox" aria-label="Country">
          <div role="option">United States</div>
          <div role="option">Canada</div>
        </div>
      </div>`;
    const s = surfaces(await scanOnce());
    expect(s.controls.sort(), 'a combobox with observed options was deleted')
      .toEqual(['Country', 'Editor']);
    expect(s.questions).toBe(2);
    expect(s.suppressed).toBe(0);
    expect(s.hiddenNotObserved).toBe(0);
  });

  it('keeps a radiogroup and its members as exactly one question inside an editor', async () => {
    document.body.innerHTML = `
      <div role="textbox" aria-label="Editor" contenteditable="true">
        <div role="radiogroup" aria-label="Work authorization">
          <div role="radio" tabindex="0" aria-checked="false">Yes</div>
          <div role="radio" tabindex="0" aria-checked="false">No</div>
        </div>
      </div>`;
    const s = surfaces(await scanOnce());
    // The container must survive: deleting it fragments its members into
    // separate questions, which is the denominator corruption this closes.
    expect(s.controls, 'the radiogroup container was deleted')
      .toContain('Work authorization');
    expect(s.questions, 'the radio members fragmented into separate questions').toBe(2);
    expect(s.suppressed).toBe(0);
    expect(s.decoys).toBe(0);
  });

  it('refuses a roled candidate that inherits editability', async () => {
    document.body.innerHTML = `
      <div role="textbox" aria-label="Cover letter" contenteditable="true">
        <div role="button">Upload resume<input type="file" style="opacity:0;position:absolute"></div>
      </div>`;
    const s = surfaces(await scanOnce());
    // The roled descendant is a control in its own right -- an editor toolbar
    // button is exactly this shape -- so it is emitted and compiles to an
    // ACTION, not a question. What matters is that it did not become the hidden
    // native's surface: the editor keeps its question and the native is a
    // reported drop rather than a borrowed one.
    expect(s.controls.sort()).toEqual(['Cover letter', 'Upload resume']);
    expect(s.questions, 'the editor question was consumed').toBe(1);
    expect(s.decoys).toBe(0);
    expect(s.hiddenNotObserved, 'the dropped native was not accounted for').toBe(1);
    expect(s.suppressed).toBe(0);
    expect(s.sidecarEntries).toBe(2);
  });

  it('does not inherit editability across a shadow boundary', async () => {
    // #183 tree scope still holds: a light-DOM editor does not make a surface
    // inside a descendant host's shadow root ineligible.
    document.body.innerHTML = `
      <div role="textbox" aria-label="Cover letter" contenteditable="true">
        <div id="shost"></div>
      </div>`;
    document.getElementById('shost')!.attachShadow({ mode: 'open' }).innerHTML = `
      <div class="wrapper">
        Upload resume
        <input type="file" style="opacity:0;position:absolute">
      </div>`;
    const s = surfaces(await scanOnce());
    expect(s.controls.sort(), 'the shadow-tree surface was wrongly treated as inheriting')
      .toEqual(['Cover letter', 'Upload resume']);
    expect(s.questions).toBe(2);
    expect(s.hiddenNotObserved).toBe(0);
  });

  it('lets a false island restore surface eligibility inside an editor', async () => {
    document.body.innerHTML = `
      <div role="textbox" aria-label="Cover letter" contenteditable="true">
        <div contenteditable="false">
          <div class="wrapper">
            Upload resume
            <input type="file" style="opacity:0;position:absolute">
          </div>
        </div>
      </div>`;
    const s = surfaces(await scanOnce());
    expect(s.controls.sort(), 'a false island did not restore eligibility')
      .toEqual(['Cover letter', 'Upload resume']);
    expect(s.questions).toBe(2);
    expect(s.hiddenNotObserved).toBe(0);
  });
});
