import { describe, expect, it } from 'vitest';

import { autofillPanelAffordance } from '../product-panel/affordance';
import type { SiteSupportVerdict } from '../lib/siteSupport';

const verdict = (over: Partial<SiteSupportVerdict> = {}): SiteSupportVerdict => ({
  state: 'SUPPORTED', shouldExplain: false, guidance: null, vendor: 'greenhouse', refusal: null, ...over,
});

describe('autofillPanelAffordance before any scan', () => {
  // Iron rule: no host DOM is read and no form is parsed until a verified runtime
  // authorization exists. The URL alone already told the manifest to inject us, so
  // the first face is built from that fact only - never from the user's form.
  it('offers nothing on a path that is not an application form', () => {
    expect(autofillPanelAffordance({ site: null, onApplyFormPath: false, connected: true, missionBound: true }))
      .toEqual({ kind: 'HIDDEN' });
  });
  it('shows itself on a known application path without reading the form', () => {
    expect(autofillPanelAffordance({ site: null, onApplyFormPath: true, connected: false, missionBound: false }))
      .toEqual({ kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' });
  });
  it('still refuses Autofill on a form it cannot tie to a Mission', () => {
    expect(autofillPanelAffordance({ site: null, onApplyFormPath: true, connected: true, missionBound: false }))
      .toEqual({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' });
  });
  it('offers Autofill from the path alone once connected and bound', () => {
    expect(autofillPanelAffordance({ site: null, onApplyFormPath: true, connected: true, missionBound: true }))
      .toEqual({ kind: 'READY' });
  });
});

describe('autofillPanelAffordance', () => {
  it('shows nothing at all on a page the gate refused', () => {
    expect(autofillPanelAffordance({
      site: verdict({ state: 'UNSUPPORTED', vendor: null, refusal: 'EMPLOYER_CONSOLE' }),
      connected: true, missionBound: true,
    })).toEqual({ kind: 'HIDDEN' });
  });
  it('shows nothing on an ordinary page that is not an application form', () => {
    expect(autofillPanelAffordance({
      site: verdict({ state: 'UNSUPPORTED', vendor: null }), connected: true, missionBound: true,
    })).toEqual({ kind: 'HIDDEN' });
  });
  it('explains instead of offering Autofill when the vendor is known but the form is not reachable', () => {
    expect(autofillPanelAffordance({
      site: verdict({ state: 'LIKELY_SUPPORTED', shouldExplain: true, guidance: 'SIGN_IN_FIRST' }),
      connected: true, missionBound: true,
    })).toEqual({ kind: 'GUIDANCE', guidance: 'SIGN_IN_FIRST' });
  });
  it('offers Autofill only once the portal is connected', () => {
    expect(autofillPanelAffordance({ site: verdict(), connected: false, missionBound: true }))
      .toEqual({ kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' });
  });
  it('never offers Autofill for a page it cannot tie to a Mission', () => {
    expect(autofillPanelAffordance({ site: verdict(), connected: true, missionBound: false }))
      .toEqual({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' });
  });
  it('is READY only on a supported form, connected, with the Mission bound', () => {
    expect(autofillPanelAffordance({ site: verdict(), connected: true, missionBound: true }))
      .toEqual({ kind: 'READY' });
  });
});
