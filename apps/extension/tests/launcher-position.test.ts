import { describe, expect, it } from 'vitest';

import { LAUNCHER_TOP_RATIO_KEY, launcherTopRatio, launcherTopPx } from '../product-panel/launcherPosition';

describe('launcher position', () => {
  it('stores where the user put it as a share of the viewport, not pixels', () => {
    // A remembered pixel offset lands somewhere else on a laptop than on a
    // monitor. A ratio survives both, and every resize in between.
    expect(launcherTopRatio(440, 58, 1000)).toBeCloseTo(0.44, 5);
    expect(launcherTopPx(0.44, 58, 800)).toBeCloseTo(352, 5);
  });
  it('keeps the whole launcher on screen at both ends', () => {
    expect(launcherTopRatio(-500, 58, 1000)).toBeCloseTo(0.008, 5);
    expect(launcherTopRatio(99999, 58, 1000)).toBeCloseTo(0.934, 5);
    expect(launcherTopPx(9, 58, 200)).toBe(134);
    expect(launcherTopPx(-9, 58, 200)).toBe(8);
  });
  it('refuses a viewport that cannot hold it rather than returning a nonsense ratio', () => {
    // Zero or negative height happens in a hidden tab and during teardown.
    expect(launcherTopRatio(100, 58, 0)).toBe(0);
    expect(launcherTopPx(0.44, 58, 0)).toBe(0);
  });
  it('names its storage key once, so the content script and tests cannot drift', () => {
    expect(LAUNCHER_TOP_RATIO_KEY).toBe('argolandLauncherTopRatio');
  });
});
