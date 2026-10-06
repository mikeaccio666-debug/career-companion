import { describe, expect, it } from 'vitest';
import { readLayout } from '../assistant/spike/layout-channel';

describe('local iframe layout boundary', () => {
  const viewport = { width: 1280, height: 720 };
  it('accepts only finite bounded presentation dimensions', () => {
    const layout = { type: 'argo-lab-layout', width: 464, height: 720, open: true };
    expect(readLayout(layout, viewport)).toEqual(layout);
    for (const width of [0, -1, NaN, Infinity, 1281, '416']) expect(readLayout({ ...layout, width }, viewport)).toBeNull();
    expect(readLayout({ ...layout, type: 'fill' }, viewport)).toBeNull();
    expect(readLayout({ ...layout, fields: {} }, viewport)).toBeNull();
    expect(readLayout({ ...layout, open: 'true' }, viewport)).toBeNull();
  });
});
