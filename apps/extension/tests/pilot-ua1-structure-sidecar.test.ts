// @vitest-environment happy-dom
/**
 * UA-1 StructureSidecarV1 producer — regression-first.
 *
 * Every case here was first reproduced against the scanner with NO sidecar,
 * where the certified #164 compiler produced a demonstrably wrong graph:
 * one radiogroup question became three question nodes, two same-name radio
 * questions became four, a deleted row's identity was inherited by a surviving
 * row, and a re-injected question collapsed into the node of the question it
 * replaced. The compiler is not wrong in any of those cases — it is starved,
 * because the exact evidence it reads (element identity, group key, row
 * identity) only exists at the scan site.
 *
 * These tests therefore assert graph outcomes through the real compiler, not
 * sidecar shape for its own sake: a sidecar that does not change what the
 * compiler concludes is wire weight, not evidence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parsePilotUa1DiscoveryPacket, type PilotUa1DiscoveryPacket } from '@edaix/contracts/draft';
import { scanPilotUa1Discovery } from '@edaix/apply-kernel/pilotUa1Discovery';
import {
  SEMANTIC_COMPILER_VERSION,
  compileGraph,
  packetDigestOf,
} from '../../../packages/apply-kernel/src/semantic/graph';
import { sha256 } from '../../../packages/apply-kernel/tests/semantic/harness';
import { createPilotUa1DiscoveryRequest } from '../lib/pilotUa1DiscoveryProtocol';
import {
  createPilotUa1ContentRuntime,
  type PilotUa1Observation,
} from '../lib/pilotUa1DiscoveryRuntime';

const EXTENSION_ID = 'ua1-sidecar-extension';
const BACKGROUND_URL = `chrome-extension://${EXTENSION_ID}/background.js`;
const BACKGROUND_SENDER = Object.freeze({ id: EXTENSION_ID, url: BACKGROUND_URL });
const NOW = 10_000;
const LIFECYCLE_NONCE = '11'.repeat(16);

async function hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(result)].map((p) => p.toString(16).padStart(2, '0')).join('');
}

function positiveRect(): DOMRect {
  return {
    x: 0, y: 0, width: 160, height: 24, top: 0, right: 160, bottom: 24, left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

/** One content-script lifecycle: element identity must survive across its scans. */
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

async function scanOnce(): Promise<PilotUa1Observation> {
  return lifecycle()();
}

/** Exactly the epoch a consumer builds from one observation. */
function epochOf(observation: PilotUa1Observation, cause: 'USER_TRIGGER' | 'HOST_MUTATION_RESCAN' = 'USER_TRIGGER') {
  return {
    cause,
    binding: observation.packet.binding,
    controls: observation.packet.controls,
    structure: observation.structure,
    suppressedControls: observation.packet.observation.suppressedControls,
    hiddenNotObservedCount: observation.packet.observation.hiddenNotObservedCount,
    attributedAddRowGroup: null,
  } as const;
}

function questionsOf(...observations: readonly PilotUa1Observation[]) {
  const result = compileGraph(
    observations.map((o, index) => epochOf(o, index === 0 ? 'USER_TRIGGER' : 'HOST_MUTATION_RESCAN')),
    sha256,
  );
  if (!result.ok) throw new Error(`compile failed: ${result.reason}`);
  return {
    graph: result.graph,
    questions: result.graph.nodes.filter((node) => node.kind === 'QUESTION'),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  history.replaceState(null, '', '/jobs/ua1?step=1#form');
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(positiveRect);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('radio and checkbox grouping', () => {
  it('counts an ARIA radiogroup and its members as one question', async () => {
    document.body.innerHTML = `
      <div role="radiogroup" aria-label="Work authorization">
        <div role="radio" aria-checked="false">Yes</div>
        <div role="radio" aria-checked="false">No</div>
      </div>`;
    const observation = await scanOnce();
    // UA-1 still emits the group and both members; counting the question once
    // is the compiler's job, and memberOfGroupControl is the evidence it needs.
    expect(observation.packet.controls).toHaveLength(3);
    expect(questionsOf(observation).questions).toHaveLength(1);
  });

  it('separates two same-name native radio questions by shared group key', async () => {
    document.body.innerHTML = `
      <div>
        <label for="a">Yes</label><input type="radio" id="a" name="auth">
        <label for="b">No</label><input type="radio" id="b" name="auth">
        <label for="c">Yes</label><input type="radio" id="c" name="sponsor">
        <label for="d">No</label><input type="radio" id="d" name="sponsor">
      </div>`;
    const { questions } = questionsOf(await scanOnce());
    expect(questions).toHaveLength(2);
    expect(questions.map((q) => q.control.members.length)).toEqual([2, 2]);
    expect(questions.every((q) => q.control.grouping === 'SHARED_NAME')).toBe(true);
  });

  it('never merges same-name radios that live in different forms', async () => {
    document.body.innerHTML = `
      <form><label for="e">Yes</label><input type="radio" id="e" name="auth"></form>
      <form><label for="f">Yes</label><input type="radio" id="f" name="auth"></form>`;
    expect(questionsOf(await scanOnce()).questions).toHaveLength(2);
  });
});

describe('row identity across epochs', () => {
  const rows = (count: number): string => `
    <div id="rows">${Array.from(
      { length: count },
      (_unused, index) => `<div class="row"><label for="r${index}">Employer</label><input id="r${index}"></div>`,
    ).join('')}</div>`;

  it('keeps a surviving row question stable when an earlier row is removed', async () => {
    document.body.innerHTML = rows(3);
    const scan = lifecycle();
    const before = await scan();
    document.querySelector('#rows .row')!.remove();
    const after = await scan();

    const first = questionsOf(before).questions.map((q) => q.id);
    const both = questionsOf(before, after).questions;
    // The two surviving Elements keep their question nodes; only the removed
    // row's node is absent from the second epoch.
    const survived = both.filter((q) => q.lastObservedEpoch === 1).map((q) => q.id);
    expect(survived).toHaveLength(2);
    expect(survived).toEqual(first.slice(1));
  });

  it('never lets a surviving row inherit the removed row question', async () => {
    document.body.innerHTML = rows(2);
    const scan = lifecycle();
    const before = await scan();
    const removed = questionsOf(before).questions[0]!.id;
    document.querySelector('#rows .row')!.remove();
    const after = await scan();

    const survivor = questionsOf(before, after).questions.filter((q) => q.lastObservedEpoch === 1);
    expect(survivor).toHaveLength(1);
    expect(survivor[0]!.id).not.toBe(removed);
  });
});

describe('same-URL dynamic injection', () => {
  it('treats a replaced question at the same DOM address as a new question', async () => {
    document.body.innerHTML =
      '<form id="step"><label for="q">Step one question</label><input id="q"></form>';
    const scan = lifecycle();
    const step1 = await scan();
    document.querySelector('#step')!.innerHTML =
      '<label for="q2">Step two question</label><input id="q2">';
    const step2 = await scan();

    // Same UA-1 address, different control. Two questions, never one.
    expect(step2.packet.controls[0]!.identityDigest)
      .toBe(step1.packet.controls[0]!.identityDigest);
    expect(questionsOf(step1, step2).questions).toHaveLength(2);
  });
});

describe('sidecar binding', () => {
  it('binds the exact packet, epoch, compiler version and conservation counts', async () => {
    document.body.innerHTML = '<label for="x">Email</label><input id="x" type="email">';
    const observation = await scanOnce();
    const sidecar = observation.structure;
    expect(sidecar).not.toBeNull();
    expect(sidecar!.packetDigest).toBe(packetDigestOf(observation.packet.controls, sha256));
    expect(sidecar!.compilerVersion).toBe(SEMANTIC_COMPILER_VERSION);
    expect(sidecar!.epochIndex).toBe(0);
    expect(sidecar!.counts).toEqual({
      controls: observation.packet.controls.length,
      entries: sidecar!.entries.length,
      suppressed: observation.packet.observation.suppressedControls.length,
      hiddenNotObserved: observation.packet.observation.hiddenNotObservedCount,
    });
    expect(sidecar!.entries.map((entry) => entry.identityDigest))
      .toEqual(observation.packet.controls.map((control) => control.identityDigest));
  });

  it('never understates a drop: the sidecar counts what the packet reports', async () => {
    document.body.innerHTML = `
      <label for="ok">Email</label><input id="ok" type="email">
      <label>Please leave this field blank<input aria-label="Website"></label>`;
    const observation = await scanOnce();
    // A honeypot was observed and suppressed. Before UA-1 could report a drop
    // the only honest answer was to withhold the sidecar; now the drop is on
    // the wire, so the sidecar is emitted and its conservation counts must say
    // exactly what the packet says -- understating would be the false green.
    expect(observation.structure).not.toBeNull();
    expect(observation.structure!.counts.suppressed)
      .toBe(observation.packet.observation.suppressedControls.length);
    expect(observation.structure!.counts.suppressed).toBeGreaterThan(0);
    expect(compileGraph([epochOf(observation)], sha256).ok).toBe(true);
  });

  it('carries no raw name, label, placeholder, option text or value', async () => {
    document.body.innerHTML = `
      <fieldset><legend>Contact</legend>
        <label for="em">Email address</label>
        <input id="em" type="email" name="candidate_email" placeholder="MM/YYYY" value="alex@example.test">
        <select id="sel" name="country_of_residence">
          <option value="">Choose one</option><option value="us">United States</option>
        </select>
      </fieldset>`;
    const observation = await scanOnce();
    const serialized = JSON.stringify(observation.structure);
    for (const secret of [
      'candidate_email', 'country_of_residence', 'alex@example.test',
      'Email address', 'Choose one', 'United States', 'Contact', 'MM/YYYY',
    ]) {
      expect(serialized, `sidecar leaked ${secret}`).not.toContain(secret);
    }
  });
});

describe('structural reads never fail a scan that used to succeed', () => {
  it('tolerates an option value and a placeholder longer than any mask', async () => {
    document.body.innerHTML = `
      <label for="long">Country</label>
      <select id="long">
        <option value="${'v'.repeat(4_096)}">Somewhere</option>
        <option value="">Choose one</option>
      </select>
      <label for="note">Note</label>
      <input id="note" placeholder="${'p'.repeat(200)}">`;
    const observation = await scanOnce();
    expect(observation.packet.controls).toHaveLength(2);
    const sidecar = observation.structure;
    expect(sidecar).not.toBeNull();
    // The long value is not a placeholder option; the empty one is.
    expect(sidecar!.entries[0]!.placeholderOptionIndexes).toEqual([1]);
    expect(sidecar!.entries[1]!.placeholderShape).toBeNull();
  });

  it('reads a month/year mask as a closed shape without carrying the text', async () => {
    document.body.innerHTML = `
      <label for="grad">Graduation</label><input id="grad" placeholder="MM/YYYY">`;
    const observation = await scanOnce();
    expect(observation.structure!.entries[0]!.placeholderShape).toBe('MONTH_YEAR_MASK');
  });
});

describe('hidden controls are conserved, never silently pruned', () => {
  // These two reproduced a producer that pruned a control and still claimed a
  // complete scan. The claim is what was wrong, not the pruning. Now that the
  // wire can report a drop, the honest answer is an exact count rather than a
  // withheld sidecar -- and the invariant under test is unchanged: never assert
  // a completeness the scan did not establish.
  it('reports a native pruned by its own hidden style, exactly', async () => {
    document.body.innerHTML = `
      <label for="ok">Email</label><input id="ok" type="email">
      <input aria-label="Pruned" type="text" style="display:none">`;
    const observation = await scanOnce();
    expect(observation.packet.controls).toHaveLength(1);
    expect(observation.packet.observation.hiddenNotObservedCount).toBe(1);
    expect(observation.structure!.counts.hiddenNotObserved)
      .toBe(observation.packet.observation.hiddenNotObservedCount);
  });

  it('reports a native pruned by a hidden ancestor, exactly', async () => {
    document.body.innerHTML = `
      <label for="ok2">Email</label><input id="ok2" type="email">
      <div style="display:none"><label for="deep">Buried</label><input id="deep"></div>`;
    const observation = await scanOnce();
    expect(observation.packet.controls).toHaveLength(1);
    expect(observation.packet.observation.hiddenNotObservedCount).toBe(1);
    expect(observation.structure!.counts.hiddenNotObserved).toBe(1);
  });
});

describe('radio group ownership follows the real form owner and root boundary', () => {
  it('separates same-name radios owned by different forms via the form attribute', async () => {
    document.body.innerHTML = `
      <form id="f1"></form>
      <form id="f2"></form>
      <label for="ra">Yes</label><input type="radio" id="ra" name="auth" form="f1">
      <label for="rb">Yes</label><input type="radio" id="rb" name="auth" form="f2">`;
    const { questions } = questionsOf(await scanOnce());
    expect(questions, 'two form-owned radio questions collapsed into one').toHaveLength(2);
  });

  it('separates same-name radios living in different shadow roots', async () => {
    document.body.innerHTML = '<div id="h1"></div><div id="h2"></div>';
    for (const id of ['h1', 'h2']) {
      const host = document.getElementById(id)!;
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<label for="r">Yes</label><input type="radio" id="r" name="auth">';
    }
    const { questions } = questionsOf(await scanOnce());
    expect(questions, 'two shadow-root radio questions collapsed into one').toHaveLength(2);
  });
});

describe('the prune probe crosses shadow boundaries it can open', () => {
  // A host can be empty in light DOM and still hold the entire form in its
  // shadow root. A probe that only walks children would prove the subtree
  // control-free and let the producer claim a completeness it never checked --
  // and shadow-heavy hosts are the normal case, not an edge one.
  it('reports a control hidden inside an openable shadow root, exactly', async () => {
    document.body.innerHTML = `
      <label for="ok3">Email</label><input id="ok3" type="email">
      <div id="host" style="display:none"></div>`;
    const host = document.getElementById('host')!;
    host.attachShadow({ mode: 'open' }).innerHTML = '<input aria-label="hidden shadow">';
    const observation = await scanOnce();
    // The probe can open this boundary and see the whole subtree, so the drop
    // is an exact number rather than an unknown. The invariant is unchanged:
    // never claim a completeness the scan did not establish. What changed is
    // that the wire can now state the drop instead of only withholding.
    expect(observation.packet.controls).toHaveLength(1);
    expect(observation.packet.observation.hiddenNotObservedCount).toBe(1);
    expect(observation.structure!.counts.hiddenNotObserved)
      .toBe(observation.packet.observation.hiddenNotObservedCount);
  });

  it('emits no sidecar when a pruned shadow root cannot be opened', async () => {
    document.body.innerHTML = `
      <label for="ok4">Email</label><input id="ok4" type="email">
      <div id="host2" style="display:none"></div>`;
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
      // Production uses chrome.dom.openOrClosedShadowRoot, which throws when it
      // is unavailable. An unopenable boundary is unknown, never empty.
      openShadowRoot: (element) => {
        // Only the pruned host is unopenable: the main walk still completes, so
        // this exercises the probe's boundary handling and not scan failure.
        if (element.id === 'host2') throw new Error('cannot open');
        return element.shadowRoot;
      },
      observe: (observation) => seen.push(observation),
      scanPacket: scanPilotUa1Discovery,
    });
    const request = createPilotUa1DiscoveryRequest({
      pageUrl: location.href,
      requestId: '33'.repeat(16),
      issuedAtMs: NOW,
      targetUrlDigest: await hex(new URL(location.href).href),
    });
    await handle(request!, BACKGROUND_SENDER);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.structure, 'an unopenable shadow boundary was treated as empty').toBeNull();
  });
});
