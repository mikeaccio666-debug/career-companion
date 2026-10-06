/** Timings and curves from the accepted Fable prototype. */
export const MOTION = Object.freeze({
  ease: 'cubic-bezier(.32,.72,0,1)', easeOut: 'cubic-bezier(.16,1,.3,1)', easeIn: 'cubic-bezier(.4,0,1,1)',
  fast: 180, base: 320, slow: 560, resize: 640, stagger: 55,
  morphOut: 240, morphMove: 440, morphSettle: 340,
  card: 540, fly: 480, streamMin: 18, streamMax: 42, streamPause: 150,
});

export type MotionResult = { readonly status: 'finished' | 'cancelled' | 'unavailable' };

/** Cancellation is expected during a scene/reset. Never log animation payloads. */
export async function animateElement(
  element: HTMLElement | null,
  frames: Keyframe[],
  options: KeyframeAnimationOptions,
  signal: AbortSignal,
  reduced = false,
  persistFinal = true,
): Promise<MotionResult> {
  if (!element) return { status: 'unavailable' };
  if (signal.aborted) return { status: 'cancelled' };
  const applyFinal = () => {
    if (!persistFinal) return;
    const last = frames.at(-1);
    if (!last) return;
    for (const [key, value] of Object.entries(last)) {
      if (key === 'offset' || key === 'easing' || key === 'composite' || value == null) continue;
      const cssKey = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
      element.style.setProperty(cssKey, String(value));
    }
  };
  if (reduced || typeof element.animate !== 'function') {
    applyFinal();
    return { status: 'finished' };
  }
  const animation = element.animate(frames, { easing: MOTION.ease, fill: 'both', ...options });
  const cancel = () => animation.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await animation.finished;
    if (signal.aborted) return { status: 'cancelled' };
    applyFinal();
    animation.cancel();
    return { status: 'finished' };
  } catch {
    return { status: signal.aborted || animation.playState === 'idle' ? 'cancelled' : 'unavailable' };
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
