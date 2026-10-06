import { describe, expect, it } from 'vitest';

import * as pilotUa1Kernel from '../src/pilotUa1Discovery';

const digest = (ordinal: number): string => ordinal.toString(16).padStart(64, '0');
const packet = {
  schemaVersion: 2,
  binding: {
    origin: 'https://careers.example.test',
    pathname: '/openings/engineer',
    domGeneration: digest(900),
  },
  controls: [
    {
      identityDigest: digest(1),
      role: 'textbox',
      inputType: 'text',
      autocomplete: ['given-name'],
      required: true,
      accessibleName: 'First name',
      label: null,
      legend: null,
      options: [],
      fileAccept: null,
    },
    {
      identityDigest: digest(2),
      role: 'listbox',
      inputType: 'select-one',
      autocomplete: [],
      required: false,
      accessibleName: 'Work location',
      label: 'Location',
      legend: null,
      options: [
        { identityDigest: digest(20), accessibleName: 'Remote' },
        { identityDigest: digest(21), accessibleName: 'On-site' },
      ],
      fileAccept: null,
    },
  ],
  observation: { suppressedControls: [], hiddenNotObservedCount: 0, opaqueBoundaries: [] },
};

describe('UA-1 pure discovery interpreter', () => {
  it('emits exactly one closed outcome per supplied visible control in stable order', () => {
    const result = pilotUa1Kernel.scanPilotUa1Discovery(packet);
    expect(result).toEqual({
      ok: true,
      value: {
        schemaVersion: 2,
        binding: packet.binding,
        outcomes: [
          { identityDigest: digest(1), outcome: 'VISIBLE_CONTROL_DETECTED' },
          { identityDigest: digest(2), outcome: 'VISIBLE_CONTROL_DETECTED' },
        ],
      },
    });
    if (!result.ok) return;
    expect(result.value.outcomes).toHaveLength(packet.controls.length);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.outcomes)).toBe(true);
  });

  it('is deterministic, copies the contract, and never mutates caller data', () => {
    const mutable = JSON.parse(JSON.stringify(packet)) as typeof packet;
    const before = JSON.stringify(mutable);
    const first = pilotUa1Kernel.scanPilotUa1Discovery(mutable);
    const second = pilotUa1Kernel.scanPilotUa1Discovery(mutable);
    expect(first).toEqual(second);
    expect(JSON.stringify(mutable)).toBe(before);
    if (first.ok) {
      expect(first.value).not.toBe(mutable);
      expect(first.value.binding).not.toBe(mutable.binding);
    }
  });

  it('fails the whole packet with the approved value-free code on hostile or oversized input', () => {
    expect(pilotUa1Kernel.scanPilotUa1Discovery({
      ...packet,
      controls: [packet.controls[0], { ...packet.controls[0] }],
    })).toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });

    let getterCalls = 0;
    const hostileControl = { ...packet.controls[0] };
    Object.defineProperty(hostileControl, 'accessibleName', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'must not run';
      },
    });
    expect(pilotUa1Kernel.scanPilotUa1Discovery({ ...packet, controls: [hostileControl] }))
      .toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
    expect(getterCalls).toBe(0);

    expect(pilotUa1Kernel.scanPilotUa1Discovery(new Proxy({}, {
      ownKeys: () => { throw new Error('hostile'); },
    }))).toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
  });

  it('exposes no DOM, network, write, event, selector, classification, or Submit surface', () => {
    expect(Object.keys(pilotUa1Kernel)).toEqual(['scanPilotUa1Discovery']);
    const result = pilotUa1Kernel.scanPilotUa1Discovery(packet);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wire = JSON.stringify(result.value);
    for (const forbidden of [
      'value', 'selector', 'javascript', 'category', 'provenance', 'confidence',
      'write', 'click', 'dispatch', 'submit', 'html', 'screenshot',
    ]) {
      expect(wire.toLowerCase()).not.toContain(forbidden);
    }
  });
});
