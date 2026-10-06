/**
 * 浮层建节点的两个小工具。只建节点、只写文字——从不把字符串当标记解析。
 */

/** An element with a class and, optionally, text. Text only: never markup. */
export function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 浮层里一颗按钮的处理抛了（同步抛出、或交回的 promise 被拒）：从前异常直接冒出点击处理器，按了没反应，后台一个码都没有
 * （2026-10-04 体检 11-2）。现在先交给浮层挂上时登记的那一处（它只记一个稳定码与闭集里的类名，lib/dockDiagnostic.ts），再照旧
 * 抛出——不装全页的 error 监听，网站自己的错与我们无关。
 */
type HandlerErrorSink = (kind: 'THREW' | 'REJECTED', error: unknown) => void;
let handlerErrorSink: HandlerErrorSink | null = null;

/** 浮层挂上时登记（后挂的那一个说了算）。 */
export function setDockHandlerErrorSink(sink: HandlerErrorSink | null): void {
  handlerErrorSink = sink;
}

const reportHandlerError: HandlerErrorSink = (kind, error) => {
  try {
    handlerErrorSink?.(kind, error);
  } catch {
    // 记码那一头自己坏了：照旧把原来那个错抛出去。
  }
};

/**
 * 只认用户本人的按钮：`isTrusted` 是唯一的门。页面能找到我们的按钮、能朝它派发点击，
 * 但那一下不是用户做的决定。
 */
export function trusted(
  doc: Document,
  className: string,
  onSelect: (event: MouseEvent) => void,
  text?: string,
): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = 'button';
  if (className !== '') button.className = className;
  if (text !== undefined) button.textContent = text;
  button.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    let result: unknown;
    try {
      result = onSelect(event);
    } catch (error) {
      reportHandlerError('THREW', error);
      throw error;
    }
    if (typeof (result as { then?: unknown } | null | undefined)?.then === 'function') {
      (result as Promise<unknown>).then(undefined, (error: unknown) => {
        reportHandlerError('REJECTED', error);
        throw error;
      });
    }
  });
  return button;
}

/** Web Animations 在测试环境里可能没有；没有就不动，状态照样对。 */
export function animate(
  node: Element | null | undefined,
  keyframes: Keyframe[] | PropertyIndexedKeyframes,
  options: KeyframeAnimationOptions,
): Animation | null {
  if (node === null || node === undefined) return null;
  const fn = (node as Element & { animate?: Element['animate'] }).animate;
  if (typeof fn !== 'function') return null;
  try {
    return fn.call(node, keyframes, options);
  } catch {
    return null;
  }
}

/** 等一段时间；减少动态时最多等 60ms（设计原型 `later` 的同一条规矩）。 */
export function wait(ms: number, reduced: boolean): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, reduced ? Math.min(ms, 60) : ms); });
}
