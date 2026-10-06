/**
 * 内容脚本 → worker：这一页上出了一件我们自己的错，记一个稳定原因码（2026-10-03 前端体检 3a-2）。
 *
 * 从前内容脚本这一侧的失败只给用户看，后台一个码都收不到：一轮填写半路抛了，进度卡一直转，线上什么都看不见。worker 把收到的
 * 码记进诊断环（随同一批码送 /telemetry/client-errors）。只有闭集里的码，不带任何值、页面、错误消息（RULE-GLOBAL-DATA-L1）；
 * 这条消息不授予任何东西。
 *
 * 2026-10-04（体检 11-2 与「吞掉的错」）扩了两类：
 *  · 入口处接住的异常（一轮填写、收尾、报到与换脸、内容脚本的监听、浮层的按钮、资料保存）：另带一个**闭集里的类名**
 *    （`errorClassOf`：TypeError、NotAllowedError……，认不出的是 OtherError、抛的不是错误对象是 NonError），worker 以
 *    `uncaught_error` / `unhandled_rejection` 上报，码是 `<码>:<类名>`。message 与 stack 从不出内容脚本。
 *  · 从前吞掉、会把失败藏起来的几处（站点知识取不到、「刚按了提交」没送到 worker、「打开申请表」没打开……）：只有码。
 *
 * 每个码自己说它从哪来（`apply` 是内容脚本，`dock` 是浮层）、是哪一种——消息里不另带，worker 照表上报。
 */
const DOCK_DIAGNOSTICS = {
  /** 一页的手势填写半路抛了：浮层照「这一轮没有完成」（RUN_FAILED）收尾。 */
  GESTURE_RUN_THREW: { surface: 'apply', kind: 'unhandled_rejection' },
  /** 一页填完之后的收尾（画 AI 的结局、连填往不往下翻）抛了：浮层已经照常收尾。 */
  GESTURE_RUN_CLOSE_THREW: { surface: 'apply', kind: 'unhandled_rejection' },
  /** 内容脚本起来的那一段抛了：这一页上浮层多半挂不出来。 */
  APPLY_MAIN_THREW: { surface: 'apply', kind: 'uncaught_error' },
  /** 报到之后换脸（挂浮层）抛了：浮层没换成，从前被当成「worker 没醒」吞掉。 */
  APPLY_HELLO_THREW: { surface: 'apply', kind: 'unhandled_rejection' },
  /** 内容脚本的消息、页面事件监听或定时器抛了。 */
  APPLY_LISTENER_THREW: { surface: 'apply', kind: 'uncaught_error' },
  /** 记一轮结局的那一层自己出了错（填写照常）。 */
  RUN_OUTCOME_THREW: { surface: 'apply', kind: 'uncaught_error' },
  /** 浮层里一颗按钮的处理抛了：按了没反应。 */
  DOCK_HANDLER_THREW: { surface: 'dock', kind: 'uncaught_error' },
  /** 浮层里一颗按钮交出的 promise 被拒、没人接。 */
  DOCK_HANDLER_REJECTED: { surface: 'dock', kind: 'unhandled_rejection' },
  /** 「我的资料」保存抛了：从前「保存」从此按不了、也离不开资料页。 */
  PROFILE_SAVE_THREW: { surface: 'dock', kind: 'unhandled_rejection' },
  /** 站点知识第一次没取到，又取了一次。 */
  SITE_KNOWLEDGE_RETRIED: { surface: 'apply', kind: 'diagnostic' },
  /** 站点知识两次都没取到：白标与公司自建的表这一次加载认不出，浮层不挂。 */
  SITE_KNOWLEDGE_UNAVAILABLE: { surface: 'apply', kind: 'diagnostic' },
  /** 「这一页刚按了提交」没送到 worker：整页跳走后下一页不说「提交成功」，任务也不报「已提交」。 */
  SUBMIT_PRESSED_UNSENT: { surface: 'apply', kind: 'diagnostic' },
  /** 「这一页的提交有了结论」没送到 worker：切回来时可能再播一次动画。 */
  SUBMIT_SETTLED_UNSENT: { surface: 'apply', kind: 'diagnostic' },
  /** 「打开申请表」没打开。 */
  OPEN_APPLICATION_FORM_FAILED: { surface: 'apply', kind: 'diagnostic' },
  /** 网站清空了我们填好的栏，重填那一次没成。 */
  LATE_REPAIR_FAILED: { surface: 'apply', kind: 'diagnostic' },
  /** 「技术细节」的复制没成。 */
  DOCK_COPY_FAILED: { surface: 'dock', kind: 'diagnostic' },
  /** 账户菜单里的开关（AI 代答、记住回答）读不到：显示的是缺省的「开」，worker 照真实设置办。 */
  DOCK_SWITCH_LOAD_FAILED: { surface: 'dock', kind: 'diagnostic' },
} as const satisfies Record<string, Readonly<{ surface: 'apply' | 'dock'; kind: 'diagnostic' | 'uncaught_error' | 'unhandled_rejection' }>>;

export type DockDiagnosticCode = keyof typeof DOCK_DIAGNOSTICS;
export const DOCK_DIAGNOSTIC_CODES = /* @__PURE__ */ Object.keys(DOCK_DIAGNOSTICS) as readonly DockDiagnosticCode[];
type DockDiagnosticKind = (typeof DOCK_DIAGNOSTICS)[DockDiagnosticCode]['kind'];
/** 入口处接住的异常那几种（带类名）。 */
export type DockErrorCode = { [K in DockDiagnosticCode]: (typeof DOCK_DIAGNOSTICS)[K]['kind'] extends 'diagnostic' ? never : K }[DockDiagnosticCode];
/** 只有码的那几种。 */
export type DockPlainCode = Exclude<DockDiagnosticCode, DockErrorCode>;

/** 闭集里的错误类名：内置的错误与常见的 DOMException；认不出的是 OtherError，抛的不是错误对象是 NonError。 */
export const ERROR_CLASSES = [
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError',
  'AbortError', 'NotAllowedError', 'NotFoundError', 'NotSupportedError', 'InvalidStateError', 'InvalidCharacterError',
  'SecurityError', 'QuotaExceededError', 'NetworkError', 'DataCloneError', 'TimeoutError', 'HierarchyRequestError',
  'InvalidAccessError', 'OperationError', 'UnknownError', 'NonError', 'OtherError',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** 只取类名，而且只认闭集里的：页面或别人起的类名（可能带着站点的名字）一律 OtherError。 */
export function errorClassOf(error: unknown): ErrorClass {
  if (typeof error !== 'object' || error === null) return 'NonError';
  let name: unknown;
  try {
    name = (error as { name?: unknown }).name;
  } catch {
    return 'OtherError';
  }
  return typeof name === 'string' && name !== 'NonError' && name !== 'OtherError' && (ERROR_CLASSES as readonly string[]).includes(name)
    ? name as ErrorClass
    : 'OtherError';
}

export interface DockDiagnostic {
  readonly kind: 'dock/diagnostic';
  readonly code: DockDiagnosticCode;
  readonly errorClass?: ErrorClass;
}

/**
 * 只有码的那几种。两个造消息的函数都不读上面那张表：表只在 worker 里解析时用，内容脚本的产物里没有它（Assistant 产物的预算）。
 */
export function createDockDiagnostic(code: DockPlainCode): DockDiagnostic {
  return Object.freeze({ kind: 'dock/diagnostic', code });
}

/** 入口处接住的异常：只带 `error` 闭集里的类名。 */
export function createDockErrorDiagnostic(code: DockErrorCode, error: unknown): DockDiagnostic {
  return Object.freeze({ kind: 'dock/diagnostic', code, errorClass: errorClassOf(error) });
}

export interface ParsedDockDiagnostic {
  readonly code: DockDiagnosticCode;
  readonly surface: 'apply' | 'dock';
  readonly kind: DockDiagnosticKind;
  readonly errorClass?: ErrorClass;
}

/** 只认闭集里的码、恰好那几个键：异常那几种必须带闭集里的类名，别的不许带。 */
export function parseDockDiagnostic(value: unknown): ParsedDockDiagnostic | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { kind, code, errorClass } = value as Record<string, unknown>;
  if (kind !== 'dock/diagnostic' || typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(DOCK_DIAGNOSTICS, code)) return null;
  const entry = DOCK_DIAGNOSTICS[code as DockDiagnosticCode];
  const keys = Object.keys(value).length;
  if (entry.kind === 'diagnostic') {
    return keys === 2 ? Object.freeze({ code: code as DockDiagnosticCode, surface: entry.surface, kind: entry.kind }) : null;
  }
  if (keys !== 3 || typeof errorClass !== 'string' || !(ERROR_CLASSES as readonly string[]).includes(errorClass)) return null;
  return Object.freeze({ code: code as DockDiagnosticCode, surface: entry.surface, kind: entry.kind, errorClass: errorClass as ErrorClass });
}
