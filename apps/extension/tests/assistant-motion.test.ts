// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { animateElement } from '../assistant/design/motion';
describe('responsive panel animation', () => {
  it('does not overwrite a newer layout size when an older resize animation finishes', async () => {
    const panel = document.createElement('div'); panel.style.width = '848px';
    let finish!: () => void;
    const animation = { finished: new Promise<void>(resolve => { finish = resolve; }), cancel: vi.fn(), playState: 'finished' };
    panel.animate = vi.fn(() => animation as unknown as Animation);
    const pending = animateElement(panel, [{ width: '416px' }, { width: '848px' }], { duration: 640 }, new AbortController().signal, false, false);
    panel.style.width = '366px'; finish(); await pending;
    expect(panel.style.width).toBe('366px'); expect(animation.cancel).toHaveBeenCalledOnce();
  });
});
