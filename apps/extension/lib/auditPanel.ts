/**
 * 逐字段审计面板（CAP-AF-063 的渲染层）。
 *
 * `confirmBar` 那一行「已填 2/3 · 请核对后自行提交」是这个面板的前身：它只有
 * 一个计数，用户看不出**哪一栏**已填、哪一栏还等着他、我们到底往里写了什么。
 * 「可审计」是这个产品对着竞品立的差异化，而在用户按下提交前的最后一刻，
 * 屏幕上恰恰是空的。
 *
 * ## 为什么是浮层里的一列行，而不是给输入框上色
 *
 * 铁律 3（RULE-EXTENSION-NEVER-SUBMIT）：对宿主页面只可写表单控件的
 * value/selectedIndex/checked/files，**不得增删节点或改样式**。所以绿/黄标记
 * 画不到宿主输入框上——唯一的出口是我方 closed shadow 里的一份**表单镜像
 * 列表**，外加一个把宿主字段滚进视野的 [定位]。这不是设计偏好，是铁律逼出来的
 * 唯一形态（CAP-AF-063 记录原文如此）。
 *
 * ## 纪律
 *
 *  · 只新增我们自己的一个悬浮容器（closed shadow），宿主 DOM 一个节点都不动；
 *  · closed shadow 的引用只经**返回值**交给调用方，绝不挂在宿主可读的属性上；
 *  · 撤销走授权链：把用户在我方浮层里的**真实点击**与 shadowRoot 原样交出去，
 *    由 grant.ts 的 mintAuthority 验（isTrusted + eventComesFromShadow）；
 *  · 单实例；pagehide 自拆。
 *
 * Data-L1：面板显示宿主标签与我们写入的值——那是**本地 UI 边界之内**，与
 * `ApplyDiagnostic` 的导出面是两回事（见 contracts.ts 该接口头注）。这份视图
 * 绝不经桥、不进回执、不进遥测。
 */

import type { AuditRow, AuditStatus, AuditView } from '@edaix/apply-kernel/audit';
import {
  createFinalReviewControl,
  createUndoControl,
  renderDiagnostics,
  type AuditControlHandlers,
  type TelemetryControlStatus,
} from './auditControls';
import { renderQuestionReview, type QuestionReviewHandlers } from './questionReviewPanel';

export type { TelemetryControlStatus } from './auditControls';

export interface AuditPanelHandlers extends AuditControlHandlers {
  /** Removing the only review surface retires its exact generation fail closed. */
  readonly onDismiss?: () => void;
  /** 档案计划跳过的题：开关、候选、逐题确认与回填（questionReviewPanel.ts）。 */
  readonly questions?: QuestionReviewHandlers;
}

export interface AuditPanelHandle {
  readonly dismiss: () => void;
  /**
   * 换一份视图重绘计数与逐行状态。
   *
   * 整轮之后的复核（`KernelFillAudit.recheck`）可能把某几行从「已填」改判成
   * `LATE_REVERTED`——宿主在我们那 250 毫秒窗口关掉之后才把值清空（Lever 的简历
   * 解析实测约十二秒）。面板不跟着换，那句「已填」就一直挂在屏幕上。
   *
   * 只换头部计数与行；题目审阅、诊断与最终复核控件保持原样，用户在那上面的
   * 输入不该因为另一行被改判而丢掉。
   */
  readonly update: (view: AuditView) => void;
  /** 调用方要用它铸还原票据（eventComesFromShadow）。 */
  readonly shadowRoot: ShadowRoot | null;
}

const HOST_ID = 'edaix-run-audit-panel';

/** 模块级单实例；绝不按全局 id 查删——宿主可能有同名节点。 */
let dismissCurrent: (() => void) | null = null;

const NOOP: AuditPanelHandle = { dismiss: () => {}, update: () => {}, shadowRoot: null };

/**
 * 每一档的显示形态。
 *
 * 文案说的是**用户的下一步**，不是内部状态名：「等你填」比「NEEDS_MANUAL」
 * 有用得多，而「没读回确认」必须与「已填」长得不一样——否则"点了但没生效"
 * 和"确认填入"在屏幕上一模一样，用户就不会去核对那一栏。
 */
const PRESENTATION: Readonly<Record<AuditStatus, { mark: string; text: string; tone: string }>> = {
  FILLED: { mark: '✓', text: '已填', tone: '#2f9e5f' },
  FILLED_UNVERIFIED: { mark: '?', text: '已填，未能确认', tone: '#c99a2e' },
  REJECTED: { mark: '!', text: '页面判为无效', tone: '#d9534f' },
  FAILED: { mark: '×', text: '没能写入', tone: '#d9534f' },
  NEEDS_MANUAL: { mark: '·', text: '等你填', tone: '#7a7a92' },
  // 「等你放行」而不是「等你填」：答案我们已经挑好了，用户要做的是确认，
  // 不是从头想一个。说成「等你填」会让他以为我们什么都没做。
  NEEDS_CONFIRMATION: { mark: '·', text: '已备好，等你放行', tone: '#7a7a92' },
  MISSING_PROFILE: { mark: '·', text: '档案里没有', tone: '#7a7a92' },
  LOW_CONFIDENCE: { mark: '?', text: '没把握，没敢填', tone: '#c99a2e' },
  PREFILLED: { mark: '–', text: '页面本来就有', tone: '#7a7a92' },
};

const CSS = `
:host { all: initial; }
.panel {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  width: 320px; max-height: min(60vh, 520px); display: flex; flex-direction: column;
  background: #1a1a2e; color: #fff; border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0,0,0,.35);
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.head { display: flex; align-items: baseline; gap: 8px; padding: 12px 14px 8px; }
.count { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.note { color: #b9b9cc; font-size: 12px; }
.rows { overflow-y: auto; padding: 0 6px 6px; }
.row { display: flex; align-items: baseline; gap: 8px; padding: 6px 8px; border-radius: 6px; }
.row + .row { border-top: 1px solid rgba(255,255,255,.06); }
.mark { flex: none; width: 1em; text-align: center; font-weight: 700; }
.body { flex: 1; min-width: 0; }
.label { display: block; overflow-wrap: anywhere; }
.req { color: #d9534f; }
.detail { color: #b9b9cc; font-size: 12px; overflow-wrap: anywhere; }
.value { color: #e8e8f2; }
button {
  flex: none; background: #33334d; color: #fff; border: 0; border-radius: 6px;
  padding: 3px 8px; cursor: pointer; font: 12px system-ui, sans-serif;
}
button:hover { background: #45456a; }
button:focus-visible { outline: 2px solid #8ab4ff; outline-offset: 1px; }
.foot { display: flex; gap: 8px; padding: 8px 14px 12px; }
.foot button { flex: 1; }
.diagnostics { display: flex; flex-wrap: wrap; gap: 7px; padding: 8px 14px; border-top: 1px solid rgba(255,255,255,.08); }
.diagnostics-note, .diagnostics-status { flex-basis: 100%; color: #b9b9cc; font-size: 11px; }
.diagnostics-status { color: #f2d58b; }
.diagnostics label { display: flex; align-items: center; gap: 5px; font-size: 11px; }
.questions { display: flex; flex-direction: column; gap: 6px; padding: 8px 14px; border-top: 1px solid rgba(255,255,255,.08); max-height: 40vh; overflow-y: auto; }
.questions-head { font-weight: 600; }
.questions label { display: flex; align-items: center; gap: 5px; font-size: 12px; }
.questions-note, .questions-status { color: #b9b9cc; font-size: 11px; }
.questions-status { color: #f2d58b; }
.questions-list { display: flex; flex-direction: column; gap: 8px; }
.question { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border-radius: 6px; background: rgba(255,255,255,.05); }
.question input, .question textarea, .question select { width: 100%; box-sizing: border-box; background: #0f0f1e; color: #fff; border: 1px solid #45456a; border-radius: 4px; padding: 4px 6px; font: 12px system-ui, sans-serif; }
.question textarea { min-height: 56px; resize: vertical; }
.review { padding: 0 14px 8px; }
.review button { width: 100%; padding: 7px 8px; }
.review button:disabled { cursor: default; background: #28533d; color: #e7fff0; }
`;

function renderRow(doc: Document, item: AuditRow): HTMLElement {
  const look = PRESENTATION[item.status];

  const line = doc.createElement('div');
  line.className = 'row';

  const mark = doc.createElement('span');
  mark.className = 'mark';
  mark.style.color = look.tone;
  mark.textContent = look.mark;
  // 形状不能只靠颜色承载：色觉差异之外，这条 UI 还常常压在深浅不一的宿主页面上。
  mark.setAttribute('aria-hidden', 'true');

  const body = doc.createElement('div');
  body.className = 'body';

  const label = doc.createElement('span');
  label.className = 'label';
  label.textContent = item.label;
  if (item.required) {
    const star = doc.createElement('span');
    star.className = 'req';
    star.textContent = ' *';
    label.append(star);
  }

  const detail = doc.createElement('span');
  detail.className = 'detail';
  detail.textContent = look.text;
  // 「我们到底往这一栏写了什么」——审计面板存在的理由。select 显示的是计划期
  // 判决出的将选中项文字（CAP-AF-044），那才是用户在页面上会看到的东西。
  const written = item.resolvedOptionText ?? item.attemptedValue;
  if (written && (item.status === 'FILLED' || item.status === 'FILLED_UNVERIFIED')) {
    const value = doc.createElement('span');
    value.className = 'value';
    value.textContent = ` ${written}`;
    detail.append(value);
  }

  body.append(label, detail);

  const locate = doc.createElement('button');
  locate.type = 'button';
  locate.dataset.locate = String(item.order);
  locate.textContent = '定位';
  locate.setAttribute('aria-label', `在页面上定位「${item.label}」`);
  locate.addEventListener('click', () => {
    // 只滚动，不聚焦、不上样式：focus 会触发宿主的校验/联动，那是"改宿主行为"。
    item.element.scrollIntoView({ block: 'center' });
  });

  line.append(mark, body, locate);
  return line;
}

/**
 * 渲染一轮的审计结果。返回拆除句柄与我方 shadowRoot（还原票据要用）。
 *
 * 一行都没有时不渲染：空面板对用户是纯噪音，而"这一轮什么都没扫到"该由
 * chat 侧说明，不该由一个空浮层暗示。
 */
export function showAuditPanel(
  view: AuditView,
  handlers: AuditPanelHandlers = {},
  doc: Document = document,
): AuditPanelHandle {
  if (view.rows.length === 0) return NOOP;

  dismissCurrent?.();

  const host = doc.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = doc.createElement('style');
  style.textContent = CSS;

  const panel = doc.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', '本次自动填写的逐字段结果');

  const head = doc.createElement('div');
  head.className = 'head';
  const count = doc.createElement('span');
  count.className = 'count';
  const note = doc.createElement('span');
  note.className = 'note';
  head.append(count, note);

  const rows = doc.createElement('div');
  rows.className = 'rows';

  // 一份视图画一次头部与行。`update` 再调一次同一个闭包，两条路绝不会画得不一样。
  const paintView = (next: AuditView): void => {
    // 分母比计数重要：用户要的是"还差多少才能提交"，不是"我们干了几件事"。
    count.textContent =
      next.requiredTotal > 0
        ? `必填 ${next.requiredHandled}/${next.requiredTotal}`
        : `已填 ${next.filled}/${next.rows.length}`;
    // 「我们没做好」和「只能你本人做」要分开说。前者是我们的活没干完，后者永远
    // 存在（工作授权、EEO、I certify 在真实 ATS 表上几乎必现）——混成一句
    // 「N 项等你处理」，用户会把我们的缺陷也当成他自己的待办。
    const parts: string[] = [];
    if (next.awaitingUser > 0) parts.push(`${next.awaitingUser} 项只能你本人填`);
    if (next.blockedByUs > 0) parts.push(`${next.blockedByUs} 项我们没填成`);
    note.textContent = parts.length > 0 ? parts.join(' · ') : '请核对后自行提交';
    rows.replaceChildren(...next.rows.map((item) => renderRow(doc, item)));
  };
  paintView(view);

  const questions = handlers.questions && handlers.questions.questions.length > 0 ? renderQuestionReview(doc, shadow, handlers.questions) : null;
  const diagnostics = renderDiagnostics(doc, handlers);

  const review = createFinalReviewControl(doc, shadow, handlers);

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    handlers.onDismiss?.();
    review?.dispose();
    host.remove();
    doc.defaultView?.removeEventListener('pagehide', dismiss);
    if (dismissCurrent === dismiss) dismissCurrent = null;
  };

  const foot = doc.createElement('div');
  foot.className = 'foot';
  const undo = createUndoControl(doc, shadow, handlers);
  if (undo !== null) foot.append(undo);
  const close = doc.createElement('button');
  close.type = 'button';
  close.textContent = '知道了';
  close.addEventListener('click', dismiss);
  foot.append(close);

  panel.append(head, rows);
  if (questions) panel.append(questions);
  if (diagnostics) panel.append(diagnostics);
  if (review !== null) panel.append(review.element);
  panel.append(foot);
  shadow.append(style, panel);
  doc.defaultView?.addEventListener('pagehide', dismiss);
  doc.documentElement.append(host);
  dismissCurrent = dismiss;

  return {
    dismiss,
    // 拆掉之后再来的复核不该把节点画回去。
    update: (next) => { if (!dismissed) paintView(next); },
    shadowRoot: shadow,
  };
}
