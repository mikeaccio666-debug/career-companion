/** The browser adapter supplies actual computed styles; synthetic ports only test this policy. */
export interface SafetyResourceVisibilityPort<Node> {
  connected(node: Node): boolean;
  pageVisible(node: Node): boolean;
  parent(node: Node): Node | null;
  hiddenAttribute(node: Node): boolean;
  style(node: Node): { display: string; visibility: string; contentVisibility: string; opacity: string };
  rect(node: Node): { width: number; height: number; top: number; bottom: number; left: number; right: number };
  viewport(node: Node): { width: number; height: number } | null;
  sameDocument(left: Node, right: Node): boolean;
  hasText(node: Node): boolean;
}

export const browserSafetyResourceVisibility: SafetyResourceVisibilityPort<HTMLElement> = {
  connected: node => node.isConnected,
  pageVisible: node => node.ownerDocument.visibilityState === 'visible',
  parent: node => node.parentElement,
  hiddenAttribute: node => node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true',
  style(node) {
    const view = node.ownerDocument.defaultView;
    if (!view) throw new Error('Resource document has no live view.');
    const style = view.getComputedStyle(node);
    return { display: style.display, visibility: style.visibility, contentVisibility: style.contentVisibility, opacity: style.opacity };
  },
  rect: node => node.getBoundingClientRect(),
  viewport: node => {
    const view = node.ownerDocument.defaultView;
    return view ? { width: view.innerWidth, height: view.innerHeight } : null;
  },
  sameDocument: (left, right) => left.ownerDocument === right.ownerDocument,
  hasText: node => !!node.textContent,
};

function visible<Node>(node: Node, port: SafetyResourceVisibilityPort<Node>, requireGeometry: boolean): boolean {
  try {
    if (!port.connected(node) || !port.pageVisible(node)) return false;
    const visited = new Set<Node>();
    for (let current: Node | null = node; current !== null; current = port.parent(current)) {
      // A malformed or unexpectedly deep ancestry is not evidence of a visible resource.
      if (visited.has(current) || visited.size >= 256 || !port.connected(current) || port.hiddenAttribute(current)) return false;
      visited.add(current);
      const style = port.style(current), opacity = Number(style.opacity);
      if (!style.display || style.display === 'none' || style.visibility !== 'visible' || style.contentVisibility === 'hidden'
        || !style.opacity.trim() || !Number.isFinite(opacity) || opacity <= 0 || opacity > 1) return false;
    }
    if (!requireGeometry) return true;
    const rect = port.rect(node), viewport = port.viewport(node);
    return !!viewport && [rect.width, rect.height, rect.top, rect.bottom, rect.left, rect.right, viewport.width, viewport.height].every(Number.isFinite)
      && viewport.width > 0 && viewport.height > 0 && rect.width > 0 && rect.height > 0
      && rect.bottom > 0 && rect.right > 0 && rect.top < viewport.height && rect.left < viewport.width;
  } catch { return false; }
}

export function isSafetyResourceDomVisible<Node>(node: Node, port: SafetyResourceVisibilityPort<Node>): boolean {
  return visible(node, port, true);
}

/** An empty connected slot can be ready before it has geometry. Once written, the question must itself be visible. */
export function isSafetyResourceQuestionSlotReady<Node>(body: Node, slot: Node, port: SafetyResourceVisibilityPort<Node>): boolean {
  try {
    return port.sameDocument(body, slot) && visible(body, port, true) && visible(slot, port, port.hasText(slot));
  } catch { return false; }
}
