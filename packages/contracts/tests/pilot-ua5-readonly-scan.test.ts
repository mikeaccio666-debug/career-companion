import { describe, expect, it } from 'vitest';
import * as contracts from '../src/draft/pilotUa5Certification';

const scan = () => ({
  schemaVersion: 1, observedControls: 3, hiddenNotObservedCount: 2,
  unobservedRegions: 1, structureAvailable: true, pageIdentity: 'UNVERIFIED',
});

describe('read-only UA-1 rescan presentation', () => {
  it('keeps scan accounting separate from a run or wizard completion', () => {
    const value = scan();
    const parsed = contracts.parsePilotUa5ReadOnlyScan(value);
    expect(parsed).toEqual({ ok: true, value });
    value.observedControls = 5;
    expect(parsed.ok && parsed.value.observedControls).toBe(3);
    expect(parsed.ok && Object.isFrozen(parsed.value)).toBe(true);
    expect(contracts.parsePilotUa5RunProjection(scan()).ok).toBe(false);
  });

  it.each([
    { pageIdentity: 'CONFIRMED' }, { pageOrdinal: 1 }, { wholeWizardComplete: true },
    { values: ['excluded'] }, { label: 'excluded' }, { observedControls: 65 },
    { observedControls: -1 }, { hiddenNotObservedCount: -1 }, { unobservedRegions: 65 },
    { structureAvailable: 'true' }, { schemaVersion: 2 },
  ])('rejects invalid accounting or extra claims %#', (change) => {
    expect(contracts.parsePilotUa5ReadOnlyScan({ ...scan(), ...change })).toEqual({ ok: false, code: 'PILOT_UA5_INPUT_INVALID' });
  });

  it('does not evaluate an accessor or normalize an inherited fact', () => {
    const accessor = scan();
    Object.defineProperty(accessor, 'pageIdentity', { enumerable: true, get() { throw new Error('TEST_ACCESSOR_READ'); } });
    expect(contracts.parsePilotUa5ReadOnlyScan(accessor).ok).toBe(false);
    expect(contracts.parsePilotUa5ReadOnlyScan(Object.create(scan())).ok).toBe(false);
  });
});
