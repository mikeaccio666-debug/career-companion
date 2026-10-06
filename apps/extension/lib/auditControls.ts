import type { SubmissionBoundaryRuntimeState } from './submissionBoundaryProtocol';

/**
 * The audit surface's controls, built once and mounted twice.
 *
 * The standalone audit panel (`auditPanel.ts`) and the dock's run scene show
 * the same three things after a fill: the way to undo this round, the final
 * review that arms the user's own Submit, and the diagnostics switches. They
 * used to be private to the panel; the dock folding them in must not mean a
 * second implementation of the one control that stands between a filled form
 * and the host's Submit button. So the builders live here and both surfaces
 * call them with their own document and their own closed shadow root -- the
 * shadow root is what the undo and review authorities are minted against
 * (`grant.ts` mintAuthority, `eventComesFromShadow`), so each surface hands in
 * the one it actually owns.
 */
export type TelemetryControlStatus =
  | 'UPDATED'
  | 'CLEARED'
  | 'LOCAL_CLEAR_FAILED'
  | 'PROVIDER_DELETE_PENDING';

export interface AuditControlHandlers {
  /** 当前是否还有可还原的写入。false 时不摆按钮——点了没反应比没有按钮更伤。 */
  readonly canUndo?: () => boolean;
  /** 原样交出真实点击与我方 shadowRoot；铸票与还原由调用方做。 */
  readonly undoAll?: (event: Event, shadowRoot: ShadowRoot) => void;
  /** T15：使用者是否明确允许自动传送零 Data-L1 的匿名诊断。 */
  readonly telemetryConsent?: boolean;
  readonly onTelemetryConsentChange?: (enabled: boolean) => TelemetryControlStatus | void | Promise<TelemetryControlStatus | void>;
  /** 逐次二次确认后才送出本页的聚合结构。 */
  readonly onReportStructure?: () => Promise<'ACCEPTED' | 'COPIED' | 'FAILED'>;
  /** 先清本机 buffer／identity，再向 provider 请求删除。 */
  readonly onClearDiagnostics?: () => TelemetryControlStatus | void | Promise<TelemetryControlStatus | void>;
  /**
   * 最近的稳定原因码（2026-09-20，P0-3）。只有码，没有值。
   *
   * worker 里 authClient / authHandoff / intentClient 报的 AUTH_REFRESH_FAILED、
   * HANDOFF_NO_PENDING_STATE 这类码此前全被丢掉；09-18 每一个难查的问题都难在这。
   */
  readonly recentDiagnostics?: () => Promise<readonly string[]>;
  /** 只有精确 scan generation 的提交门禁仍可用时才展示复核入口。 */
  readonly canConfirmFinalReview?: () => boolean;
  /** 返回 true 才把本地 UI 标为已复核；验证失败保持未确认。 */
  readonly confirmFinalReview?: (
    event: Event,
    shadowRoot: ShadowRoot,
  ) => boolean | Promise<boolean>;
  /** 让 value drift／重扫等撤销动作立即恢复按钮，而不是显示陈旧成功态。 */
  readonly subscribeFinalReviewState?: (
    listener: (state: 'REVIEW_REQUIRED' | 'REVIEW_CONFIRMED') => void,
  ) => () => void;
  /** Keep every swallowed native click visible; the user never has to guess whether to retry. */
  readonly subscribeSubmissionState?: (
    listener: (state: SubmissionBoundaryRuntimeState) => void,
  ) => () => void;
}

/** The undo button, or null when there is nothing to undo. */
export function createUndoControl(
  doc: Document,
  shadow: ShadowRoot,
  handlers: AuditControlHandlers,
  label = '还原本轮写入',
): HTMLButtonElement | null {
  if (handlers.canUndo?.() !== true || !handlers.undoAll) return null;
  const undo = doc.createElement('button');
  undo.type = 'button';
  undo.dataset.undo = '';
  undo.textContent = label;
  undo.addEventListener('click', (event) => {
    // 原样交出去：信任根是"用户在我方浮层里的真实点击"，验它的是 mintAuthority。
    handlers.undoAll?.(event, shadow);
  });
  return undo;
}

/**
 * The final-review control, or null when this generation cannot be reviewed.
 *
 * The button's words track two facts at once: whether the user has confirmed
 * their review, and where the submission boundary is. Every state has its own
 * sentence so a swallowed native click is never silent.
 */
export function createFinalReviewControl(
  doc: Document,
  shadow: ShadowRoot,
  handlers: AuditControlHandlers,
): { readonly element: HTMLElement; readonly dispose: () => void } | null {
  if (handlers.canConfirmFinalReview?.() !== true || !handlers.confirmFinalReview) return null;
  const review = doc.createElement('div');
  review.className = 'review';
  const confirm = doc.createElement('button');
  confirm.type = 'button';
  confirm.dataset.finalReview = '';
  confirm.textContent = '我已逐项复核';
  let reviewState: 'REVIEW_REQUIRED' | 'REVIEW_CONFIRMED' = 'REVIEW_REQUIRED';
  let submissionState: SubmissionBoundaryRuntimeState = 'ARMED';
  const renderState = () => {
    if (submissionState === 'BLOCKED') {
      confirm.disabled = true;
      confirm.textContent = '安全状态不可验证；已停止提交，请重新开始';
      return;
    }
    if (submissionState === 'OUTCOME_UNKNOWN') {
      confirm.disabled = true;
      confirm.textContent = '原网站已收到最终点击；请勿重复，正在确认结果…';
      return;
    }
    if (submissionState === 'TRIGGERED_LOCKED') {
      confirm.disabled = true;
      confirm.textContent = '最终点击已记录；请勿重复提交';
      return;
    }
    if (reviewState === 'REVIEW_REQUIRED') {
      confirm.disabled = !handlers.canConfirmFinalReview?.();
      confirm.textContent = '我已逐项复核';
      return;
    }
    confirm.disabled = true;
    switch (submissionState) {
      case 'BOUNDARY_PENDING':
        confirm.textContent = '已拦住第 1 次点击；正在建立安全边界…';
        break;
      case 'WAIT_FOR_USER_RETRY':
        confirm.textContent = '第 1 次点击已拦住；正在准备最终提交…';
        break;
      case 'WAIT_FOR_FINAL_RETRY':
        confirm.textContent = '安全边界已建立；请再次点击原网站 Submit（2/2：本次会到达原网站）';
        break;
      case 'ARMED':
      default:
        confirm.textContent = '已复核；请第一次点击原网站 Submit（1/2：建立安全边界）';
        break;
    }
  };
  const renderReviewState = (state: 'REVIEW_REQUIRED' | 'REVIEW_CONFIRMED') => {
    reviewState = state;
    renderState();
  };
  confirm.addEventListener('click', async (event) => {
    if (confirm.disabled) return;
    confirm.disabled = true;
    confirm.textContent = '正在确认复核…';
    let accepted = false;
    try {
      accepted = await handlers.confirmFinalReview?.(event, shadow) === true;
    } catch {
      accepted = false;
    }
    renderReviewState(accepted ? 'REVIEW_CONFIRMED' : 'REVIEW_REQUIRED');
  });
  let removeReviewStateListener: (() => void) | null =
    handlers.subscribeFinalReviewState?.(renderReviewState) ?? null;
  let removeSubmissionStateListener: (() => void) | null =
    handlers.subscribeSubmissionState?.((state) => {
      submissionState = state;
      renderState();
    }) ?? null;
  review.append(confirm);
  return {
    element: review,
    dispose: () => {
      removeReviewStateListener?.();
      removeReviewStateListener = null;
      removeSubmissionStateListener?.();
      removeSubmissionStateListener = null;
    },
  };
}

/** The diagnostics switches, or null when this build offers none. */
export function renderDiagnostics(doc: Document, handlers: AuditControlHandlers): HTMLElement | null {
  if (!handlers.onTelemetryConsentChange && !handlers.onReportStructure && !handlers.onClearDiagnostics && !handlers.recentDiagnostics) return null;

  const section = doc.createElement('div');
  section.className = 'diagnostics';
  const note = doc.createElement('span');
  note.className = 'diagnostics-note';
  note.textContent = '诊断只含厂商、结果与聚合计数；不含栏位名称、内容、网址或履历。';
  section.append(note);

  if (handlers.recentDiagnostics) {
    // 异步取回再挂；取不到或为空就什么都不摆——空列表比没有列表更让人以为坏了。
    void handlers.recentDiagnostics().then((codes) => {
      const recent = codes.filter((code) => typeof code === 'string' && /^[A-Z0-9_]{3,64}$/.test(code)).slice(-20);
      if (recent.length === 0) return;
      const list = doc.createElement('ul');
      list.className = 'diagnostics-codes';
      for (const code of recent) {
        const item = doc.createElement('li');
        item.textContent = code;
        list.append(item);
      }
      section.append(list);
    }).catch(() => {});
  }

  if (handlers.onTelemetryConsentChange) {
    const label = doc.createElement('label');
    const consent = doc.createElement('input');
    consent.type = 'checkbox';
    consent.checked = handlers.telemetryConsent === true;
    consent.addEventListener('change', () => {
      const enabled = consent.checked;
      consent.disabled = true;
      void Promise.resolve(handlers.onTelemetryConsentChange?.(enabled))
        .then((status) => {
          if (status === 'LOCAL_CLEAR_FAILED') {
            if (enabled) consent.checked = false;
            setDiagnosticStatus(section, enabled
              ? '无法开启自动传送；诊断仍保持关闭。'
              : '已停止自动传送；本机诊断未完全清除，请重试。', doc);
          } else if (status === 'PROVIDER_DELETE_PENDING') {
            consent.checked = false;
            setDiagnosticStatus(section, '已停止自动传送并清除本机资料；远端删除待重试。', doc);
          } else {
            setDiagnosticStatus(section, enabled ? '已开启匿名诊断传送。' : '本机诊断已清除，并已删除目前匿名识别。', doc);
          }
        })
        .catch(() => {
          if (enabled) consent.checked = false;
          setDiagnosticStatus(section, enabled
            ? '无法开启自动传送；诊断仍保持关闭。'
            : '已停止自动传送；本机诊断未完全清除，请重试。', doc);
        })
        .finally(() => { consent.disabled = false; });
    });
    label.append(consent, doc.createTextNode('允许自动传送匿名诊断'));
    section.append(label);
  }

  if (handlers.onReportStructure) {
    const report = doc.createElement('button');
    report.type = 'button';
    report.textContent = '回报表单结构';
    let confirmed = false;
    report.addEventListener('click', () => {
      if (!confirmed) {
        confirmed = true;
        setDiagnosticStatus(section, '将送出控制项类型与计数，不含页面文字；再按一次确认。', doc);
        report.textContent = '确认送出';
        return;
      }
      report.disabled = true;
      void handlers.onReportStructure!().then((status) => {
        setDiagnosticStatus(
          section,
          status === 'ACCEPTED'
            ? '已送出匿名诊断。'
            : status === 'COPIED'
              ? '无法送出，安全诊断已复制。'
              : '无法送出或复制诊断。',
          doc,
        );
        report.textContent = status === 'ACCEPTED' ? '已送出' : '回报表单结构';
        report.disabled = false;
        confirmed = false;
      });
    });
    section.append(report);
  }

  if (handlers.onClearDiagnostics) {
    const clear = doc.createElement('button');
    clear.type = 'button';
    clear.textContent = '清除诊断资料';
    clear.addEventListener('click', () => {
      clear.disabled = true;
      void Promise.resolve(handlers.onClearDiagnostics?.())
        .then((status) => {
          setDiagnosticStatus(section, status === 'PROVIDER_DELETE_PENDING'
            ? '已停止自动传送并清除本机资料；远端删除待重试。'
            : status === 'LOCAL_CLEAR_FAILED'
              ? '已停止自动传送；本机诊断未完全清除，请重试。'
              : '本机诊断已清除，并已删除目前匿名识别。', doc);
        })
        .catch(() => {
          setDiagnosticStatus(section, '已停止自动传送；本机诊断未完全清除，请重试。', doc);
        })
        .finally(() => { clear.disabled = false; });
    });
    section.append(clear);
  }

  return section;
}

function setDiagnosticStatus(section: HTMLElement, message: string, doc: Document): void {
  let status = section.querySelector<HTMLElement>('[data-edaix-telemetry-status]');
  if (!status) {
    status = doc.createElement('span');
    status.className = 'diagnostics-status';
    status.dataset.edaixTelemetryStatus = 'true';
    section.append(status);
  }
  status.textContent = message;
}
