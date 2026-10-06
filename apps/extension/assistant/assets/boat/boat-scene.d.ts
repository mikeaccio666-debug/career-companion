export interface BoatSceneHandle {
  setCompact(compact: boolean): void;
  pause(): void;
  resume(): void;
  destroy(): void;
}
export function mountBoatScene(
  container: HTMLElement,
  options?: { reducedMotion?: boolean; compact?: boolean },
): BoatSceneHandle;
