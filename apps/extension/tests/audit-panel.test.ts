// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { showAuditPanel } from '../lib/auditPanel';
import type { AuditRow, AuditView } from '@edaix/apply-kernel/audit';

/**
 * 逐字段审计面板（CAP-AF-063 的渲染层）。
 *
 * 铁律 3 不许给宿主节点上样式，所以绿/黄标记画不到输入框上——能给用户的只剩
 * 我方 Shadow 浮层里的一列行。这个文件锁的是那列行的**纪律**，不是它的长相：
 *
 *  · 只新增我们自己的一个容器，宿主 DOM 一个节点都不动（与 confirmBar 同姿势）；
 *  · [locate] 必须真的滚到对应宿主字段——面板是表单的镜像，跳错栏比不跳更糟；
 *  · 撤销按钮只在真的能撤销时出现，且必须由**用户在我方浮层里的真实点击**触发
 *    （授权链的信任根，见 grant.ts mintAuthority）；
 *  · 单实例、pagehide 自拆——一个页面上不该同时挂着两轮的审计结果。
 */

afterEach(() => {
  document.documentElement.querySelectorAll('#edaix-run-audit-panel').forEach((node) => node.remove());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function row(overrides: Partial<AuditRow> & { label: string; element: Element }): AuditRow {
  return {
    key: null,
    required: false,
    status: 'FILLED',
    reason: null,
    attemptedValue: null,
    resolvedOptionText: null,
    confidence: null,
    order: 0,
    ...overrides,
  };
}

function mountFields(count: number): HTMLInputElement[] {
  document.body.innerHTML = `<form>${Array.from(
    { length: count },
    (_, index) => `<input id="f${index}" type="text" />`,
  ).join('')}</form>`;
  return Array.from({ length: count }, (_, index) =>
    document.querySelector<HTMLInputElement>(`#f${index}`)!,
  );
}

function view(rows: AuditRow[], extra: Partial<AuditView> = {}): AuditView {
  return {
    rows,
    filled: rows.filter((item) => item.status === 'FILLED').length,
    requiredTotal: rows.filter((item) => item.required).length,
    requiredHandled: rows.filter(
      (item) => item.required && (item.status === 'FILLED' || item.status === 'PREFILLED'),
    ).length,
    needsAttention: rows.filter((item) => item.status === 'NEEDS_MANUAL').length,
    blockedByUs: 0,
    awaitingUser: rows.filter((item) => item.status === 'NEEDS_MANUAL').length,
    ...extra,
  };
}

/**
 * closed shadow 的引用只经**返回值**交给调用方。绝不挂在宿主可读的属性上——
 * 那等于把 closed 白关一场。
 */
function textOf(handle: ReturnType<typeof showAuditPanel>): string {
  return handle.shadowRoot?.textContent ?? '';
}

describe('宿主 DOM 纪律', () => {
  it('只新增我们自己的一个容器，宿主节点一个都不动', () => {
    const [field] = mountFields(1);
    const form = document.querySelector('form')!;
    const before = form.innerHTML;
    const beforeAttrs = field.getAttributeNames().sort().join(',');

    const handle = showAuditPanel(view([row({ label: 'First Name', element: field })]));

    expect(form.innerHTML, '面板往宿主表单里塞了节点（铁律 3）').toBe(before);
    expect(field.getAttributeNames().sort().join(','), '面板给宿主字段加了属性/样式').toBe(
      beforeAttrs,
    );
    expect(document.documentElement.querySelectorAll('#edaix-run-audit-panel')).toHaveLength(1);

    // 渲染那一刻干净不算数：交互也不许碰宿主。[定位] 最容易顺手写成
    // "滚过去顺便描个边"——那正是铁律 3 明文禁止的改样式。
    field.scrollIntoView = () => {};
    handle.shadowRoot!.querySelector<HTMLButtonElement>('[data-locate]')!.click();
    expect(form.innerHTML, '[定位] 顺手改了宿主 DOM').toBe(before);
    expect(field.getAttributeNames().sort().join(','), '[定位] 给宿主字段上了样式/属性').toBe(
      beforeAttrs,
    );
    expect(field.getAttribute('style') ?? '', '[定位] 往宿主字段写了 style').toBe('');
  });

  it('内容住在 closed shadow 里，宿主页面观察不到', () => {
    const [field] = mountFields(1);
    const handle = showAuditPanel(view([row({ label: 'First Name', element: field })]));
    const host = document.documentElement.querySelector('#edaix-run-audit-panel')!;
    expect(host.shadowRoot, 'shadow 不是 closed——宿主页面能读到我们的面板内容').toBeNull();
    expect(handle.shadowRoot, '调用方拿不到自己的 shadow，面板无法交给授权链').not.toBeNull();
  });
});

describe('行的呈现', () => {
  it('每一行都显示出来，标签逐条可见', () => {
    const fields = mountFields(3);
    const handle = showAuditPanel(
      view([
        row({ label: 'First Name', element: fields[0], order: 0 }),
        row({ label: 'Desired salary', element: fields[1], order: 1, status: 'NEEDS_MANUAL' }),
        row({ label: 'Last Name', element: fields[2], order: 2 }),
      ]),
    );
    const text = textOf(handle);
    for (const label of ['First Name', 'Desired salary', 'Last Name']) {
      expect(text, `「${label}」这一行没出现在面板上`).toContain(label);
    }
  });

  it('「我们没填成」与「只能你本人填」分开显示，不混成一句', () => {
    const fields = mountFields(2);
    const handle = showAuditPanel(
      view(
        [
          row({ label: 'A', element: fields[0], status: 'NEEDS_MANUAL' }),
          row({ label: 'B', element: fields[1], status: 'FAILED' }),
        ],
        { needsAttention: 2, blockedByUs: 1, awaitingUser: 1 },
      ),
    );
    const text = textOf(handle);
    expect(text, '只能用户本人填的那一项没单独说').toContain('1 项只能你本人填');
    expect(
      text,
      '我们没填成的被并进了「等你处理」——用户会把我们的缺陷当成他自己的待办',
    ).toContain('1 项我们没填成');
  });

  it('必填分母显示的是 requiredHandled/requiredTotal，不是裸计数', () => {
    const fields = mountFields(2);
    const handle = showAuditPanel(
      view([
        row({ label: 'A', element: fields[0], required: true, status: 'FILLED' }),
        row({ label: 'B', element: fields[1], required: true, status: 'NEEDS_MANUAL' }),
      ]),
    );
    expect(textOf(handle), '面板上没有"还差多少才能提交"的分母').toContain('1/2');
  });
});

describe('[locate]', () => {
  it('点 locate 把对应宿主字段滚进视野', () => {
    const fields = mountFields(2);
    const scrolls: Element[] = [];
    for (const field of fields) {
      field.scrollIntoView = vi.fn(function scrollIntoView(this: Element) {
        scrolls.push(this);
      }) as unknown as Element['scrollIntoView'];
    }

    const handle = showAuditPanel(
      view([
        row({ label: 'A', element: fields[0], order: 0 }),
        row({ label: 'B', element: fields[1], order: 1, status: 'NEEDS_MANUAL' }),
      ]),
    );

    const shadow = handle.shadowRoot!;
    const buttons = [...shadow.querySelectorAll<HTMLButtonElement>('[data-locate]')];
    expect(buttons, '行上没有 locate 入口——用户被告知"这一栏要你自己填"却找不到它在哪').toHaveLength(2);

    buttons[1].click();
    expect(scrolls, 'locate 跳错了栏——面板是表单的镜像，跳错比不跳更糟').toEqual([fields[1]]);
  });
});

describe('撤销入口', () => {
  it('能撤销时出现按钮，点击把真实点击事件与我方 shadowRoot 交给授权链', () => {
    const [field] = mountFields(1);
    const undoAll = vi.fn();
    const handle = showAuditPanel(view([row({ label: 'A', element: field })]), {
      canUndo: () => true,
      undoAll,
    });
    const shadow = handle.shadowRoot!;
    const undo = shadow.querySelector<HTMLButtonElement>('[data-undo]');
    expect(undo, '写入可撤销是铁律 3 的承诺，跑完一轮却没有撤销按钮').not.toBeNull();

    undo!.click();
    expect(undoAll).toHaveBeenCalledTimes(1);
    const [event, shadowRoot] = undoAll.mock.calls[0];
    expect(event, '没把点击事件交给授权链——mintAuthority 验的就是这一下').toBeInstanceOf(
      document.defaultView!.Event,
    );
    expect(shadowRoot, '没把我方 shadowRoot 交给授权链（eventComesFromShadow 要用）').toBe(shadow);
  });

  it('撤不了的时候不摆按钮——点了没反应比没有按钮更伤', () => {
    const [field] = mountFields(1);
    const handle = showAuditPanel(view([row({ label: 'A', element: field })]), {
      canUndo: () => false,
      undoAll: vi.fn(),
    });
    expect(handle.shadowRoot!.querySelector('[data-undo]')).toBeNull();
  });
});

describe('最终复核确认', () => {
  it('只在当前门禁可确认时出现，并原样传递点击事件与 closed shadow', async () => {
    const [field] = mountFields(1);
    const confirmFinalReview = vi.fn((_event: Event, _shadowRoot: ShadowRoot) => true);
    const handle = showAuditPanel(view([row({ label: 'A', element: field })]), {
      canConfirmFinalReview: () => true,
      confirmFinalReview,
    });
    const shadow = handle.shadowRoot!;
    const review = shadow.querySelector<HTMLButtonElement>('[data-final-review]');

    expect(review).not.toBeNull();
    expect(review!.textContent).toBe('我已逐项复核');
    review!.click();

    await vi.waitFor(() => expect(confirmFinalReview).toHaveBeenCalledTimes(1));
    const [event, shadowRoot] = confirmFinalReview.mock.calls[0]!;
    expect(event).toBeInstanceOf(document.defaultView!.Event);
    expect(shadowRoot).toBe(shadow);
    await vi.waitFor(() => {
      expect(review!.disabled).toBe(true);
      expect(review!.textContent).toBe('已复核；请第一次点击原网站 Submit（1/2：建立安全边界）');
    });
  });

  it('把两次原生点击的边界进度实时显示在同一个复核入口', async () => {
    const [field] = mountFields(1);
    let notifyState: ((state: 'ARMED' | 'BOUNDARY_PENDING' | 'WAIT_FOR_USER_RETRY' | 'WAIT_FOR_FINAL_RETRY' | 'OUTCOME_UNKNOWN' | 'TRIGGERED_LOCKED' | 'BLOCKED') => void) | undefined;
    const handle = showAuditPanel(view([row({ label: 'A', element: field })]), {
      canConfirmFinalReview: () => true,
      confirmFinalReview: async () => true,
      subscribeSubmissionState: (listener) => {
        notifyState = listener;
        return vi.fn();
      },
    });
    const review = handle.shadowRoot!.querySelector<HTMLButtonElement>('[data-final-review]')!;
    review.click();
    await vi.waitFor(() => expect(review.textContent).toContain('1/2'));

    notifyState?.('BOUNDARY_PENDING');
    expect(review.textContent).toBe('已拦住第 1 次点击；正在建立安全边界…');
    notifyState?.('WAIT_FOR_FINAL_RETRY');
    expect(review.textContent).toBe('安全边界已建立；请再次点击原网站 Submit（2/2：本次会到达原网站）');
    notifyState?.('OUTCOME_UNKNOWN');
    expect(review.textContent).toBe('原网站已收到最终点击；请勿重复，正在确认结果…');
    notifyState?.('BLOCKED');
    expect(review.textContent).toBe('安全状态不可验证；已停止提交，请重新开始');
  });

  it('拒绝的确认保持未确认，且不可确认时根本不渲染入口', async () => {
    const fields = mountFields(2);
    const rejected = showAuditPanel(view([row({ label: 'A', element: fields[0] })]), {
      canConfirmFinalReview: () => true,
      confirmFinalReview: () => false,
    });
    const review = rejected.shadowRoot!.querySelector<HTMLButtonElement>('[data-final-review]')!;
    review.click();
    await vi.waitFor(() => {
      expect(review.disabled).toBe(false);
      expect(review.textContent).toBe('我已逐项复核');
    });

    const unavailable = showAuditPanel(view([row({ label: 'B', element: fields[1] })]), {
      canConfirmFinalReview: () => false,
      confirmFinalReview: vi.fn(() => true),
    });
    expect(unavailable.shadowRoot!.querySelector('[data-final-review]')).toBeNull();
  });

  it('外部 value drift 撤销后立即恢复复核按钮', async () => {
    const [field] = mountFields(1);
    let notify: ((state: 'REVIEW_REQUIRED' | 'REVIEW_CONFIRMED') => void) | undefined;
    const unsubscribe = vi.fn();
    const handle = showAuditPanel(view([row({ label: 'A', element: field })]), {
      canConfirmFinalReview: () => true,
      confirmFinalReview: async () => true,
      subscribeFinalReviewState: (listener) => {
        notify = listener;
        return unsubscribe;
      },
    });
    const review = handle.shadowRoot!.querySelector<HTMLButtonElement>('[data-final-review]')!;
    review.click();
    await vi.waitFor(() => expect(review.disabled).toBe(true));

    notify?.('REVIEW_REQUIRED');
    expect(review.disabled).toBe(false);
    expect(review.textContent).toBe('我已逐项复核');
    handle.dismiss();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('generation 已退役时撤销只显示失效态，不允许重新确认旧审计', async () => {
    const [field] = mountFields(1);
    let current = true;
    let notify: ((state: 'REVIEW_REQUIRED' | 'REVIEW_CONFIRMED') => void) | undefined;
    const handle = showAuditPanel(view([row({ label: 'A', element: field })]), {
      canConfirmFinalReview: () => current,
      confirmFinalReview: async () => true,
      subscribeFinalReviewState: (listener) => {
        notify = listener;
        return vi.fn();
      },
    });
    const review = handle.shadowRoot!.querySelector<HTMLButtonElement>('[data-final-review]')!;
    review.click();
    await vi.waitFor(() => expect(review.disabled).toBe(true));

    current = false;
    notify?.('REVIEW_REQUIRED');
    expect(review.disabled).toBe(true);
    expect(review.textContent).toBe('我已逐项复核');
  });

  it('拆除唯一复核 UI 时只通知一次，让调用方保留 fail-closed tombstone', () => {
    const [field] = mountFields(1);
    const onDismiss = vi.fn();
    const handle = showAuditPanel(view([row({ label: 'A', element: field })]), {
      canConfirmFinalReview: () => true,
      confirmFinalReview: () => true,
      onDismiss,
    });
    handle.dismiss();
    handle.dismiss();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe('生命周期', () => {
  it('单实例：新一轮替换旧面板', () => {
    const fields = mountFields(2);
    showAuditPanel(view([row({ label: 'A', element: fields[0] })]));
    const second = showAuditPanel(view([row({ label: 'B', element: fields[1] })]));
    expect(document.documentElement.querySelectorAll('#edaix-run-audit-panel')).toHaveLength(1);
    expect(textOf(second)).toContain('B');
    expect(
      document.documentElement.textContent ?? '',
      '旧一轮的行还留在页面上',
    ).not.toContain('A');
  });

  it('一行都没有时不弹——空面板对用户是噪音', () => {
    mountFields(0);
    showAuditPanel(view([]));
    expect(document.documentElement.querySelector('#edaix-run-audit-panel')).toBeNull();
  });

  it('pagehide 自动拆除', () => {
    const [field] = mountFields(1);
    showAuditPanel(view([row({ label: 'A', element: field })]));
    window.dispatchEvent(new Event('pagehide'));
    expect(document.documentElement.querySelector('#edaix-run-audit-panel')).toBeNull();
  });
});

describe('T15 匿名诊断入口', () => {
  it('明示 opt-in，结构回报必须按两次，清除入口会调用本机清除链', async () => {
    const [field] = mountFields(1);
    const setConsent = vi.fn();
    const report = vi.fn(async () => 'ACCEPTED' as const);
    const clear = vi.fn(async () => 'CLEARED' as const);
    const handle = showAuditPanel(view([row({ label: 'Sensitive local-only label', element: field })]), {
      telemetryConsent: false,
      onTelemetryConsentChange: setConsent,
      onReportStructure: report,
      onClearDiagnostics: clear,
    });
    const shadow = handle.shadowRoot!;
    expect(textOf(handle)).toContain('不含栏位名称、内容、网址或履历');

    const consent = shadow.querySelector<HTMLInputElement>('.diagnostics input[type="checkbox"]')!;
    consent.checked = true;
    consent.dispatchEvent(new Event('change'));
    expect(setConsent).toHaveBeenCalledWith(true);

    const buttons = [...shadow.querySelectorAll<HTMLButtonElement>('.diagnostics button')];
    const reportButton = buttons.find((item) => item.textContent === '回报表单结构')!;
    reportButton.click();
    expect(report).not.toHaveBeenCalled();
    expect(reportButton.textContent).toBe('确认送出');
    reportButton.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(1);

    buttons.find((item) => item.textContent === '清除诊断资料')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('清除失败时不显示假成功，并保持自动传送关闭', async () => {
    const [field] = mountFields(1);
    const setConsent = vi.fn(async () => 'LOCAL_CLEAR_FAILED' as const);
    const clear = vi.fn(async () => 'PROVIDER_DELETE_PENDING' as const);
    const handle = showAuditPanel(view([row({ label: 'A', element: field })]), {
      telemetryConsent: true,
      onTelemetryConsentChange: setConsent,
      onClearDiagnostics: clear,
    });
    const shadow = handle.shadowRoot!;
    const consent = shadow.querySelector<HTMLInputElement>('.diagnostics input[type="checkbox"]')!;

    consent.checked = false;
    consent.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(textOf(handle)).toContain('本机诊断未完全清除'));
    expect(consent.checked).toBe(false);
    expect(textOf(handle)).not.toContain('本机诊断已清除，并已请求删除目前匿名识别');

    const clearButton = [...shadow.querySelectorAll<HTMLButtonElement>('.diagnostics button')]
      .find((item) => item.textContent === '清除诊断资料')!;
    clearButton.click();
    await vi.waitFor(() => expect(textOf(handle)).toContain('远端删除待重试'));
    expect(textOf(handle)).not.toContain('本机诊断已清除，并已请求删除目前匿名识别');
  });
});

// ── 2026-09-20 P0-3：浮层里能看到最近的稳定原因码 ─────────────────────────
//
// authClient / authHandoff / intentClient 早就在报 AUTH_REFRESH_FAILED、
// HANDOFF_NO_PENDING_STATE 这类码，worker 此前一个都没接，全被丢掉。09-18 每一个难查的
// 问题都难在这。这里只显示码，不显示任何值（RULE-GLOBAL-DATA-L1 允许的正是这个）。
describe('诊断区：最近原因码', () => {
  it('有 recentDiagnostics 就列出来，只列码', async () => {
    const { renderDiagnostics } = await import('../lib/auditControls');
    const section = renderDiagnostics(document, {
      recentDiagnostics: async () => ['AUTH_REFRESH_GRACE_ATTEMPT', 'HANDOFF_NO_PENDING_STATE'],
    });
    expect(section).not.toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    const items = [...section!.querySelectorAll('.diagnostics-codes li')].map((li) => li.textContent);
    expect(items).toEqual(['AUTH_REFRESH_GRACE_ATTEMPT', 'HANDOFF_NO_PENDING_STATE']);
    expect(section!.textContent).not.toMatch(/Bearer|@|https?:/);
  });

  it('没有码就不摆空列表', async () => {
    const { renderDiagnostics } = await import('../lib/auditControls');
    const section = renderDiagnostics(document, { recentDiagnostics: async () => [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(section?.querySelector('.diagnostics-codes')).toBeNull();
  });
});
