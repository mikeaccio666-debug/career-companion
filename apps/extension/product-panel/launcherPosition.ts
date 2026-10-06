/**
 * Where the launcher sits, and where it is allowed to sit.
 *
 * Pure and dependency-free so the drag contract is provable without a document.
 * The vertical position is kept as a share of the viewport rather than a pixel
 * offset: a pixel the user chose on a 27" monitor is off-screen on a laptop,
 * and every window resize would otherwise drift the launcher out of reach.
 */

/** The one name this position is stored under. */
export const LAUNCHER_TOP_RATIO_KEY = 'argolandLauncherTopRatio';

/** Breathing room kept between the launcher and either viewport edge. */
const MARGIN = 8;

function clampTop(desiredTopPx: number, launcherHeight: number, viewportHeight: number): number {
  const maxTop = Math.max(MARGIN, viewportHeight - launcherHeight - MARGIN);
  return Math.max(MARGIN, Math.min(desiredTopPx, maxTop));
}

/** A dragged-to pixel offset, clamped on screen and expressed as a 0..1 share. */
export function launcherTopRatio(
  desiredTopPx: number,
  launcherHeight: number,
  viewportHeight: number,
): number {
  // A viewport with no height is a hidden tab or a teardown, not a position.
  if (!(viewportHeight > 0)) return 0;
  return clampTop(desiredTopPx, launcherHeight, viewportHeight) / viewportHeight;
}

/** A remembered share, resolved against today's viewport and clamped on screen. */
export function launcherTopPx(
  ratio: number,
  launcherHeight: number,
  viewportHeight: number,
): number {
  if (!(viewportHeight > 0)) return 0;
  const wanted = Number.isFinite(ratio) ? ratio * viewportHeight : 0;
  return clampTop(wanted, launcherHeight, viewportHeight);
}
