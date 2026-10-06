/**
 * 单页应用里换了路径（history.pushState／replaceState、前进后退）时回调一次（2026-09-24）。
 *
 * Chrome 不为站内换页重新注入内容脚本，也没有 load／focus／pageshow，内容脚本就一直停在加载时
 * 那一页的结论上。测试台实测 Rippling：岗位页点「Apply now」是站内换到 /apply，浮层要等用户切走
 * 再切回来才出来。
 *
 * 用 Navigation API 的 currententrychange：在内容脚本的隔离世界里也收得到页面主世界 pushState
 * 引起的那一次（测试台实测）。没有这个 API 的老浏览器退回按间隔看一眼路径。只在 pathname 变了时
 * 回调——查询串、锚点变化不是换页。返回的函数撤掉监听。
 */
export function onSamePagePathChange(view: Window, onChange: () => void, pollMs = 1000): () => void {
  // 测试桩里的 window 可能没有 location：读不到就当空路径，不在装监听时抛出。
  const pathOf = (): string => view.location?.pathname ?? '';
  let last = pathOf();
  const check = (): void => {
    const now = pathOf();
    if (now === last) return;
    last = now;
    onChange();
  };
  view.addEventListener('popstate', check);
  const navigation = (view as unknown as { navigation?: EventTarget }).navigation;
  if (navigation !== undefined && typeof navigation.addEventListener === 'function') {
    navigation.addEventListener('currententrychange', check);
    return () => {
      navigation.removeEventListener('currententrychange', check);
      view.removeEventListener('popstate', check);
    };
  }
  const timer = setInterval(check, pollMs);
  return () => {
    clearInterval(timer);
    view.removeEventListener('popstate', check);
  };
}
