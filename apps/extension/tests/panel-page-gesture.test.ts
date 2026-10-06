// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProductPanelPrototypeAdapter } from '../product-panel/prototypeAdapter';
import { mountProductPanel } from '../product-panel/panel';

afterEach(() => document.body.replaceChildren());

describe('a gesture made on the in-page panel', () => {
  // The run lives in the side panel; the button the user actually pressed is on
  // the page. If this stops reaching the same start, that button goes dead.
  it('starts the same run the side panel button starts', async () => {
    const real = createProductPanelPrototypeAdapter(async () => ({ ok: true }));
    const start = vi.fn(real.requestStartAutofill.bind(real));
    const adapter = { ...real, requestStartAutofill: start };
    const root = document.createElement('div');
    document.body.append(root);
    const mounted = mountProductPanel(root, adapter, { reducedMotion: true });
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    mounted.startFromPageGesture();
    expect(start).toHaveBeenCalledWith({ kind: 'START_AUTOFILL' });
  });
});
