/** Value-free, local layout experiment. It carries no business or runtime command. */
export type LayoutState = { type: 'argo-lab-layout'; width: number; height: number; open: boolean };
export function readLayout(value: unknown, available: { width: number; height: number }): LayoutState | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 4 || v.type !== 'argo-lab-layout' || typeof v.open !== 'boolean' || typeof v.width !== 'number' || typeof v.height !== 'number' || !Number.isFinite(v.width) || !Number.isFinite(v.height) || v.width <= 0 || v.height <= 0 || v.width > available.width || v.height > available.height) return null;
  return { type: 'argo-lab-layout', width: v.width, height: v.height, open: v.open };
}
