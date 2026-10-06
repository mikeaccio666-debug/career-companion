import type { AuditStatus, AuditView } from '@edaix/apply-kernel/audit';
import { normalizeGuardText, SELF_IDENTIFICATION } from '@edaix/apply-kernel/guards';

import type { AutofillDockFieldRow, AutofillDockProgress, DockRowState } from './autofillDock';
import { dockRegionName, type DockLocale } from './dock/copy';
import type { KernelFillLive } from './kernelFiller';

/**
 * The audit the fill already produced, shaped for the dock's run scene.
 *
 * Deliberately a mapping rather than handing `AuditView` to the dock: the dock is
 * a surface, and coupling it to the kernel's audit shape would make every future
 * audit field a decision about the panel. This keeps one narrow seam instead.
 *
 * What crosses it is local only. The rows carry the host's own labels, the value
 * we wrote and a way to scroll the host field into view -- the same things the
 * audit panel shows, inside the same boundary: never over the bridge, never into
 * a receipt, never into telemetry.
 */

/** One audit status, as the run scene names it. */
const ROW_STATE: Readonly<Record<AuditStatus, DockRowState>> = Object.freeze({
  FILLED: 'CONFIRMED',
  // FILLED_UNVERIFIED is deliberately not done. The audit separates it from
  // FILLED so that "clicked but did not take" cannot look like "confirmed";
  // re-merging them here would undo exactly that, on the surface the user
  // checks before submitting.
  FILLED_UNVERIFIED: 'UNVERIFIED',
  PREFILLED: 'PRESERVED',
  // "Only you can answer this" and "we could not do it" stay apart: the first
  // sends the user to a field they own, the second is our defect to fix.
  NEEDS_MANUAL: 'MANUAL',
  // 乙档预填也交还用户，但它的下一步只是「看一眼、点确认」，不是「自己想答案」。
  // dock 目前只有 MANUAL 这一档承载「轮到你」，先并进去；等授权弹框（⑥）落地
  // 再给它自己的行态，不要为了一个还没有的界面先造一个空名字。
  NEEDS_CONFIRMATION: 'MANUAL',
  MISSING_PROFILE: 'MANUAL',
  LOW_CONFIDENCE: 'MANUAL',
  REJECTED: 'FAILED',
  FAILED: 'FAILED',
});

/** Statuses whose next step is the user's own hand on the page. */
const NEEDS_USER: ReadonlySet<AuditStatus> = new Set<AuditStatus>(['NEEDS_MANUAL', 'NEEDS_CONFIRMATION', 'MISSING_PROFILE', 'LOW_CONFIDENCE']);

/**
 * 以用户名义代填的条目键 → 浮层那一行要明说的类别：条款同意、属实声明、签名栏两格（2026-09-23），六类同意
 * （2026-09-24），第五刀的新类别与「能不能联系雇主」（2026-09-28）。与内核 `SIGN_ON_BEHALF_ENTRY_KEY` 互为
 * 反表（`tests/autofill-dock-progress.test.ts` 钉住），就地写一份是为了不把整个引擎拉进只画浮层的包里。
 */
export const SIGNED_ON_BEHALF: Readonly<Record<string, NonNullable<AutofillDockFieldRow['signedOnBehalf']>>> = Object.freeze({
  termsConsent: 'TERMS_CONSENT',
  truthAttestation: 'TRUTH_ATTESTATION',
  signatureName: 'SIGNATURE_NAME',
  signatureDate: 'SIGNATURE_DATE',
  aiRecordingConsent: 'AI_RECORDING_CONSENT',
  smsConsent: 'SMS_CONSENT',
  futureContactConsent: 'FUTURE_CONTACT_CONSENT',
  marketingConsent: 'MARKETING_CONSENT',
  backgroundCheckConsent: 'BACKGROUND_CHECK_CONSENT',
  arbitrationAgreement: 'ARBITRATION_AGREEMENT',
  recruitingDataSharingConsent: 'RECRUITING_DATA_SHARING',
  informationVerificationConsent: 'INFORMATION_VERIFICATION',
  screeningConsent: 'SCREENING_CONSENT',
  atWillAcknowledgement: 'AT_WILL_ACKNOWLEDGEMENT',
  arbitrationWaiver: 'ARBITRATION_WAIVER',
  aiInterviewAnalysisConsent: 'AI_INTERVIEW_ANALYSIS',
  callNotificationConsent: 'CALL_NOTIFICATION_CONSENT',
  groupFutureContactConsent: 'GROUP_FUTURE_CONTACT',
  privacyNoticeAcknowledgement: 'PRIVACY_NOTICE_TITLE',
  combinedConsent: 'COMBINED_CONSENT',
  employerContactAllowed: 'EMPLOYER_CONTACT_YES',
  employerContactDeclined: 'EMPLOYER_CONTACT_NO',
  referenceContactAllowed: 'REFERENCE_CONTACT_YES',
  referenceContactDeclined: 'REFERENCE_CONTACT_NO',
});

/**
 * 填写途中的那一份（2026-09-23）。手势路从前整轮跑完才把单子交给浮层：用户按下自动填写，
 * 盯着「正在准备…」看十来秒，然后结果一下子全冒出来——实测 Greenhouse 一页 11 秒里浮层一动不动。
 *
 * 途中的视图是进度不是判决（`kernelFiller` 的 `onProgress` 头注）：还没轮到的条目在视图里按
 * 「这一轮没跑到」记（FAILED + ABORTED），这里画成「待填写」；确认填入的亮成「已填好」；计划期就
 * 交还用户的那几行照实画。没有 `phase`：浮层把它当成还在跑，收起条上写的是「必填 x/y」。
 */
export function dockProgressWhileFilling(runId: string, view: AuditView, live?: KernelFillLive, locale: DockLocale = 'zh'): AutofillDockProgress {
  const settled = dockProgressFromAudit(runId, view, locale);
  return Object.freeze({
    runId,
    requiredCompleted: settled.requiredCompleted,
    requiredQuestions: settled.requiredQuestions,
    rows: Object.freeze(settled.rows.map((row, index) => {
      const audited = view.rows[index];
      if (!(audited?.status === 'FAILED' && audited.reason === 'ABORTED')) return row;
      // 还没结算的那一栏：正在写（WRITING）、已写进网页等确认（WRITTEN），否则还没轮到（PENDING）。
      const element = audited.element as Element | undefined;
      const state: DockRowState = live === undefined || element === undefined ? 'PENDING'
        : live.current === element ? 'WRITING'
        : live.written.has(element) ? 'WRITTEN' : 'PENDING';
      return Object.freeze({
        label: row.label,
        required: row.required,
        done: false,
        state,
        ...(row.target === undefined ? {} : { target: row.target }),
        ...(row.collection === undefined ? {} : { collection: row.collection }),
        ...(row.checkbox === true ? { checkbox: true } : {}),
        ...(row.attachment === true ? { attachment: true } : {}),
        ...(state === 'WRITTEN' && (audited.resolvedOptionText ?? audited.attemptedValue) !== null
          ? { value: audited.resolvedOptionText ?? audited.attemptedValue } : {}),
      });
    })),
  });
}

/**
 * `locale`：行里写的国名（按岗位地点推断的、没有工作许可记录的那一国）用浮层的哪一种语言写；不传是中文。
 */
export function dockProgressFromAudit(runId: string, view: AuditView, locale: DockLocale = 'zh'): AutofillDockProgress {
  const regionName = (code: string): string => dockRegionName(code, locale);
  const positions = collectionPositions(view.rows);
  return Object.freeze({
    runId,
    // Settled by construction: an audit exists only once a fill attempt is over,
    // and this mapping is called at that moment and no other. Leaving it off
    // made "the run finished" a fact only the other producer could state, which
    // left this path — the one with the labelled rows — stuck on the working
    // list no matter how the fill ended.
    phase: 'SETTLED' as const,
    // The audit's own counting, not a recount: `requiredHandled` already decides
    // what "handled" means, and a second opinion here would drift from the number
    // the audit panel shows for the same run.
    requiredCompleted: view.requiredHandled,
    requiredQuestions: view.requiredTotal,
    rows: Object.freeze(view.rows.map((row, index) => {
      const state = ROW_STATE[row.status] ?? 'FAILED';
      const position = positions[index];
      const written = row.resolvedOptionText ?? row.attemptedValue;
      // The audit hands over the host node; a row without one (a test fixture,
      // a synthetic view) simply has no way to be located. Duck-typed, because
      // this mapping also runs where no DOM globals exist.
      const element = (row as { element?: { scrollIntoView?: unknown } }).element;
      const locatable = typeof element?.scrollIntoView === 'function'
        ? (element as { scrollIntoView: (options: { block: 'center' }) => void }) : null;
      const controlType = (row.element as { type?: unknown } | null | undefined)?.type;
      // ARIA 代理的复选（Workable 的 div[role=checkbox]）与原生复选框在浮层上是同一种行（2026-09-23）。
      const proxyRole = (row.element as { getAttribute?: (name: string) => string | null } | null | undefined)
        ?.getAttribute?.('role');
      return Object.freeze({
        label: row.label,
        required: row.required,
        done: row.status === 'FILLED',
        state,
        reason: row.reason ?? null,
        // 计划里的条目（带键）：我们这一轮要写它。它收尾时的样子不算用户补的（见 `planned` 头注）。
        ...(row.key !== null ? { planned: true } : {}),
        ...(NEEDS_USER.has(row.status) ? { needsUser: true } : {}),
        ...(row.key !== null && SIGNED_ON_BEHALF[row.key] !== undefined ? { signedOnBehalf: SIGNED_ON_BEHALF[row.key] } : {}),
        ...(row.inferredRegionCode === undefined ? {} : { inferredRegion: regionName(row.inferredRegionCode) }),
        // 工作授权题说得出是哪一国、他在那一国没有工作许可记录（2026-09-24）：浮层照实说是哪一国。
        ...(row.regionWithoutRecord === undefined ? {} : { regionWithoutRecord: regionName(row.regionWithoutRecord) }),
        // 他有别国的记录、唯独没有那一国的，按默认答了（2026-09-24 负责人决定）：是哪一国、问的是不是担保，浮层据此写明。
        ...(row.defaultedRegionCode === undefined
          ? {}
          : { defaultedWorkAuth: { region: regionName(row.defaultedRegionCode), sponsorship: row.key === 'workSponsorship' } }),
        // 一段加了、填了、没能保存下来的经历／教育（2026-09-24）：第几段、保存钮上的字、还差的那几格。
        ...(row.unsavedEntry === undefined
          ? {}
          : {
              unsavedEntry: {
                collection: row.unsavedEntry.collection,
                number: row.unsavedEntry.rowIndex + 1,
                saveLabel: row.label,
                ...(row.unsavedEntry.missing === undefined ? {} : { missing: row.unsavedEntry.missing }),
              },
            }),
        // 我们替他按了保存、网站收下了的那一段（全加全存）；没加上的那几段。都从 1 数。
        ...(row.savedEntry === undefined
          ? {}
          : { savedEntry: { collection: row.savedEntry.collection, number: row.savedEntry.rowIndex + 1, saveLabel: row.label } }),
        ...(row.unaddedEntries === undefined
          ? {}
          : {
              unaddedEntries: {
                collection: row.unaddedEntries.collection,
                from: row.unaddedEntries.from + 1,
                to: row.unaddedEntries.to + 1,
                afterUnsaved: row.unaddedEntries.afterUnsaved,
              },
            }),
        // 按学历／工作经历推出来的答案（2026-09-24）：依据的稳定码原样带过去，浮层写一句人话。
        ...(row.historyBasis === undefined ? {} : { historyBasis: row.historyBasis }),
        // 搜索式多选没加上的几项（2026-09-24，Workday 的技能）：值与稳定原因码原样带过去，浮层列出来。
        ...(row.notAdded === undefined ? {} : { notAdded: row.notAdded }),
        // AI 代答写成的那一行（kernelFiller 的 AiAnsweredAuditRow）：浮层单列一组、网页上挂标记。
        ...((row as { aiAnswered?: unknown }).aiAnswered === true && (state === 'CONFIRMED' || state === 'UNVERIFIED')
          ? { aiAnswered: true } : {}),
        // What landed there, shown back so "filled" is checkable rather than
        // claimed. A row nothing was written to carries no value.
        ...(written && (state === 'CONFIRMED' || state === 'UNVERIFIED') ? { value: written } : {}),
        // Only scroll, never focus: focus would trigger the host's own
        // validation and linkage, and that is a change to host behaviour.
        ...(locatable !== null
          ? { locate: () => { locatable.scrollIntoView({ block: 'center' }); } }
          : {}),
        // 宿主控件本身（只在本地）：「去那一栏」时滚过去、亮一下、看用户是不是已经在网站上填了。
        ...(locatable !== null ? { target: row.element } : {}),
        ...(controlType === 'checkbox' || proxyRole === 'checkbox' ? { checkbox: true } : {}),
        ...(controlType === 'file' ? { attachment: true } : {}),
        // 网站从简历里读出来填的（不是我们、也不是用户）：照实标出来，浮层不把它记成用户补上的。
        ...(row.siteFilled === 'FROM_RESUME' ? { fromResume: true } : {}),
        // 选项对不上时，用户资料里的原值（「你资料里是 …」）。
        ...((row.reason === 'NO_OPTION_MATCH' || row.reason === 'AMBIGUOUS_OPTION') && row.attemptedValue !== null
          ? { hint: row.attemptedValue } : {}),
        // 2026-09-28：第几段经历／教育（进度卡上的「正在填工作经历 2/3」）、他在浮层里当场答的、自我认同题。
        ...(position === undefined ? {} : { collection: position }),
        ...((row as { userAnswered?: unknown }).userAnswered === true && (state === 'CONFIRMED' || state === 'UNVERIFIED')
          ? { userAnswered: true } : {}),
        ...(typeof row.label === 'string' && SELF_IDENTIFICATION.test(normalizeGuardText(row.label)) ? { selfIdentification: true } : {}),
      });
    })),
  });
}

type CollectionPosition = NonNullable<AutofillDockFieldRow['collection']>;

/**
 * 经历／教育的每一格是第几段、共几段（2026-09-28）：同一个角色（`experience.company`……）第 n 次出现就是第 n 段——
 * 单子按页面的先后排，一段里的几格挨在一起。只看键，不看值。
 */
function collectionPositions(rows: AuditView['rows']): readonly (CollectionPosition | undefined)[] {
  const seen = new Map<string, number>();
  const totals = new Map<CollectionPosition['kind'], number>();
  const found = rows.map((row) => {
    const key = row.key ?? '';
    const kind: CollectionPosition['kind'] | null = key.startsWith('experience.') ? 'experience' : key.startsWith('education.') ? 'education' : null;
    if (kind === null) return undefined;
    const number = (seen.get(key) ?? 0) + 1;
    seen.set(key, number);
    totals.set(kind, Math.max(totals.get(kind) ?? 0, number));
    return { kind, number };
  });
  return found.map((one) => (one === undefined ? undefined : Object.freeze({ ...one, total: totals.get(one.kind) ?? one.number })));
}
