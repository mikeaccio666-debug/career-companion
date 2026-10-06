/**
 * 一次同步派发期间的「提交／重置否决」：派发进行中送达的 `submit` / `reset` 当场取消，并报告有没有见过。
 *
 * 两处用它，都是「我们按了一下宿主的按钮，而这一下本身不该提交任何东西」：ARIA 代理题的选项
 * （write/proxyChoiceGroup.ts）与规则声明的「保存本段」（rowActions.ts 的 `clickSaveRow`，2026-09-24）。
 * 点击原语已经预先取消了 click 的默认动作、点击策略也拒绝一切提交形状的控件；这一层挡的是宿主自己的
 * 监听器在这一下里调 `requestSubmit()`／派一个 submit——那时整张申请表会被提交出去。
 *
 * 注册与原生选择题的围栏同一个口径（choiceGroup.ts 的 `nativeEventAccess`）：Document（和影子根）用这个
 * realm 自己的 `EventTarget.prototype` 方法挂（目标自带的包装藏不住事件），Window 用它自己的方法作补充一层。
 * 影子树里的表单派的事件不穿出影子根，所以目标所在的根也要挂。挂不上就一下都不派。
 */
export function runWithSubmitVeto(document: Document, rootNode: Node, activate: () => void): boolean {
  const view = document.defaultView;
  const add = view?.EventTarget?.prototype.addEventListener;
  const remove = view?.EventTarget?.prototype.removeEventListener;
  const viewAdd = view?.addEventListener;
  const viewRemove = view?.removeEventListener;
  if (
    typeof add !== 'function' || typeof remove !== 'function' ||
    (view !== null && (typeof viewAdd !== 'function' || typeof viewRemove !== 'function'))
  ) return false;
  const intrinsic: EventTarget[] = rootNode === document ? [document] : [document, rootNode];
  let blocked = false;
  const veto = (event: Event) => {
    blocked = true;
    event.preventDefault();
  };
  const undo: Array<() => void> = [];
  try {
    for (const type of ['submit', 'reset']) {
      for (const target of intrinsic) {
        undo.push(() => remove.call(target, type, veto, true));
        add.call(target, type, veto, true);
      }
      if (view !== null) {
        undo.push(() => viewRemove!.call(view, type, veto, true));
        viewAdd!.call(view, type, veto, true);
      }
    }
    activate();
  } finally {
    for (const step of undo) {
      try {
        step();
      } catch {
        // The veto is retired locally even if a hostile host patched removal.
      }
    }
  }
  return !blocked;
}
