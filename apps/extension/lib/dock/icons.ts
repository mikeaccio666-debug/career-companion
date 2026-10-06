/**
 * 浮层的图标（2026-09-23 设计交接 `ArgoAI Autofill.dc.html` 的原样路径）。
 *
 * 逐个节点建 SVG，不从字符串拼标记：浮层挂在宿主页上，页面上来的文字（题目原文）同一个文件里
 * 也在拼，任何一处 innerHTML 都是一扇不该开的门。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

interface IconSpec {
  readonly stroke: number;
  readonly paths?: readonly string[];
  /** "cx cy r" */
  readonly circles?: readonly string[];
  /** "x y w h rx" */
  readonly rects?: readonly string[];
  /** 实心圆点（更多菜单的三个点）："cx cy r" */
  readonly dots?: readonly string[];
  readonly cap?: 'round' | 'butt';
}

const ICONS = {
  boat: { stroke: 1.7, paths: ['M11.2 3.6v10.6H5.4Z', 'M12.8 5.2l5.8 9H12.8Z', 'M3.8 16.8h16.4l-2.4 3.2H6.2Z'] },
  spark: { stroke: 1.7, paths: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z', 'M18.6 15.4l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z'] },
  check: { stroke: 3, paths: ['m5 12.5 4.2 4.2L19 7'] },
  pen: { stroke: 2.4, paths: ['M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17Z'] },
  x: { stroke: 3.2, paths: ['M7 7l10 10M17 7 7 17'] },
  locate: { stroke: 1.8, circles: ['12 12 6.5', '12 12 1.6'], paths: ['M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3'] },
  signature: { stroke: 2.2, paths: ['M3 17c3-1 4-8 6-8s-1 8 1 8 3-4 4-4 1 3 3 3 2-1 4-1'] },
  chevronDown: { stroke: 2, paths: ['m6 9 6 6 6-6'] },
  chevronRight: { stroke: 2.2, paths: ['m9 6 6 6-6 6'] },
  chevronLeft: { stroke: 2, paths: ['m15 6-6 6 6 6'] },
  arrowRight: { stroke: 2, paths: ['M5 12h14m-6-6 6 6-6 6'] },
  retry: { stroke: 2, paths: ['M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7'] },
  copy: { stroke: 1.8, rects: ['8.5 8.5 11 11 2.5'], paths: ['M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5'] },
  cloudOff: { stroke: 1.8, paths: ['M3.5 3.5l17 17', 'M9 6.3A6 6 0 0 1 17.8 10a4 4 0 0 1 2.4 6.6M16 18H7a4.5 4.5 0 0 1-1.6-8.7'] },
  alert: { stroke: 1.8, circles: ['12 12 8.5'], paths: ['M12 7.5v5.5M12 16.4v.1'] },
  doc: { stroke: 1.7, paths: ['M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20Z', 'M14 3.5V8h4.5M9.5 12.5h5M9.5 16h5'] },
  clock: { stroke: 1.8, circles: ['12 12 8.5'], paths: ['M12 7.5V12l3 2'] },
  lock: { stroke: 1.8, rects: ['5.5 10.5 13 9 2'], paths: ['M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5'] },
  person: { stroke: 1.8, circles: ['12 8 3.6'], paths: ['M5 20c.8-3.6 3.6-5.4 7-5.4s6.2 1.8 7 5.4'] },
  mail: { stroke: 1.8, rects: ['3.5 5.5 17 13 2.5'], paths: ['m4.5 7 7.5 6 7.5-6'] },
  external: { stroke: 2, paths: ['M14 4h6v6M20 4l-8.5 8.5M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10'] },
  // 收起到右边（»|，2026-09-24）：两道右尖括号撞上一道竖线。原来那个「带竖线的方框」读起来像开关侧栏，不像收起。
  // 线宽按 16px 画成 1.5px（24 格里 2.25）。
  collapseRight: { stroke: 2.25, paths: ['m5.5 7 5 5-5 5', 'm11.5 7 5 5-5 5', 'M19.5 5.5v13'] },
  expand: { stroke: 2, paths: ['M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5'] },
  more: { stroke: 0, dots: ['6 12 1.5', '12 12 1.5', '18 12 1.5'] },
  undo: { stroke: 1.8, paths: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'] },
  home: { stroke: 1.8, paths: ['M4 10.5 12 4l8 6.5', 'M6.5 9v10.5h4v-5.5h3v5.5h4V9'] },
  bookmark: { stroke: 1.8, paths: ['M7 4.5h10v15l-5-3.6-5 3.6Z'] },
  globe: { stroke: 1.7, circles: ['12 12 8.5'], paths: ['M3.5 12h17', 'M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5Z'] },
} as const satisfies Record<string, IconSpec>;

export type IconName = keyof typeof ICONS;

export interface IconOptions {
  /** 覆盖默认线宽（设计里同一个图标在不同位置线宽不同）。 */
  readonly stroke?: number;
  /** 船形标志在深色方块里带一层半透明填充。 */
  readonly fill?: string;
  readonly color?: string;
}

export function icon(doc: Document, name: IconName, size: number, options: IconOptions = {}): SVGSVGElement {
  const spec: IconSpec = ICONS[name];
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', options.fill ?? 'none');
  svg.setAttribute('stroke', options.color ?? 'currentColor');
  svg.setAttribute('stroke-width', String(options.stroke ?? spec.stroke));
  svg.setAttribute('stroke-linecap', spec.cap ?? 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const rect of spec.rects ?? []) {
    const [x = '0', y = '0', width = '0', height = '0', rx = '0'] = rect.split(' ');
    const node = doc.createElementNS(SVG_NS, 'rect');
    node.setAttribute('x', x);
    node.setAttribute('y', y);
    node.setAttribute('width', width);
    node.setAttribute('height', height);
    node.setAttribute('rx', rx);
    svg.append(node);
  }
  for (const circle of spec.circles ?? []) {
    const [cx = '0', cy = '0', r = '0'] = circle.split(' ');
    const node = doc.createElementNS(SVG_NS, 'circle');
    node.setAttribute('cx', cx);
    node.setAttribute('cy', cy);
    node.setAttribute('r', r);
    svg.append(node);
  }
  for (const dot of spec.dots ?? []) {
    const [cx = '0', cy = '0', r = '0'] = dot.split(' ');
    const node = doc.createElementNS(SVG_NS, 'circle');
    node.setAttribute('cx', cx);
    node.setAttribute('cy', cy);
    node.setAttribute('r', r);
    node.setAttribute('fill', 'currentColor');
    node.setAttribute('stroke', 'none');
    svg.append(node);
  }
  for (const d of spec.paths ?? []) {
    const node = doc.createElementNS(SVG_NS, 'path');
    node.setAttribute('d', d);
    svg.append(node);
  }
  return svg;
}
