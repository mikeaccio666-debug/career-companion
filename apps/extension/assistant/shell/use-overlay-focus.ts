import { useLayoutEffect, type RefObject } from 'react';

export function useOverlayFocus(root: RefObject<HTMLElement | null>, kind: string | null) {
  useLayoutEffect(() => {
    if (!kind || !root.current) return;
    const overlay = root.current.querySelector<HTMLElement>(kind === 'modal' ? '[data-modal]' : '[data-sheet]'); if (!overlay) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controls = () => [...overlay.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')].filter(el => el.getClientRects().length > 0);
    controls()[0]?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = controls(), first = items[0], last = items.at(-1); if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    overlay.addEventListener('keydown', key);
    return () => { overlay.removeEventListener('keydown', key); if (before?.isConnected) before.focus({ preventScroll: true }); };
  }, [root, kind]);
}
