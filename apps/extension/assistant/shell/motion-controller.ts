import { animateElement, MOTION } from '../design/motion';
import { boatRect, panelDimensions, type Viewport } from './geometry';
import type { ControllerContext, AssistantMotion } from '../app/controller-context';

/** All queries are rooted in the assistant's own UI. No host DOM is inspected. */
export function createShellMotion(root: HTMLElement, ctx: ControllerContext, viewport: () => Viewport): AssistantMotion {
  const q = (selector: string) => root.querySelector<HTMLElement>(selector);
  const qa = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
  const animate = (el: HTMLElement | null, frames: Keyframe[], duration: number, delay = 0, signal = ctx.store.scope().signal) => animateElement(el, frames, { duration, delay }, signal, ctx.state.reduced);
  let navigation = 0;
  async function enter(signal: AbortSignal) {
    await ctx.afterRender();
    if (signal.aborted) return;
    const scene = q('[data-scene]'); if (scene) { scene.style.opacity = '1'; scene.style.transform = 'none'; }
    await Promise.all(qa('[data-scene] [data-enter]').map((el, i) => animate(el, [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], 420, i * MOTION.stagger, signal)));
  }
  async function fly(from: HTMLElement | null, to: HTMLElement | null, delay = 0) {
    const signal = ctx.store.scope().signal;
    if (!from || !to || ctx.state.reduced || signal.aborted) return;
    const bounds = root.getBoundingClientRect(), a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
    const clone = document.createElement('span'); clone.textContent = from.textContent;
    Object.assign(clone.style, { position: 'absolute', left: `${a.left - bounds.left}px`, top: `${a.top - bounds.top}px`, maxWidth: '260px', padding: '3px 9px', borderRadius: '9px', background: '#B3B8EA', color: '#0A1128', fontSize: '12px', pointerEvents: 'none', zIndex: '80', whiteSpace: 'nowrap' });
    root.append(clone);
    try { const dx = b.left - a.left, dy = b.top - a.top;
      await animate(clone, [{ transform: 'none', opacity: 0 }, { transform: `translate(${dx * .15}px,-16px) scale(1.04)`, opacity: 1, offset: .22 }, { transform: `translate(${dx * .6}px,${dy * .55 - 26}px) scale(1.02)`, opacity: 1, offset: .62 }, { transform: `translate(${dx}px,${dy}px)`, opacity: 1 }], MOTION.fly, delay, signal); }
    finally { clone.remove(); }
  }
  const motion: AssistantMotion = {
    async navigate(scene, commit, morph = false) {
      const id = ++navigation, scope = ctx.store.scope();
      if (morph && ctx.state.scene === 'welcome' && !ctx.state.reduced) {
        const host = q('[data-boat-host]'), from = boatRect('welcome', panelDimensions('welcome', viewport())), to = boatRect('home', panelDimensions('home', viewport()));
        await Promise.all(qa('[data-scene="welcome"] [data-enter], [data-mentor], [data-hero-label]').map((el, i) => animate(el, [{ opacity: el.style.opacity || '1', transform: el.style.transform || 'none' }, { opacity: 0, transform: 'translateY(8px) scale(.92)' }], 220, Math.min(i * 20, 80), scope.signal)));
        if (scope.signal.aborted || id !== navigation) return;
        await animate(host, [{ transform: 'none' }, { transform: `translate(${to.x - from.x}px,${to.y - from.y}px) scale(${112 / from.width})` }], MOTION.morphMove, 0, scope.signal);
        if (scope.signal.aborted || id !== navigation) return;
        if (host) host.style.transform = 'none'; commit(); await ctx.afterRender();
        await Promise.all([animate(host, [{ transform: `scale(${112 / to.width})` }, { transform: 'none' }], MOTION.morphSettle, 0, scope.signal), enter(scope.signal)]);
      } else {
        const panel = q('[data-panel]'), old = panel?.getBoundingClientRect();
        await animate(q('[data-scene]'), [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px) scale(.99)' }], MOTION.fast, 0, scope.signal);
        if (scope.signal.aborted || id !== navigation) return;
        commit(); await ctx.afterRender();
        const dims = panelDimensions(scene, viewport());
        await Promise.all([old ? animateElement(panel, [{ width: `${old.width}px`, height: `${old.height}px` }, { width: `${dims.width}px`, height: `${dims.height}px` }], { duration: MOTION.resize }, scope.signal, ctx.state.reduced, false) : Promise.resolve(), enter(scope.signal)]);
      }
    },
    async visibility(open, commit) {
      const panel = q('[data-panel]'); if (open) { commit(); await ctx.afterRender(); }
      if (panel) panel.style.visibility = 'visible';
      await animate(panel, open ? [{ opacity: 0, transform: 'translateX(36px) scale(.97)' }, { opacity: 1, transform: 'none' }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(50px) scale(.94)' }], 320);
      if (!open && panel) panel.style.visibility = 'hidden';
    },
    async chooseCard(accept) {
      const card = q('[data-job-card]'), target = q(accept ? '[data-boat-host]' : '[data-bin]');
      if (!card || !target) return;
      const a = card.getBoundingClientRect(), b = target.getBoundingClientRect();
      const dx = b.left + b.width / 2 - a.left - a.width / 2, dy = b.top + b.height / 2 - a.top - a.height / 2, rotation = accept ? -12 : 12;
      await Promise.all([
        animate(card, [{ transform: 'none', opacity: 1 }, { transform: `translate(${accept ? -34 : 34}px,-10px) rotate(${rotation / 2}deg) scale(.96)`, opacity: 1, offset: .3 }, { transform: `translate(${dx}px,${dy}px) rotate(${rotation}deg) scale(.06)`, opacity: 0 }], MOTION.card),
        animate(target, [{ transform: 'scale(1)' }, { transform: 'scale(1.14)' }, { transform: 'scale(1)' }], 360, MOTION.card - 120),
      ]);
    },
    enterCard(undoFrom) {
      const card = q('[data-job-card]'), target = q(undoFrom ? '[data-boat-host]' : '[data-bin]');
      let transform = 'translateY(10px) scale(.97)';
      if (undoFrom !== undefined && card && target) { const a = card.getBoundingClientRect(), b = target.getBoundingClientRect(); transform = `translate(${b.left + b.width / 2 - a.left - a.width / 2}px,${b.top + b.height / 2 - a.top - a.height / 2}px) scale(.08)`; }
      void animate(card, [{ opacity: 0, transform }, { opacity: 1, transform: 'none' }], undoFrom === undefined ? 380 : 480);
    },
    async extract(id) {
      const signal = ctx.store.scope().signal;
      const selector = `[data-msg-id="${CSS.escape(id)}"]`;
      await Promise.all(qa(`${selector} [data-seg]`).map((el, i) => animate(el, el.dataset.seg === 'key' ? [{ background: 'transparent', color: '#fff' }, { background: '#B3B8EA', color: '#0A1128' }] : [{ opacity: 1 }, { opacity: .5 }], 320, i * 35, signal)));
      if (signal.aborted) return;
      await Promise.all(qa(`${selector} [data-seg="key"]`).map(async (el, i) => {
        const field = CSS.escape(el.dataset.segField ?? '');
        await fly(el, q(`[data-extract-list="${CSS.escape(id)}"] [data-extract-pill="${field}"]`), i * 90);
        await animate(q(`[data-extract-list="${CSS.escape(id)}"] [data-extract-item="${field}"]`), [{ opacity: 0, transform: 'translateX(-4px)' }, { opacity: 1, transform: 'none' }], 220);
      }));
    },
    async candidate(id, messageId, fields) {
      const signal = ctx.store.scope().signal;
      motion.scrollChat();
      const card = `[data-cand-card="${CSS.escape(id)}"]`;
      await animate(q(card), [{ opacity: 0, transform: 'translateY(18px) scale(.97)' }, { opacity: 1, transform: 'none' }], 460, 0, signal);
      if (signal.aborted) return;
      if (messageId) await Promise.all(fields.filter(f => f.fromHit).map((f, i) => fly(q(`[data-extract-list="${CSS.escape(messageId)}"] [data-extract-pill="${f.key}"]`), q(`${card} [data-cand-row="${f.key}"]`), i * 45)));
    },
    saved(id) { void animate(q(`[data-cand-card="${CSS.escape(id)}"]`), [{ boxShadow: '0 0 0 0 rgba(56,108,79,0)', transform: 'scale(1)' }, { boxShadow: '0 0 0 3px rgba(56,108,79,.15)', transform: 'scale(1.008)' }, { boxShadow: '0 1px 2px rgba(10,17,40,.04)', transform: 'none' }], 560); },
    targetChanged() { void animate(q('[data-target-switcher]'), [{ opacity: .4, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], 320); },
    scrollChat() { requestAnimationFrame(() => { const chat = q('[data-chat-scroll]'); chat?.scrollTo({ top: chat.scrollHeight, behavior: ctx.state.reduced ? 'instant' : 'smooth' }); }); },
  };
  return motion;
}
