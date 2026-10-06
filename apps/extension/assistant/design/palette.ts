const palette = {
  ink: '#0A1128', ink2: '#3B4762', muted: '#6B778C', faint: '#8A94A8', line: '#E3E9F1',
  steel: '#A8C0DC', peri: '#B3B8EA', warm: '#FF9D4D', coral: '#FF7A6B', green: '#25795A',
  ice: '#EEF4FA', lilac: '#F3F1FC', peach: '#FFF3E8', mint: '#EAF5F0', rose: '#FDECEA', grey: '#F3F6FA', white: '#fff',
};
export const C = Object.freeze(palette);
export const THEME_VARS = Object.fromEntries(Object.entries(C).map(([key, value]) => [
  `--argo-${key === 'ink2' ? 'ink-2' : key}`, value,
]));
export const MARKS = [C.ice, C.lilac, C.peach, C.mint];
export const PRIMARY_BG = 'linear-gradient(180deg,#1B2542,#0A1128)';
export const PRIMARY_SHADOW = 'inset 0 1px 0 rgba(255,255,255,.16),0 1px 2px rgba(10,17,40,.3),0 12px 24px -12px rgba(10,17,40,.6)';
