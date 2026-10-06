/**
 * 乙档放行确认条——**阻塞式**。
 *
 * `PD-2026-08-18-IRONCLAD-5-SPLIT`（10-产品方案 §4.5.1–4.5.3）已获三人
 * 签字并于 2026-08-19 随 PR #15 合入；签字不等于 production 放行。该裁决允许
 * 「信息属实」类声明代勾，但写入前必须让用户**逐条看到原文**并放行。
 * 本文件只做那一层界面与手势判定，**不写入、不接线、不碰 policy、不碰契约**。
 *
 * ## 与 `auditPanel.ts` 的关系：两个东西，不要合并
 *
 * `showAuditPanel` 是**写入完成之后**弹的非阻塞逐字段审计面板（「必填 2/3 ·
 * 请核对后自行提交」+ 逐行状态/定位/还原）。本条相反：**写入之前**弹，
 * 不点就不写。形态相反，所以另起名字。
 *
 * ## Data-L1 边界（这一段是本文件最要紧的纪律）
 *
 * `auditPanel.ts` 显示宿主标签与写入值，那是**本地 UI 边界之内**。**本条必须显示宿主页面
 * 上的声明原文**——那正是它存在的理由：法律含义就在措辞里，摘要成
 * 「已勾选 3 项声明」等于让用户在看不见内容的情况下签字。
 *
 * 这不违反铁律 1。铁律 1 管的是**外泄**——不进日志、遥测、错误上报。
 * 本文件的原文：
 *  - 只经 `textContent` 渲染进我们自己的 closed shadow root；
 *  - **绝不** `console.*`、绝不进错误消息、绝不进遥测；
 *  - **绝不**经 chat↔扩展通道（`channel.ts` 的 `FORBIDDEN_KEYS` 含
 *    `label/labels/value/values`，递归命中即整帧 `CHANNEL_MALFORMED`）；
 *  - **绝不**进回执——后端 Codex 2026-08-18 的评估明确：receipt 只记
 *    不可篡改的引用（digest），不放原文。
 *
 * ⚠️ 由此引出一条尚未裁决的事（`docs/67` D2）：**只存 digest 不足以独立
 * 还原用户当时看到的文案。** 所以本条能支撑的说法是「用户看到了原文并逐条
 * 放行」这个**产品行为**，不是「我们能事后举证他看到了什么」。
 * 两者不是一件事，签字前别混用。
 *
 * ## 安全
 *
 * 原文来自宿主页面，**一律 `textContent`，任何路径都不许 `innerHTML`**。
 * shadow root 用 `closed`：宿主页脚本遍历 DOM 也取不到内容
 * （内容脚本本身跑在隔离世界，宿主拿不到本模块）。
 *
 * ## 输入边界：整批校验，不静默去重
 *
 * Yiwen 与 Vivian **各自独立**做 hostile probe 抓到同一个洞
 * （2026-08-18 审 PR #21）：
 *
 *  1. **重复 `id`** —— 界面按 `items` 逐条渲染，但状态存在
 *     `Map<string, HTMLInputElement>` 里，`boxes.set(item.id, box)` 会静默覆盖。
 *     用户明确取消第一条、保留第二条，仍返回 `releasedIds: ['same']`；
 *     调用方无法证明这个 id 对应用户勾的哪一条，甚至可能把两条一起写入。
 *     **这直接推翻本模块唯一的承诺——「只放行用户当时勾着的那几条」。**
 *  2. **空白 `declarationText`** —— 界面照样显示「勾选这 1 条」，点下返回
 *     `released`。失败场景是抽取器没拿到原文，**用户实际没看到任何声明
 *     却产生了可执行的放行结果**，直接违反「逐条看到原文再放行」。
 *
 * 修法：渲染**之前**校验整批——`items` 非空、每个 `id` 非空且唯一、
 * `declarationText.trim()` 非空。任一不合法 → **整批 `declined` 且不渲染**。
 *
 * ⚠️ **刻意不静默去重**：去重会改变「逐条」的 identity。
 * 两条不同原文共用一个 id，本身就是调用方的 bug，
 * 悄悄合并等于替它决定哪一条算数。
 *
 * ## fail-closed
 *
 * 页面卸载、用户按 Esc、用户点取消、items 为空——**一律 `declined`**。
 * 只有用户显式点了主按钮才 `released`，且只放行他当时勾着的那几条。
 */

/** 一条待放行的声明。`id` 由调用方生成，**不含任何页面文本**。 */
export interface AttestationItem {
  readonly id: string;
  /** 宿主页面上的原文。只用于本地渲染，绝不外传（见头注 Data-L1 一节）。 */
  readonly declarationText: string;
}

export type AttestationDecision =
  /** 用户放行了这些 id（可能是全部，也可能是他勾剩下的一部分）。 */
  | { readonly kind: 'released'; readonly releasedIds: readonly string[] }
  /**
   * 取消 / Esc / 页面卸载 / 输入非法 / 宿主拆掉节点 —— 一条都不写。
   *
   * `reason` 是**稳定原因码**（铁律 2），不含任何原文（铁律 1）。
   * 调用方靠它区分「页面上没有声明」（正常）与「抽取器坏了」（该吵）。
   */
  | { readonly kind: 'declined'; readonly reason?: DeclineReason }
  /** 用户点了「不再自动处理这类声明」——本次不写，且要求整档关闭。 */
  | { readonly kind: 'tier-disabled' };

/** `declined` 的稳定原因码。不含原文——见 `AttestationDecision` 注释。 */
export type DeclineReason =
  /** 页面上一条声明都没有。**正常情况**，调用方不必吵。 */
  | 'EMPTY_BATCH'
  /** items 不是数组 / 元素不是对象 / 字段不是字符串——调用方 bug。 */
  | 'NOT_AN_ARRAY'
  | 'MALFORMED_ITEM'
  | 'MALFORMED_ID'
  | 'MALFORMED_TEXT'
  /** 两条声明共用一个 id——调用方 bug，**不许静默去重**。 */
  | 'DUPLICATE_ID'
  | 'BLANK_ID'
  /** 抽取器没拿到原文。**该吵**：用户会在看不见内容的情况下被问。 */
  | 'BLANK_DECLARATION_TEXT'
  /** 文档已脱离（iframe 被移除），装不上自动收口通道。 */
  | 'DETACHED_DOCUMENT'
  /** 宿主页把我们的节点摘掉了。 */
  | 'HOST_REMOVED'
  /** 用户点了取消 / Esc / 页面卸载 / 调用方主动拆除。 */
  | 'USER_DECLINED';

export interface AttestationPrompt {
  /** 阻塞点：调用方 `await` 它，拿到结果之前不许写入任何东西。 */
  readonly decision: Promise<AttestationDecision>;
  /** 提前拆除（拆除即 `declined`）。 */
  readonly dismiss: () => void;
  /**
   * 供扩展自身与测试操作。宿主页拿不到——内容脚本在隔离世界，
   * 且 shadow root 是 `closed`，宿主遍历 DOM 也取不到。
   */
  readonly root: ShadowRoot;
}

const HOST_ID = 'edaix-attestation-confirm-bar';

/**
 * 整批是否可渲染。**任一条不合法则整批不合法**——见头注「输入边界」。
 *
 * 返回不合法的理由（只用于本地开发诊断，**不含任何原文**）。
 */
function batchRejection(items: readonly AttestationItem[]): DeclineReason | null {
  if (!Array.isArray(items)) return 'NOT_AN_ARRAY';
  if (items.length === 0) return 'EMPTY_BATCH';
  const seen = new Set<string>();
  for (const item of items) {
    // 形状先于内容：items 将来由宿主 DOM 抽取器产生，是不可信输入。
    // Vivian 审查（2026-08-18）实测：传 `[null]` 时 `item.id?.trim()` 会
    // **同步抛 TypeError**——异常从 content-script 的安全边界逃逸出去，
    // 而不是整批 fail-closed。安全边界不该靠调用方守类型。
    if (typeof item !== 'object' || item === null) return 'MALFORMED_ITEM';
    if (typeof item.id !== 'string') return 'MALFORMED_ID';
    if (typeof item.declarationText !== 'string') return 'MALFORMED_TEXT';
    const id = item.id.trim();
    // ⚠️ 校验与返回必须用**同一个** key：原实现按 trim 后判唯一、
    // 却按原始串返回身份，`{id:'  a  '}` 返回 `'  a  '`（审查实测）。
    // 一个以「身份保真」为全部价值的模块不该有两套 key 空间。
    if (!id) return 'BLANK_ID';
    if (seen.has(id)) return 'DUPLICATE_ID';
    seen.add(id);
    if (!item.declarationText.trim()) return 'BLANK_DECLARATION_TEXT';
  }
  return null;
}

/** 模块级单实例；绝不按全局 id 查删——宿主页可能有同名节点。 */
let dismissCurrent: (() => void) | null = null;

function style(el: HTMLElement, decls: readonly string[]): void {
  el.setAttribute('style', decls.join(';'));
}

const PANEL = [
  'position:fixed',
  'right:16px',
  'bottom:16px',
  'width:min(420px, calc(100vw - 32px))',
  'z-index:2147483647',
  'background:#12121c',
  'color:#f2f2f7',
  'border-radius:10px',
  'box-shadow:0 8px 32px rgba(0,0,0,.45)',
  'font:13px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif',
  'display:flex',
  'flex-direction:column',
  'overflow:hidden',
];

const LIST = ['margin:0', 'padding:0', 'list-style:none', 'max-height:min(46vh, 340px)', 'overflow-y:auto'];

const ROW = [
  'display:flex',
  'gap:9px',
  'align-items:flex-start',
  'padding:10px 14px',
  'border-top:1px solid rgba(255,255,255,.08)',
];

const BTN_PRIMARY = [
  'flex:1',
  'background:#3d6ae0',
  'color:#fff',
  'border:0',
  'border-radius:7px',
  'padding:8px 12px',
  'cursor:pointer',
  'font:600 13px system-ui',
];

const BTN_GHOST = [
  'background:transparent',
  'color:#b8bcc8',
  'border:1px solid rgba(255,255,255,.18)',
  'border-radius:7px',
  'padding:8px 12px',
  'cursor:pointer',
  'font:13px system-ui',
];

/**
 * 弹出确认条并**阻塞**，直到用户做出选择。
 *
 * 默认每条都是勾上的——`PD-2026-08-18` §4.5.2 裁定乙档默认开，
 * 所以「预填 + 强制复核」的准确形态就是预先勾上、让用户看着原文取消他不要的。
 *
 * ⚠️ 已知的设计风险，留给 UI 评审（Vivian）判断：一份申请表可能有 9 项，
 * 全部预勾 + 一个「确认」按钮，很容易退化成橡皮图章。本实现的缓解是
 * 按钮上写实时条数、原文逐条完整展示、列表可滚动而不是折叠成摘要。
 * 这够不够，需要在真实申请表上看过再定。
 */
export function showAttestationConfirmBar(
  items: readonly AttestationItem[],
  doc: Document = document,
): AttestationPrompt {

  const host = doc.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'closed' });

  let settle: (d: AttestationDecision) => void = () => {};
  const decision = new Promise<AttestationDecision>((resolve) => {
    settle = resolve;
  });

  // fail-closed：只要还没被显式放行，任何收场都是 declined。
  let outcome: AttestationDecision = { kind: 'declined', reason: 'USER_DECLINED' };
  let done = false;

  /**
   * 只看**我们自己那个 host** 还在不在它的自有挂载点。
   *
   * Vivian 审查（2026-08-18）的 hostile lifecycle probe：宿主 ATS 的 SPA
   * 清理或 DOM sanitizer 直接 `host.remove()` 之后，确认条从屏幕上消失，
   * 但 `decision` **永远不 settle**——调用方按本模块的契约 `await` 它，
   * **整个 Application Run 永久卡住**，而用户连可操作的 UI 都没了。
   *
   * 这是本模块最坏的失败形态：不是写错东西，是**什么都不发生且没人知道**。
   * 阻塞式设计必须保证「一定会收口」，否则阻塞就变成了挂死。
   *
   * 只观察 `documentElement` 的直接子节点增删，不观察子树——
   * 我们只关心自己那一个节点，观察子树等于在宿主每次重渲染时都被吵醒。
   * 宿主把 host 搬到 `body` 或另一个 document 也算离开自有挂载点：
   * 即使节点仍 `isConnected`，我们也必须立即 fail-closed，不能丢掉后续生命周期追踪。
   */
  let hostWatch: MutationObserver | null = null;

  const dismiss = (): void => {
    if (done) return;
    done = true;
    hostWatch?.disconnect();
    hostWatch = null;
    host.remove();
    doc.defaultView?.removeEventListener('pagehide', dismiss);
    root.removeEventListener('keydown', onKey as EventListener);
    if (dismissCurrent === dismiss) dismissCurrent = null;
    settle(outcome);
  };

  /**
   * Esc 只在**我们自己的面板内**才算「用户拒绝」。
   *
   * 原实现挂在 `document` 上且 capture=true——审查实测（2026-08-19）：
   * 用户回到宿主表单按 Esc 关掉一个原生 select 下拉 / 日期选择器 /
   * 自动补全，我们**先于宿主任何 handler** 触发，直接 declined 并拆条。
   * 用户从未想拒绝，而且没有重新弹出的路径。
   * 对照：`auditPanel.ts` 刻意一个文档级监听都不挂。
   */
  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      outcome = { kind: 'declined', reason: 'USER_DECLINED' };
      dismiss();
    }
  }

  // ⚠️ **校验必须在 `dismissCurrent?.()` 之前。**
  //
  // 审查实测（2026-08-19）：原实现第一行就 `dismissCurrent?.()`，然后才校验。
  // 失败场景——确认条 A 正显示 3 条真实声明、用户在读；SPA 换步触发重扫，
  // 抽取器这次抽到空白原文（空批次 / 重复 id / 空白原文恰好是抽取器最常见的
  // 三种失败态）。于是 A 被从 DOM 摘掉、promise settle 成 declined，
  // 然后新的这批才发现自己非法。用户视角：确认条凭空消失。
  //
  // `auditPanel.ts` 的 `showAuditPanel` 同样是**先校验（空视图直接返回）后拆除**的
  // ——本文件当时把次序丢了。
  //
  // 整批校验，不合法就**连界面都不渲染，也不动正开着的那一条**。
  // 一条都没有：对一张没有声明的表弹确认条是误导。
  // 重复 id / 空白原文：见头注「输入边界」——两位审查各自的 hostile probe。
  const rejection = batchRejection(items);
  if (rejection) {
    done = true;
    // 铁律 2：可失败操作用稳定原因码。原因码不含任何原文，不违反铁律 1。
    settle({ kind: 'declined', reason: rejection });
    return { decision, dismiss: () => {}, root };
  }

  // 校验过了才拆旧条——顺序见上。
  dismissCurrent?.();

  const panel = doc.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-label', '待你放行的声明');
  style(panel, PANEL);

  const head = doc.createElement('div');
  style(head, ['padding:12px 14px 10px', 'display:flex', 'flex-direction:column', 'gap:2px']);
  const title = doc.createElement('strong');
  title.textContent = '这些声明要替你勾上，请逐条确认';
  style(title, ['font:600 13px system-ui']);
  const sub = doc.createElement('span');
  sub.textContent = '下面是页面上的原文，未经你确认不会勾选任何一条。';
  style(sub, ['color:#a4a9b8', 'font-size:12px']);
  head.append(title, sub);

  const list = doc.createElement('ul');
  style(list, LIST);

  const boxes = new Map<string, HTMLInputElement>();

  for (const item of items) {
    const row = doc.createElement('li');
    style(row, ROW);

    const box = doc.createElement('input');
    box.type = 'checkbox';
    box.checked = true; // 默认开（§4.5.2）：预填 + 强制复核
    box.id = `edaix-att-${boxes.size}`;
    style(box, ['margin:3px 0 0', 'flex:none', 'accent-color:#3d6ae0', 'cursor:pointer']);

    const label = doc.createElement('label');
    label.htmlFor = box.id;
    // ⚠️ 宿主页面来的文本，只能 textContent。任何路径都不许 innerHTML。
    label.textContent = item.declarationText;
    style(label, ['cursor:pointer', 'color:#e6e8ef', 'font-size:12.5px', 'line-height:1.55']);

    // 与 batchRejection 的唯一性判定同一个 key（trim 后），见那里的注释。
    boxes.set(item.id.trim(), box);
    row.append(box, label);
    list.append(row);
  }

  const foot = doc.createElement('div');
  style(foot, [
    'display:flex',
    'gap:8px',
    'padding:11px 14px',
    'border-top:1px solid rgba(255,255,255,.12)',
    'background:rgba(255,255,255,.03)',
  ]);

  const confirm = doc.createElement('button');
  confirm.type = 'button';
  style(confirm, BTN_PRIMARY);

  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.textContent = '不勾选';
  style(cancel, BTN_GHOST);

  const checkedIds = (): string[] =>
    [...boxes.entries()].filter(([, box]) => box.checked).map(([id]) => id);

  const syncConfirm = (): void => {
    const n = checkedIds().length;
    confirm.textContent = n === 0 ? '未选任何一条' : `勾选这 ${n} 条`;
    confirm.disabled = n === 0;
    style(confirm, n === 0 ? [...BTN_PRIMARY, 'background:#2a2f42', 'color:#7b8093', 'cursor:default'] : BTN_PRIMARY);
  };
  for (const box of boxes.values()) box.addEventListener('change', syncConfirm);
  syncConfirm();

  confirm.addEventListener('click', () => {
    const releasedIds = checkedIds();
    if (releasedIds.length === 0) return; // 兜底：按钮理应已 disabled
    outcome = { kind: 'released', releasedIds };
    dismiss();
  });

  cancel.addEventListener('click', () => {
    outcome = { kind: 'declined', reason: 'USER_DECLINED' };
    dismiss();
  });

  const optOut = doc.createElement('button');
  optOut.type = 'button';
  optOut.textContent = '不再自动处理这类声明';
  style(optOut, [
    'background:none',
    'border:0',
    'color:#8d93a6',
    'font:12px system-ui',
    'text-decoration:underline',
    'cursor:pointer',
    'padding:0 14px 11px',
    'text-align:left',
  ]);
  optOut.addEventListener('click', () => {
    // 本次也不写——关档是「以后别做」，不是「这次照做」。
    outcome = { kind: 'tier-disabled' };
    dismiss();
  });

  foot.append(confirm, cancel);
  panel.append(head, list, foot, optOut);
  root.append(panel);
  doc.documentElement.append(host);

  // ⚠️ `doc.defaultView` 为 null = 文档已脱离（嵌入式申请表的 iframe 在填表
  // 过程中被移除，Greenhouse / Workday 都是这种形态）。此时 pagehide 装不上、
  // MutationObserver 也拿不到——**模块唯一的自动收口通道全没了**。
  //
  // 原实现用 `?.` 静默吞掉这件事，结果是 promise 永不 settle：方向上是
  // fail-closed，但它是**卡死**不是 declined，调用方 await 就永久挂起
  // （审查实测，2026-08-19）。这里显式收口。
  const view = doc.defaultView;
  if (!view) {
    outcome = { kind: 'declined', reason: 'DETACHED_DOCUMENT' };
    dismiss();
    return { decision, dismiss, root };
  }

  view.addEventListener('pagehide', dismiss);
  // 只在自己的面板内听 Esc（见 onKey 头注）。shadow root 承载事件，宿主收不到。
  root.addEventListener('keydown', onKey as EventListener);

  // 宿主把我们的节点摘掉或搬离自有挂载点 → 立即 declined 收口。
  // 被别人移动不等于用户放行；不跟随新 parent，也不扩大到宿主子树观察。
  const Observer = (doc.defaultView as { MutationObserver?: typeof MutationObserver } | null)
    ?.MutationObserver;
  if (Observer) {
    hostWatch = new Observer(() => {
      if (!done && host.parentNode !== doc.documentElement) {
        outcome = { kind: 'declined', reason: 'HOST_REMOVED' };
        dismiss();
      }
    });
    hostWatch.observe(doc.documentElement, { childList: true });
  }

  dismissCurrent = dismiss;

  // ⚠️ **绝不 focus 主按钮。**
  //
  // 审查实测（2026-08-19）：确认条弹出的时机正是用户在这张申请表上打字/浏览
  // 的时候。焦点一旦落在主按钮上，用户按下的**下一个空格或回车**
  // （打字，或最常见的「按空格往下滚页面看表单」）会按 HTML 规范激活它。
  // 而所有条目默认预勾——于是 `{kind:'released', releasedIds:[全部]}`，
  // **用户一条原文都没读就完成了法律声明放行**。
  // 这恰好把本模块存在的理由反转过来。
  //
  // 改为 focus 面板容器本身（`tabindex="-1"`，不可点击激活），
  // 这样键盘用户仍能 Tab 进来，而空格/回车不会误触发任何动作。
  panel.tabIndex = -1;
  panel.focus?.();

  return { decision, dismiss, root };
}
