export interface Viewport { readonly width: number; readonly height: number }
export interface PanelDimensions extends Viewport { readonly margin: number; readonly wide: boolean }
export interface BoatRect extends Viewport { readonly x: number; readonly y: number }

/** Available product viewport, after any development-only chrome is removed. */
export function panelDimensions(scene: string, viewport: Viewport): PanelDimensions {
  const margin = viewport.width < 480 ? 12 : 24;
  const availableWidth = Math.max(1, viewport.width - margin * 2);
  const availableHeight = Math.max(1, viewport.height - margin * 2);
  const wide = (scene === 'chat' || scene === 'profile') && availableWidth >= 848;
  return {
    width: wide ? 848 : viewport.width < 480 ? availableWidth : Math.min(416, availableWidth),
    height: wide ? Math.min(636, availableHeight) : viewport.width < 480 ? availableHeight : Math.min(738, availableHeight),
    margin, wide,
  };
}

export const heroHeight = (panel: PanelDimensions) => Math.max(150, Math.min(320, panel.height - 390));

export function boatRect(scene: string, panel: PanelDimensions): BoatRect {
  if (scene !== 'welcome') return { x: 20, y: 20, width: 48, height: 48 };
  const hero = heroHeight(panel);
  const height = Math.min(Math.round(hero * .78), 230);
  const width = Math.min(300, panel.width - 90, Math.round(height / .74));
  return { x: (panel.width - width) / 2, y: 48 + (hero - height) / 2, width, height };
}
