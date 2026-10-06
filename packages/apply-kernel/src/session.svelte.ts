/**
 * Content-owned state for one application-page autofill session.
 *
 * This file deliberately uses an explicit snapshot/subscription store instead
 * of Svelte runes. The content script owns it for the life of the page, while
 * a Shadow overlay is only a replaceable renderer: a host framework may remove
 * that renderer without losing the journal that makes Undo safe.
 *
 * ⚠️ 当前无产线消费者（旧 contentSession 组装线已随 2026-08-15 债务清偿
 * 删除，新架构 apps/extension 尚未接线）：仅作 4 个测试的 harness 保留。
 * s0/apply-resume-host-confirm 的会话级确认用例守的是本休眠路径，接线
 * 之日即恢复产线意义；活路径的简历域名门槛目前由 engine.ts 的
 * HOST_UNCONFIRMED fail-closed 兜底（kernelFiller 不传 resumeHostConfirmed，
 * 生产恒 skipped）。
 */

import { buildApplyPlan, summarizePlan, type ApplyPlanSummary } from './engine';
import { isTrustedShadowGesture, mintAuthority, narrowAuthority } from './grant';
import { capabilitiesForKinds } from './write/allowlist';
import { isApplyPolicyEnabled, loadApplyPolicy, type ApplyPolicy } from './policy';
import { type ApplyProfileDraft } from './profileDraft';
import { runApplyPlan, type ApplyRunSummary, type ResolveResumeFile } from './runner';
import { createUndoJournal, type UndoJournal, type UndoOutcome } from './undo';
import type { BeginMainWorldBridge } from './write/mainWorldBridge';
import {
  APPLY_FIELD_KEYS,
  type ApplyDiagnostic,
  type ApplyErrorCode,
  type ApplyFieldKey,
  type ApplyFormDescriptor,
  type ApplyPlan,
  type ApplyProfileAccessErrorCode,
  type ApplyVendor,
} from './contracts';

export type { ApplyProfileDraft } from './profileDraft';

export type ApplySessionPhase = 'booting' | 'idle' | 'filling' | 'done' | 'disabled';
export type ApplyProfileStatus = 'loading' | 'ready' | 'migration' | 'conflict' | 'unavailable';
export type ApplyProfileMigration = 'migratable' | 'unreadable';
export type ApplyProfileMigrationNotice = 'CLEARED_AFTER_30_DAYS';
export type ApplyResumeSuggestionStatus = 'idle' | 'loading' | 'ready' | 'disabled' | 'unavailable';

/** Names only: truthful legacy-import feedback may never echo profile values. */
export interface ApplyProfileImportOutcome {
  readonly imported: readonly ApplyFieldKey[];
  readonly skippedExisting: readonly ApplyFieldKey[];
  readonly skippedSuppressed: readonly ApplyFieldKey[];
}

/**
 * A service-owned snapshot normalized for the content-session state owner.
 * Values remain tab-memory-only; `revision` and `suppressedKeys` make a
 * stale write or deletion-revival impossible to disguise as a normal save.
 */
export interface ApplySessionProfileValue {
  readonly draft: ApplyProfileDraft;
  readonly revision?: number;
  readonly suppressedKeys?: readonly ApplyFieldKey[];
  readonly hasStoredProfile?: boolean;
  /** Server-owned ALL opt-out; only an explicit account setting can reopen it. */
  readonly resumeDerivationEnabled?: boolean;
  /** Present only immediately after the explicit legacy import operation. */
  readonly legacyImportOutcome?: ApplyProfileImportOutcome;
  /** Field names only: a PATCH was saved but an explicit opt-out still applies. */
  readonly writtenButStillSuppressed?: readonly ApplyFieldKey[];
  /** Legacy data stays private to the content composition root. */
  readonly migration?: ApplyProfileMigration;
  readonly migrationNotice?: ApplyProfileMigrationNotice;
}

export type ApplyProfileRead =
  | { readonly ok: true; readonly value: ApplySessionProfileValue }
  | {
      readonly ok: false;
      readonly code: ApplyProfileAccessErrorCode;
      /** The local legacy copy is already gone; do not keep the migration UI alive on a remote error. */
      readonly legacyLocalDeleted?: true;
      /** A value-free acknowledgement survives even when the account is unavailable. */
      readonly migrationNotice?: ApplyProfileMigrationNotice;
    };
export type ApplyProfileWrite =
  | { readonly ok: true; readonly value: ApplySessionProfileValue | void }
  | { readonly ok: false; readonly code: ApplyProfileAccessErrorCode };
export type ApplyResumeSuggestionsRead =
  | { readonly ok: true; readonly value: ApplyProfileDraft }
  | { readonly ok: false; readonly code: ApplyProfileAccessErrorCode };

export interface ApplySessionState {
  readonly phase: ApplySessionPhase;
  readonly form: ApplyFormDescriptor | null;
  /** Frozen at the moment a Fill starts so the rendered result stays auditable. */
  readonly plan: ApplyPlan | null;
  readonly summary: ApplyPlanSummary | null;
  readonly profile: ApplyProfileDraft;
  readonly profileStatus: ApplyProfileStatus;
  /** A profile transport mutation is in flight; Fill is unavailable until it settles. */
  readonly profileBusy: boolean;
  /** Edited/suggested values need an explicit account Save before Fill may run. */
  readonly profileDirty: boolean;
  /** A transport/migration failure never becomes an empty first-run profile. */
  readonly profileError: ApplyProfileAccessErrorCode | null;
  /** Value-free migration state; the legacy draft is intentionally not in the snapshot. */
  readonly profileMigration: ApplyProfileMigration | null;
  readonly profileMigrationNotice: ApplyProfileMigrationNotice | null;
  /** Value-free import result, shown once so migration never overclaims success. */
  readonly legacyImportOutcome: ApplyProfileImportOutcome | null;
  /** The service-owned ALL opt-out state; only an explicit Shadow-UI action can change it. */
  readonly resumeDerivationEnabled: boolean;
  /** Names only: explain why a just-saved field still has no resume suggestion. */
  readonly writtenButStillSuppressed: readonly ApplyFieldKey[] | null;
  /** Read-only resume facts stay separate until an explicit profile Save succeeds. */
  readonly resumeSuggestionStatus: ApplyResumeSuggestionStatus;
  readonly resumeSuggestionError: ApplyProfileAccessErrorCode | null;
  readonly resumeSuggestions: ApplyProfileDraft;
  readonly run: ApplyRunSummary | null;
  readonly lastUndo: UndoOutcome | null;
  readonly undoCount: number;
  readonly disabledCode: ApplyErrorCode | null;
  /** Overlay chrome belongs here too, so a remount does not reset it. */
  readonly open: boolean;
  readonly editing: boolean;
  /** A separate second action is required before the service-side hard delete. */
  readonly confirmingAccountDeletion: boolean;
  readonly firstRun: boolean;
  readonly discovered: number;
  /**
   * 这一页的域名在厂商主机表里，或者用户已为**本次访问**确认过。
   * 为 false 时简历那一栏不进计划（`HOST_UNCONFIRMED`），文本字段不受影响。
   */
  readonly resumeHostConfirmed: boolean;
}

export interface ApplySession {
  snapshot(): ApplySessionState;
  /** A copy-safe state summary; it intentionally excludes every L1 profile/host value. */
  diagnostics(): ApplyDiagnostic;
  /** The current state is replayed immediately for a newly mounted renderer. */
  subscribe(listener: (state: ApplySessionState) => void): () => void;
  ready(): Promise<void>;
  setForm(form: ApplyFormDescriptor | null): void;
  setOpen(open: boolean): void;
  setEditing(editing: boolean): void;
  setConfirmingAccountDeletion(confirming: boolean): void;
  updateProfileField(key: ApplyFieldKey, value: string): void;
  /** Saving account data is an explicit trusted Shadow-UI action too. */
  saveProfile(event: Event, shadowRoot: ShadowRoot): Promise<void>;
  /** Explicit recovery after a 412; never auto-reloads or auto-retries a save. */
  reloadProfile(event: Event, shadowRoot: ShadowRoot): Promise<void>;
  /** The only path that may upload an old local profile; requires a Shadow click. */
  uploadLegacyProfile(event: Event, shadowRoot: ShadowRoot): Promise<void>;
  /** Local deletion works while logged out and also requires a Shadow click. */
  discardLegacyProfile(event: Event, shadowRoot: ShadowRoot): Promise<void>;
  /** Service-side hard delete; UI supplies a separate confirmation before calling it. */
  deleteAccountProfile(event: Event, shadowRoot: ShadowRoot): Promise<void>;
  /** Explicitly enable/disable all resume-derived suggestions; never implicit in Save/import/accept. */
  setResumeDerivation(enabled: boolean, event: Event, shadowRoot: ShadowRoot): Promise<void>;
  /** Read a selected resume only after a dedicated Shadow-UI click. */
  loadResumeSuggestions(event: Event, shadowRoot: ShadowRoot): Promise<void>;
  /** A suggestion enters the editor only on an explicit per-field choice. */
  acceptResumeSuggestion(key: ApplyFieldKey, event: Event, shadowRoot: ShadowRoot): void;
  dismissResumeSuggestion(key: ApplyFieldKey, event: Event, shadowRoot: ShadowRoot): void;
  fill(event: Event, shadowRoot: ShadowRoot): Promise<void>;
  undo(event: Event, shadowRoot: ShadowRoot): void;
  /** pagehide revokes an in-flight Fill and its journal without disposing a BFCache session. */
  clearUndo(): void;
  /**
   * 用户在浮层里确认"这个网站可以收我的简历"。**只对本 session 生效**：
   * 只活在内存里、不落盘、不跨标签页、翻页即失效。一个恶意页面要拿到简历，
   * 就必须每一次都重新骗到这一次确认，而不是骗到一次、永久生效。
   */
  confirmResumeHost(event: Event, shadowRoot: ShadowRoot): void;
  dispose(): void;
}

export interface CreateApplySessionInput {
  readonly vendor: ApplyVendor;
  /** Test seams keep the state owner directly unit-testable without an extension runtime. */
  readonly readProfile?: () => Promise<ApplyProfileRead>;
  /** `touched` preserves PATCH's omitted-vs-null tri-state semantics. */
  readonly writeProfile?: (
    profile: ApplyProfileDraft,
    touched: readonly ApplyFieldKey[],
    expectedRevision: number,
  ) => Promise<ApplyProfileWrite>;
  /** Legacy operations are injected by the assembly root (旧 contentSession 已删，现仅测试注入); session never reads local storage itself. */
  readonly uploadLegacyProfile?: () => Promise<ApplyProfileRead>;
  readonly discardLegacyProfile?: () => Promise<ApplyProfileRead>;
  readonly deleteAccountProfile?: () => Promise<ApplyProfileRead>;
  readonly setResumeDerivation?: (enabled: boolean) => Promise<ApplyProfileRead>;
  readonly readResumeSuggestions?: () => Promise<ApplyResumeSuggestionsRead>;
  readonly loadPolicy?: () => Promise<ApplyPolicy>;
  /** Content owns parser access; every C5 abort must obtain a fresh descriptor. */
  readonly rescanForm: () => ApplyFormDescriptor | null;
  /** Only the isolated application entry enables the Fill-only MAIN bridge. */
  readonly startMainWorldBridge?: BeginMainWorldBridge;
  /** Metadata-only read used to make the resume row honestly previewable. */
  readonly readResumeFileName?: () => Promise<string | null>;
  /** L1 bytes are requested only after the user approves that preview. */
  readonly resolveResumeFile?: ResolveResumeFile;
  /**
   * 这一页的域名是否在 `detectApplyVendor` 的厂商主机表里。缺省 `false`——
   * **fail-closed**，调用方没表态就当作纯指纹识别出来的页面。
   */
  readonly hostIsKnownAts?: boolean;
}

function emptyRun(plan: ApplyPlan, reason: ApplyErrorCode): ApplyRunSummary {
  const results = plan.entries.map((entry) => ({
    key: entry.key,
    label: entry.label,
    ok: false as const,
    reason,
  }));
  // 没有写入就没有可复核的东西：如实交回同一份结论。
  return {
    results,
    filled: 0,
    failed: results.length,
    abortedBy: null,
    identityDrift: 0,
    labelHintDrifted: 0,
    recheck: () => results,
  };
}

function sameForm(previous: ApplyFormDescriptor | null, next: ApplyFormDescriptor | null): boolean {
  if (!previous || !next || previous.vendor !== next.vendor || previous.fields.length !== next.fields.length) {
    return false;
  }
  return previous.fields.every(
    (field, index) =>
      field.kind === next.fields[index]?.kind && field.element === next.fields[index]?.element,
  );
}

/**
 * Does the undo journal still describe restorable fields?
 *
 * This is deliberately **not** `sameForm`. That predicate answers "is the
 * preview stale", which is true as soon as the host adds or removes a control —
 * and application forms do that constantly ("Do you require sponsorship?" → yes
 * → three new questions appear). Reusing it to decide whether to drop the
 * journal threw away a perfectly restorable history: the recorded elements were
 * all still connected, and `undoAll()` only ever needed `isConnected`.
 *
 * Measured before the fix (2026-08-01): a completed 2-field fill went
 * `undo=2 run=有` → `undo=0 run=null` on the next reconcile while both values
 * stayed in the form. The user saw the Undo button vanish on its own, which is
 * exactly what 铁律 3 / 决策 13 promise cannot happen.
 *
 * The real question is narrower and is about the journal's own entries, not the
 * descriptor: if every recorded element has left the document, nothing can be
 * restored and holding the journal would promise a restore we cannot perform.
 */
function journalStillRestorable(journal: UndoJournal): boolean {
  return journal.hasRestorable();
}

function profileIsEmpty(profile: ApplyProfileDraft): boolean {
  return Object.values(profile).every((value) => !value?.trim());
}

/** Suggestions are untrusted until the candidate accepts one into the editor. */
function normalizeResumeSuggestions(value: ApplyProfileDraft): ApplyProfileDraft | null {
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !(APPLY_FIELD_KEYS as readonly string[]).includes(key))) {
    return null;
  }
  const suggestions: ApplyProfileDraft = {};
  for (const key of APPLY_FIELD_KEYS) {
    const candidate = raw[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== 'string' || !candidate.trim()) return null;
    suggestions[key] = candidate.trim();
  }
  return suggestions;
}

function clonePlan(plan: ApplyPlan | null): ApplyPlan | null {
  return plan
    ? {
        ...plan,
        entries: [...plan.entries],
        skipped: [...plan.skipped],
      }
    : null;
}

function cloneRun(run: ApplyRunSummary | null): ApplyRunSummary | null {
  return run ? { ...run, results: [...run.results] } : null;
}

function cloneUndo(outcome: UndoOutcome | null): UndoOutcome | null {
  return outcome ? { ...outcome } : null;
}

function cloneImportOutcome(
  outcome: ApplyProfileImportOutcome | null,
): ApplyProfileImportOutcome | null {
  return outcome
    ? {
        imported: [...outcome.imported],
        skippedExisting: [...outcome.skippedExisting],
        skippedSuppressed: [...outcome.skippedSuppressed],
      }
    : null;
}

function cloneProfileFieldKeys(keys: readonly ApplyFieldKey[] | null): readonly ApplyFieldKey[] | null {
  return keys ? [...keys] : null;
}

export function createApplySession(input: CreateApplySessionInput): ApplySession {
  const journal = createUndoJournal();
  const listeners = new Set<(state: ApplySessionState) => void>();
  const readProfile = input.readProfile ?? (() => Promise.resolve({ ok: false as const, code: 'PROFILE_UNAVAILABLE' as const }));
  const writeProfile =
    input.writeProfile ??
    (() => Promise.resolve({ ok: false as const, code: 'PROFILE_UNAVAILABLE' as const }));
  const readPolicy = input.loadPolicy ?? (() => loadApplyPolicy());
  const readResumeFileName = input.readResumeFileName ?? (() => Promise.resolve(null));
  let resumeFileName: string | undefined;
  // 已知 ATS 域名视同已确认；其余页面要用户在浮层里单独点一次。
  let resumeHostConfirmed = input.hostIsKnownAts === true;
  // Metadata may arrive while a text-only reviewed plan is executing. That
  // run stays frozen, but its completion must reopen an updated preview so the
  // newly reachable resume row does not disappear behind the result screen.
  let resumePreviewPending = false;
  let policyVersion = 'unresolved';
  let disposed = false;
  let activeRunAbort: AbortController | null = null;
  /**
   * The draft in `state.profile` belongs to the editor. Fill plans must use
   * only this committed server snapshot, otherwise an un-saved resume
   * suggestion or a failed PATCH could reach an employer form.
   */
  let committedProfile: ApplyProfileDraft = {};
  let committedRevision = 0;
  let committedSuppressed = new Set<ApplyFieldKey>();
  let committedResumeDerivationEnabled = false;
  let hasCommittedProfile = false;
  /** Invalidates a late structured-resume response after any profile-state change. */
  let profileSnapshotEpoch = 0;
  /**
   * A resume-review response is meaningful only while its editor interaction
   * is still current. Collapsing the editor explicitly revokes the request,
   * so a late response cannot leave the next opening stuck on "loading".
   */
  let resumeSuggestionRequestEpoch = 0;
  let touchedProfileKeys = new Set<ApplyFieldKey>();
  /**
   * Constructing a session only gives us a launcher. Account values and the
   * retired local draft are intentionally untouched until the candidate opens
   * that launcher: an ATS page merely being detected is not consent to read
   * either L1 source into this tab's memory.
   */
  let initialReadsStarted = false;
  let initialReadsFinished = false;
  let finishInitialReads = (): void => undefined;
  const initialized = new Promise<void>((resolve) => {
    finishInitialReads = () => {
      if (initialReadsFinished) return;
      initialReadsFinished = true;
      resolve();
    };
  });
  // Bump on a real form replacement/disposal. A policy promise that resolves
  // after navigation must not redeem a click against the old form.
  let formEpoch = 0;
  let state: ApplySessionState = {
    phase: 'booting',
    form: null,
    plan: null,
    summary: null,
    profile: {},
    profileStatus: 'loading',
    profileBusy: false,
    profileDirty: false,
    profileError: null,
    profileMigration: null,
    profileMigrationNotice: null,
    legacyImportOutcome: null,
    resumeDerivationEnabled: false,
    writtenButStillSuppressed: null,
    resumeSuggestionStatus: 'idle',
    resumeSuggestionError: null,
    resumeSuggestions: {},
    run: null,
    lastUndo: null,
    undoCount: 0,
    disabledCode: null,
    open: false,
    editing: false,
    confirmingAccountDeletion: false,
    firstRun: false,
    discovered: 0,
    resumeHostConfirmed,
  };

  function snapshot(): ApplySessionState {
    return {
      ...state,
      profile: { ...state.profile },
      resumeSuggestions: { ...state.resumeSuggestions },
      plan: clonePlan(state.plan),
      summary: state.summary ? { ...state.summary } : null,
      run: cloneRun(state.run),
      lastUndo: cloneUndo(state.lastUndo),
      legacyImportOutcome: cloneImportOutcome(state.legacyImportOutcome),
      writtenButStillSuppressed: cloneProfileFieldKeys(state.writtenButStillSuppressed),
    };
  }

  function diagnostics(): ApplyDiagnostic {
    const byCode: Partial<Record<ApplyErrorCode, number>> = {};
    const run = state.run;
    for (const result of run?.results ?? []) {
      if (!result.ok) byCode[result.reason] = (byCode[result.reason] ?? 0) + 1;
    }

    return {
      schemaVersion: 1,
      vendor: input.vendor,
      policyVersion,
      attempted: run?.results.length ?? 0,
      filled: run?.filled ?? 0,
      byCode,
    };
  }

  function emit(): void {
    const next = snapshot();
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        // A renderer bug must not interrupt a user-authorized host write.
      }
    }
  }

  /**
   * 删除冲突的统一作废路径。
   *
   * 服务端刚刚告诉我们"你手上这份档案属于一个已经不存在的世代"。三件事必须一起做：
   * 中止在途填充、作废预览计划、把状态切到 conflict（面板据此显示 Reload）。
   * 少做任何一件，用户都可能把已被删除的资料填进雇主的申请表。
   */
  function invalidateAfterDeletionConflict(code: ApplyProfileAccessErrorCode): void {
    activeRunAbort?.abort();
    activeRunAbort = null;
    formEpoch += 1;
    resumePreviewPending = false;
    state = {
      ...state,
      phase: 'idle',
      profileStatus: 'conflict',
      profileBusy: false,
      profileDirty: true,
      profileError: code,
      profileMigration: null,
      plan: null,
      summary: null,
      firstRun: false,
      discovered: 0,
      run: null,
      lastUndo: null,
      undoCount: journal.size(),
      disabledCode: null,
      editing: true,
    };
    emit();
  }

  function rebuildPreview(): void {
    const { form, profileStatus } = state;
    // A post-read network error must not confiscate the valid snapshot already
    // in this tab. Only lack of any committed snapshot or an explicit 412
    // conflict closes Fill.
    const profileCanPlan = profileStatus === 'ready' && hasCommittedProfile;
    const plan = form && profileCanPlan
      ? buildApplyPlan(form, committedProfile, {
          suppressedKeys: committedSuppressed,
          resumeFileName,
          resumeHostConfirmed,
        })
      : null;
    state = {
      ...state,
      plan,
      summary: plan ? summarizePlan(plan) : null,
      firstRun: profileCanPlan && profileIsEmpty(committedProfile),
      discovered: plan ? plan.entries.length + plan.skipped.length : 0,
      resumeHostConfirmed,
    };
    if (state.phase !== 'filling') resumePreviewPending = false;
  }

  function reopenPendingResumePreview(): boolean {
    if (!resumePreviewPending || state.phase === 'disabled') return false;
    resumePreviewPending = false;
    state = {
      ...state,
      phase: 'idle',
      run: null,
      lastUndo: null,
      undoCount: journal.size(),
      disabledCode: null,
    };
    rebuildPreview();
    emit();
    return true;
  }

  /**
   * Identity drift invalidates the preview the user approved. Ask content to
   * scan again instead of keeping a stale result screen. `sameForm()`
   * deliberately keys journal clearing to element replacement, so a name/type
   * drift on the same nodes does not discard already verified, still-safe Undo
   * entries. A host submission remains a visible result: the form may stay on
   * screen when the submit was cancelled.
   */
  function rescanAfterAbort(): void {
    let form: ApplyFormDescriptor | null;
    try {
      form = input.rescanForm();
    } catch {
      // Parser failure is fail-closed: show no plan and retain no stale ticket.
      form = null;
    }
    const changed = !sameForm(state.form, form);
    if (changed) {
      formEpoch += 1;
      // 预览过期 ≠ 撤销失效。只有已记录的元素全部脱离文档时才丢日志。
      if (!journalStillRestorable(journal)) journal.clear();
    }
    state = {
      ...state,
      form,
      phase: 'idle',
      run: null,
      lastUndo: null,
      // 始终反映日志真实大小。写成 `changed ? 0 : …` 会在日志明明还在时把
        // 撤销按钮藏起来（AutofillTab 用 `undoCount > 0` 决定显不显示），
        // 等于用 UI 抹掉一个仍然可用的能力。
        undoCount: journal.size(),
      disabledCode: null,
    };
    rebuildPreview();
    emit();
  }

  function reportRejected(plan: ApplyPlan, reason: ApplyErrorCode): void {
    if (disposed) return;
    if (reason === 'POLICY_DISABLED') resumePreviewPending = false;
    state = {
      ...state,
      phase: reason === 'POLICY_DISABLED' ? 'disabled' : 'done',
      plan,
      summary: summarizePlan(plan),
      run: emptyRun(plan, reason),
      lastUndo: null,
      undoCount: journal.size(),
      disabledCode: reason === 'POLICY_DISABLED' ? reason : null,
    };
    if (reopenPendingResumePreview()) return;
    emit();
  }

  function normalizeDistinctProfileKeys(value: unknown): ApplyFieldKey[] | null {
    if (!Array.isArray(value)) return null;
    if (
      !value.every(
        (key): key is ApplyFieldKey =>
          typeof key === 'string' && (APPLY_FIELD_KEYS as readonly string[]).includes(key),
      ) ||
      new Set(value).size !== value.length
    ) {
      return null;
    }
    return [...value];
  }

  function normalizeImportOutcome(
    value: ApplyProfileImportOutcome | undefined,
  ): ApplyProfileImportOutcome | null | undefined {
    if (value === undefined) return undefined;
    const imported = normalizeDistinctProfileKeys(value.imported);
    const skippedExisting = normalizeDistinctProfileKeys(value.skippedExisting);
    const skippedSuppressed = normalizeDistinctProfileKeys(value.skippedSuppressed);
    if (!imported || !skippedExisting || !skippedSuppressed) return null;
    const all = [...imported, ...skippedExisting, ...skippedSuppressed];
    if (new Set(all).size !== all.length) return null;
    return { imported, skippedExisting, skippedSuppressed };
  }

  function normalizeProfileValue(value: ApplySessionProfileValue): {
    readonly draft: ApplyProfileDraft;
    readonly revision: number;
    readonly suppressedKeys: ReadonlySet<ApplyFieldKey>;
    readonly resumeDerivationEnabled: boolean;
    readonly legacyImportOutcome?: ApplyProfileImportOutcome;
    readonly writtenButStillSuppressed?: readonly ApplyFieldKey[];
  } | null {
    if (value.migration) return null;
    const revision = value.revision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0) return null;
    const suppressedKeys = normalizeDistinctProfileKeys(value.suppressedKeys ?? []);
    if (!suppressedKeys) return null;
    const resumeDerivationEnabled = value.resumeDerivationEnabled ?? true;
    if (typeof resumeDerivationEnabled !== 'boolean') return null;
    const legacyImportOutcome = normalizeImportOutcome(value.legacyImportOutcome);
    if (legacyImportOutcome === null) return null;
    const writtenButStillSuppressed = normalizeDistinctProfileKeys(value.writtenButStillSuppressed ?? []);
    if (!writtenButStillSuppressed) return null;
    return {
      draft: { ...value.draft },
      revision,
      suppressedKeys: new Set(suppressedKeys),
      resumeDerivationEnabled,
      ...(legacyImportOutcome ? { legacyImportOutcome } : {}),
      ...(value.writtenButStillSuppressed ? { writtenButStillSuppressed } : {}),
    };
  }

  function acceptProfileRead(
    result: ApplyProfileRead,
    options: { readonly preserveEditor?: boolean } = {},
  ): void {
    if (disposed) return;
    if (!result.ok) {
      if (result.legacyLocalDeleted) {
        // Device deletion succeeded even though the account endpoint is not
        // reachable. It must not leave the user trapped behind the old
        // migration screen, nor manufacture an empty account snapshot that
        // could reopen Fill while logged out.
        profileSnapshotEpoch += 1;
        hasCommittedProfile = false;
        committedProfile = {};
        committedRevision = 0;
        committedSuppressed = new Set<ApplyFieldKey>();
        committedResumeDerivationEnabled = false;
        touchedProfileKeys.clear();
        state = {
          ...state,
          phase: state.phase === 'booting' ? 'idle' : state.phase,
          profile: {},
          profileStatus: 'unavailable',
          profileBusy: false,
          profileDirty: false,
          profileError: result.code,
          profileMigration: null,
          profileMigrationNotice: result.migrationNotice ?? null,
          legacyImportOutcome: null,
          resumeDerivationEnabled: false,
          writtenButStillSuppressed: null,
          resumeSuggestionStatus: 'idle',
          resumeSuggestionError: null,
          resumeSuggestions: {},
          plan: null,
          summary: null,
          firstRun: false,
          discovered: 0,
          editing: false,
          confirmingAccountDeletion: false,
        };
        emit();
        return;
      }
      state = {
        ...state,
        phase: state.phase === 'booting' ? 'idle' : state.phase,
        profileStatus: hasCommittedProfile ? 'ready' : 'unavailable',
        profileBusy: false,
        profileError: result.code,
        profileMigration: null,
        profileMigrationNotice: result.migrationNotice ?? null,
      };
      if (!state.run && state.phase !== 'filling') rebuildPreview();
      emit();
      return;
    }

    if (result.value.migration) {
      profileSnapshotEpoch += 1;
      hasCommittedProfile = false;
      committedProfile = {};
      committedRevision = 0;
      committedSuppressed = new Set<ApplyFieldKey>();
      committedResumeDerivationEnabled = false;
      touchedProfileKeys.clear();
      state = {
        ...state,
        phase: state.phase === 'booting' ? 'idle' : state.phase,
        profile: {},
        profileStatus: 'migration',
        profileBusy: false,
        profileDirty: false,
        profileError: null,
        profileMigration: result.value.migration,
        profileMigrationNotice: result.value.migrationNotice ?? null,
        legacyImportOutcome: null,
        resumeDerivationEnabled: false,
        writtenButStillSuppressed: null,
        resumeSuggestionStatus: 'idle',
        resumeSuggestionError: null,
        resumeSuggestions: {},
        plan: null,
        summary: null,
        firstRun: false,
        discovered: 0,
        editing: false,
        confirmingAccountDeletion: false,
      };
      if (!state.run && state.phase !== 'filling') rebuildPreview();
      emit();
      return;
    }

    const normalized = normalizeProfileValue(result.value);
    if (!normalized) {
      state = {
        ...state,
        phase: state.phase === 'booting' ? 'idle' : state.phase,
        profileStatus: hasCommittedProfile ? 'ready' : 'unavailable',
        profileBusy: false,
        profileError: 'INVALID_RESPONSE',
        profileMigration: null,
      };
      if (!state.run && state.phase !== 'filling') rebuildPreview();
      emit();
      return;
    }

    committedProfile = normalized.draft;
    committedRevision = normalized.revision;
    committedSuppressed = new Set(normalized.suppressedKeys);
    committedResumeDerivationEnabled = normalized.resumeDerivationEnabled;
    hasCommittedProfile = true;
    profileSnapshotEpoch += 1;
    const profile = options.preserveEditor ? state.profile : normalized.draft;
    if (!options.preserveEditor) touchedProfileKeys.clear();
    state = {
      ...state,
      phase: state.phase === 'booting' ? 'idle' : state.phase,
      profile: { ...profile },
      profileStatus: 'ready',
      profileBusy: false,
      profileDirty: options.preserveEditor ? touchedProfileKeys.size > 0 : false,
      profileError: null,
      profileMigration: null,
      profileMigrationNotice: result.value.migrationNotice ?? null,
      legacyImportOutcome: normalized.legacyImportOutcome ?? null,
      resumeDerivationEnabled: normalized.resumeDerivationEnabled,
      writtenButStillSuppressed: normalized.writtenButStillSuppressed ?? null,
      // A reloaded/deleted profile changes the comparison base. Do not let a
      // prior resume diff silently survive it as if it had been re-reviewed.
      resumeSuggestionStatus: 'idle',
      resumeSuggestionError: null,
      resumeSuggestions: {},
      // A completed run may keep its historical result and Undo journal, but
      // never its old Fill ticket: a save/reload/delete changes the authority
      // snapshot that ticket was derived from. Undo will rebuild from the
      // newly committed snapshot afterwards.
      plan: null,
      summary: null,
      firstRun: false,
      discovered: 0,
      editing: options.preserveEditor ? true : profileIsEmpty(normalized.draft),
      confirmingAccountDeletion: false,
    };
    if (!state.run && state.phase !== 'filling') rebuildPreview();
    emit();
  }

  function acceptResumeFileNameRead(fileName: string | null): void {
    if (disposed) return;
    const nextFileName = typeof fileName === 'string' && fileName.length > 0 ? fileName : undefined;
    const changed = nextFileName !== resumeFileName;
    resumeFileName = nextFileName;
    if (!changed) return;
    if (state.phase === 'filling') {
      resumePreviewPending = true;
      return;
    }
    if (state.run && state.phase !== 'disabled') {
      resumePreviewPending = true;
      reopenPendingResumePreview();
      return;
    }
    if (!state.run) rebuildPreview();
    emit();
  }

  function startInitialReads(): void {
    if (disposed || initialReadsStarted) return;
    initialReadsStarted = true;
    void Promise.resolve()
      .then(readProfile)
      .catch(() => ({ ok: false as const, code: 'PROFILE_UNAVAILABLE' as const }))
      .then((result) => acceptProfileRead(result))
      .finally(finishInitialReads);
    void Promise.resolve()
      .then(readResumeFileName)
      .catch(() => null)
      .then((fileName) => acceptResumeFileNameRead(fileName));
  }

  return {
    snapshot,
    diagnostics,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    ready() {
      return initialized;
    },
    setForm(form) {
      if (disposed) return;
      const changed = !sameForm(state.form, form);
      if (changed) {
        activeRunAbort?.abort();
        formEpoch += 1;
        if (!journalStillRestorable(journal)) journal.clear();
      }
      state = {
        ...state,
        form,
        phase: changed && state.phase !== 'filling' ? 'idle' : state.phase,
        run: changed ? null : state.run,
        lastUndo: changed ? null : state.lastUndo,
        // 始终反映日志真实大小。写成 `changed ? 0 : …` 会在日志明明还在时把
        // 撤销按钮藏起来（AutofillTab 用 `undoCount > 0` 决定显不显示），
        // 等于用 UI 抹掉一个仍然可用的能力。
        undoCount: journal.size(),
        disabledCode: changed ? null : state.disabledCode,
      };
      if (!state.run && state.phase !== 'filling') rebuildPreview();
      emit();
    },
    setOpen(open) {
      if (disposed || state.open === open) return;
      state = { ...state, open };
      if (open) startInitialReads();
      emit();
    },
    setEditing(editing) {
      if (
        disposed ||
        state.profileStatus !== 'ready' ||
        state.phase === 'filling' ||
        state.profileBusy ||
        state.editing === editing
      ) {
        return;
      }
      if (!editing && state.resumeSuggestionStatus === 'loading') {
        resumeSuggestionRequestEpoch += 1;
        state = {
          ...state,
          editing,
          resumeSuggestionStatus: 'idle',
          resumeSuggestionError: null,
          resumeSuggestions: {},
        };
      } else {
        state = { ...state, editing };
      }
      emit();
    },
    setConfirmingAccountDeletion(confirming) {
      if (
        disposed ||
        state.profileStatus !== 'ready' ||
        state.phase === 'filling' ||
        state.profileBusy ||
        state.confirmingAccountDeletion === confirming
      ) {
        return;
      }
      state = { ...state, confirmingAccountDeletion: confirming };
      emit();
    },
    updateProfileField(key, value) {
      if (
        disposed ||
        state.profileStatus !== 'ready' ||
        state.phase === 'filling' ||
        state.profileBusy
      ) {
        return;
      }
      touchedProfileKeys.add(key);
      state = { ...state, profile: { ...state.profile, [key]: value }, profileDirty: true };
      emit();
    },
    async saveProfile(event, shadowRoot) {
      if (
        disposed ||
        state.profileStatus !== 'ready' ||
        state.phase === 'filling' ||
        state.profileBusy ||
        !isTrustedShadowGesture(event, shadowRoot)
      ) {
        return;
      }
      const profile = { ...state.profile };
      const touched = [...touchedProfileKeys];
      if (touched.length === 0) {
        state = { ...state, profileError: null, profileDirty: false, editing: false };
        emit();
        return;
      }
      state = { ...state, profileBusy: true };
      emit();
      const saved = await writeProfile(profile, touched, committedRevision).catch(() => ({
        ok: false as const,
        code: 'PROFILE_UNAVAILABLE' as const,
      }));
      if (disposed) return;
      if (!saved.ok) {
        // 两种 412 都必须作废计划。删除冲突**更严重**：并发冲突只是"值可能过时"，
        // 删除冲突是"这份档案已经被用户删掉了"——继续拿它去填雇主表单，等于把
        // 用户明确删除的资料又写了出去。
        // 2026-08-10 对抗评审抓到：新错误码只在 API 层分了流，这里仍然只判
        // PROFILE_CONFLICT，于是删除冲突落进下面那条"瞬时失败、保留计划"的分支。
        if (saved.code === 'PROFILE_CONFLICT' || saved.code === 'PROFILE_DELETION_CONFLICT') {
          // A conflict is special: the old plan might contain a value another
          // device just deleted. Preserve the editor for comparison, but do
          // not offer Fill until the candidate explicitly reloads and decides.
          // This branch is also a last-resort race barrier for a save that
          // began immediately before Fill. No old reviewed plan may keep
          // writing after a 412, even if a caller bypassed the disabled UI.
          activeRunAbort?.abort();
          activeRunAbort = null;
          formEpoch += 1;
          resumePreviewPending = false;
          state = {
            ...state,
            phase: 'idle',
            profileStatus: 'conflict',
            profileBusy: false,
            profileDirty: true,
            profileError: saved.code,
            profileMigration: null,
            plan: null,
            summary: null,
            firstRun: false,
            discovered: 0,
            run: null,
            lastUndo: null,
            undoCount: journal.size(),
            disabledCode: null,
            editing: true,
          };
          emit();
          return;
        }
        state = {
          ...state,
          profileStatus: 'ready',
          profileBusy: false,
          profileDirty: true,
          profileError: saved.code,
          // A transient write failure must leave the candidate's editor and
          // the already-committed Fill plan intact for an explicit retry.
          editing: true,
        };
        if (!state.run && state.phase !== 'filling') rebuildPreview();
        emit();
        return;
      }
      acceptProfileRead({
        ok: true,
        value:
          saved.value === undefined
            ? {
                // Compatibility only for unit-test seams. Production always
                // returns the server's post-PATCH snapshot.
                draft: profile,
                revision: committedRevision,
                suppressedKeys: [...committedSuppressed],
              }
            : saved.value,
      });
    },
    async reloadProfile(event, shadowRoot) {
      const canReload =
        state.profileStatus === 'conflict' ||
        state.profileStatus === 'unavailable' ||
        (state.profileStatus === 'ready' && state.profileError !== null);
      if (
        disposed ||
        state.phase === 'filling' ||
        state.profileBusy ||
        !canReload ||
        !isTrustedShadowGesture(event, shadowRoot)
      ) {
        return;
      }
      const preserveEditor = state.profileStatus === 'conflict';
      state = { ...state, profileBusy: true };
      emit();
      const reloaded = await readProfile().catch(() => ({
        ok: false as const,
        code: 'PROFILE_UNAVAILABLE' as const,
      }));
      if (disposed) return;
      acceptProfileRead(reloaded, { preserveEditor });
    },
    async uploadLegacyProfile(event, shadowRoot) {
      if (
        disposed ||
        state.profileStatus !== 'migration' ||
        state.profileMigration !== 'migratable' ||
        state.phase === 'filling' ||
        state.profileBusy ||
        !isTrustedShadowGesture(event, shadowRoot)
      ) {
        return;
      }
      state = { ...state, profileBusy: true };
      emit();
      const uploaded = await (input.uploadLegacyProfile?.() ??
        Promise.resolve({ ok: false as const, code: 'PROFILE_UNAVAILABLE' as const })).catch(() => ({
        ok: false as const,
        code: 'PROFILE_UNAVAILABLE' as const,
      }));
      if (disposed) return;
      if (!uploaded.ok) {
        state = {
          ...state,
          profileStatus: 'migration',
          profileBusy: false,
          profileError: uploaded.code,
          editing: false,
        };
        emit();
        return;
      }
      acceptProfileRead(uploaded);
    },
    async discardLegacyProfile(event, shadowRoot) {
      if (
        disposed ||
        state.profileStatus !== 'migration' ||
        state.phase === 'filling' ||
        state.profileBusy ||
        !isTrustedShadowGesture(event, shadowRoot)
      ) {
        return;
      }
      state = { ...state, profileBusy: true };
      emit();
      const discarded = await (input.discardLegacyProfile?.() ??
        Promise.resolve({ ok: false as const, code: 'PROFILE_UNAVAILABLE' as const })).catch(() => ({
        ok: false as const,
        code: 'PROFILE_UNAVAILABLE' as const,
      }));
      if (disposed) return;
      if (!discarded.ok) {
        if ('legacyLocalDeleted' in discarded && discarded.legacyLocalDeleted) {
          acceptProfileRead(discarded);
          return;
        }
        state = {
          ...state,
          profileStatus: 'migration',
          profileBusy: false,
          profileError: discarded.code,
          editing: false,
        };
        emit();
        return;
      }
      acceptProfileRead(discarded);
    },
    async deleteAccountProfile(event, shadowRoot) {
      if (
        disposed ||
        state.profileStatus !== 'ready' ||
        state.phase === 'filling' ||
        state.profileBusy ||
        !state.confirmingAccountDeletion ||
        !isTrustedShadowGesture(event, shadowRoot)
      ) {
        return;
      }
      state = { ...state, confirmingAccountDeletion: false, profileBusy: true };
      emit();
      const deleted = await (input.deleteAccountProfile?.() ??
        Promise.resolve({ ok: false as const, code: 'PROFILE_UNAVAILABLE' as const })).catch(() => ({
        ok: false as const,
        code: 'PROFILE_UNAVAILABLE' as const,
      }));
      if (disposed) return;
      if (!deleted.ok) {
        // Deletion transport failures must not erase current-tab capability.
        state = {
          ...state,
          profileStatus: 'ready',
          profileBusy: false,
          profileError: deleted.code,
          editing: true,
        };
        if (!state.run && state.phase !== 'filling') rebuildPreview();
        emit();
        return;
      }
      acceptProfileRead(deleted);
    },
    async setResumeDerivation(enabled, event, shadowRoot) {
      if (
        disposed ||
        typeof enabled !== 'boolean' ||
        state.profileStatus !== 'ready' ||
        state.phase === 'filling' ||
        state.profileBusy ||
        !isTrustedShadowGesture(event, shadowRoot)
      ) {
        return;
      }
      state = { ...state, profileBusy: true };
      emit();
      const updated = await (input.setResumeDerivation?.(enabled) ??
        Promise.resolve({ ok: false as const, code: 'PROFILE_UNAVAILABLE' as const })).catch(() => ({
        ok: false as const,
        code: 'PROFILE_UNAVAILABLE' as const,
      }));
      if (disposed) return;
      if (!updated.ok) {
        // 删除冲突不是瞬时失败：它说明服务端那份档案已经不存在了。
        // 这个接口在 43229af 之前根本不可能返回 412（请求体没有任何乐观锁），
        // 带上 expectedDeletionEpoch 之后它可以了——所以这条分支是**新出现**的。
        // 不作废的话：plan 会用删除前的姓名/邮箱/电话重建，profileDirty 不置位，
        // Fill 按钮保持可点，用户一点就把已删除的资料写进雇主表单。
        if (updated.code === 'PROFILE_DELETION_CONFLICT') {
          invalidateAfterDeletionConflict(updated.code);
          return;
        }
        // This is a server-side preference. A failed request must not pretend
        // the previous opt-out changed or invalidate the still-valid plan.
        state = {
          ...state,
          profileStatus: 'ready',
          profileBusy: false,
          profileError: updated.code,
          editing: true,
        };
        if (!state.run && state.phase !== 'filling') rebuildPreview();
        emit();
        return;
      }
      acceptProfileRead(updated);
    },
    async loadResumeSuggestions(event, shadowRoot) {
      if (
        disposed ||
        state.profileStatus !== 'ready' ||
        !state.editing ||
        state.phase === 'filling' ||
        state.profileBusy ||
        state.resumeSuggestionStatus === 'loading' ||
        !isTrustedShadowGesture(event, shadowRoot)
      ) {
        return;
      }
      if (!committedResumeDerivationEnabled) {
        state = {
          ...state,
          resumeSuggestionStatus: 'disabled',
          resumeSuggestionError: null,
          resumeSuggestions: {},
        };
        emit();
        return;
      }
      state = {
        ...state,
        resumeSuggestionStatus: 'loading',
        resumeSuggestionError: null,
        resumeSuggestions: {},
      };
      emit();
      const suggestionProfileEpoch = profileSnapshotEpoch;
      const suggestionRequestEpoch = ++resumeSuggestionRequestEpoch;
      const loaded = await (input.readResumeSuggestions?.() ??
        Promise.resolve({ ok: false as const, code: 'RESUME_UNAVAILABLE' as const })).catch(() => ({
        ok: false as const,
        code: 'PROFILE_UNAVAILABLE' as const,
      }));
      if (
        disposed ||
        profileSnapshotEpoch !== suggestionProfileEpoch ||
        resumeSuggestionRequestEpoch !== suggestionRequestEpoch ||
        state.profileStatus !== 'ready' ||
        !state.editing ||
        !committedResumeDerivationEnabled
      ) {
        return;
      }
      if (!loaded.ok) {
        state = {
          ...state,
          resumeSuggestionStatus: 'unavailable',
          resumeSuggestionError: loaded.code,
          resumeSuggestions: {},
        };
        emit();
        return;
      }
      const suggestions = normalizeResumeSuggestions(loaded.value);
      if (!suggestions) {
        state = {
          ...state,
          resumeSuggestionStatus: 'unavailable',
          resumeSuggestionError: 'INVALID_RESPONSE',
          resumeSuggestions: {},
        };
        emit();
        return;
      }
      const permittedSuggestions: ApplyProfileDraft = {};
      for (const key of APPLY_FIELD_KEYS) {
        const value = suggestions[key];
        // Server-side opt-out is the authority; filtering again here makes a
        // stale or regressed structured endpoint unable to recreate a deleted
        // value through the suggestion → Save path.
        if (value && !committedSuppressed.has(key)) permittedSuggestions[key] = value;
      }
      state = {
        ...state,
        resumeSuggestionStatus: 'ready',
        resumeSuggestionError: null,
        resumeSuggestions: permittedSuggestions,
      };
      emit();
    },
    acceptResumeSuggestion(key, event, shadowRoot) {
      if (
        disposed ||
        state.profileStatus !== 'ready' ||
        state.resumeSuggestionStatus !== 'ready' ||
        state.phase === 'filling' ||
        state.profileBusy ||
        !committedResumeDerivationEnabled ||
        !isTrustedShadowGesture(event, shadowRoot)
      ) {
        return;
      }
      const value = state.resumeSuggestions[key];
      if (!value || committedSuppressed.has(key)) return;
      touchedProfileKeys.add(key);
      const suggestions = { ...state.resumeSuggestions };
      delete suggestions[key];
      state = {
        ...state,
        profile: { ...state.profile, [key]: value },
        profileDirty: true,
        resumeSuggestions: suggestions,
      };
      emit();
    },
    dismissResumeSuggestion(key, event, shadowRoot) {
      if (
        disposed ||
        state.resumeSuggestionStatus !== 'ready' ||
        state.phase === 'filling' ||
        state.profileBusy ||
        !isTrustedShadowGesture(event, shadowRoot)
      ) {
        return;
      }
      if (!state.resumeSuggestions[key]) return;
      const suggestions = { ...state.resumeSuggestions };
      delete suggestions[key];
      state = { ...state, resumeSuggestions: suggestions };
      emit();
    },
    async fill(event, shadowRoot) {
      if (
        disposed ||
        state.phase === 'filling' ||
        state.profileStatus !== 'ready' ||
        state.profileBusy ||
        state.profileDirty ||
        !state.plan
      ) {
        return;
      }
      const reviewedPlan = state.plan;
      const reviewedRoot = state.form?.root;
      if (!reviewedRoot) return;
      // `Event.currentTarget` vanishes after an await. Mint the limited
      // authority while the browser dispatch is still in progress, then only
      // narrow it after policy storage has settled.
      // 最小权限：只申请这份计划真正用得到的能力。铸造时就必须带上——
      // narrowAuthority 只能做减法，事后加不回来。
      const needed = capabilitiesForKinds(reviewedPlan.entries.map((entry) => entry.kind));
      const minted = mintAuthority({
        event,
        shadowRoot,
        purpose: 'fill',
        fingerprint: reviewedPlan.fingerprint,
        capabilities: needed,
      });
      if (!minted.ok) {
        reportRejected(reviewedPlan, minted.code);
        return;
      }

      const operationEpoch = formEpoch;
      // An async C6 verification window must not leave a prior run's Undo
      // control visible while new tickets are still awaiting their verdict.
      state = { ...state, phase: 'filling', run: null, lastUndo: null, disabledCode: null };
      emit();

      let policy: ApplyPolicy;
      try {
        policy = await readPolicy();
        policyVersion = policy.version;
      } catch {
        policyVersion = 'unavailable';
        if (!disposed && formEpoch === operationEpoch) reportRejected(reviewedPlan, 'POLICY_DISABLED');
        return;
      }
      if (disposed || formEpoch !== operationEpoch) return;
      if (!isApplyPolicyEnabled(policy, input.vendor)) {
        reportRejected(reviewedPlan, 'POLICY_DISABLED');
        return;
      }

      const capabilities = new Set(
        [...needed].filter((capability) => policy.capabilities[capability]),
      );
      const narrowed = narrowAuthority(minted.value, capabilities);
      if (!narrowed.ok) {
        reportRejected(reviewedPlan, narrowed.code);
        return;
      }

      const runAbort = new AbortController();
      activeRunAbort = runAbort;
      let run: ApplyRunSummary;
      let ownedRunSlotAtSettlement = false;
      try {
        run = await runApplyPlan({
          plan: reviewedPlan,
          auth: narrowed.value,
          journal,
          root: reviewedRoot,
          policy,
          startMainWorldBridge: input.startMainWorldBridge,
          resolveResumeFile: input.resolveResumeFile,
          signal: runAbort.signal,
        });
      } finally {
        ownedRunSlotAtSettlement = activeRunAbort === runAbort;
        if (ownedRunSlotAtSettlement) activeRunAbort = null;
      }
      if (disposed) return;
      if (formEpoch !== operationEpoch) {
        // clearUndo() already restored a BFCache-safe preview and released this
        // run slot. A resolver that ignores AbortSignal must not later erase a
        // retry (or its result) when its stale promise eventually settles.
        if (!ownedRunSlotAtSettlement) return;
        // setForm() correctly clears the old journal, but before C6 it could
        // not observe a pending async runner. Restore the new page's preview
        // instead of leaving its renderer permanently in "filling".
        state = {
          ...state,
          phase: 'idle',
          run: null,
          lastUndo: null,
          undoCount: journal.size(),
          disabledCode: null,
        };
        resumePreviewPending = false;
        rebuildPreview();
        emit();
        return;
      }
      // 页面在这一轮里变过结构（不连坐之后记在 identityDrift 里）：同样重扫、重新给预览。
      if (run.abortedBy === 'IDENTITY_CHANGED' || run.identityDrift > 0) {
        resumePreviewPending = false;
        rescanAfterAbort();
        return;
      }
      if (reopenPendingResumePreview()) return;
      state = {
        ...state,
        phase: 'done',
        plan: reviewedPlan,
        summary: summarizePlan(reviewedPlan),
        run,
        lastUndo: null,
        undoCount: journal.size(),
        disabledCode: null,
      };
      emit();
    },
    undo(event, shadowRoot) {
      if (disposed || state.phase === 'filling') return;
      const minted = mintAuthority({
        event,
        shadowRoot,
        purpose: 'undo',
        fingerprint: null,
        capabilities: journal.requiredUndoCapabilities(),
      });
      if (!minted.ok) return;
      const operationEpoch = formEpoch;
      const complete = (outcome: UndoOutcome) => {
        if (disposed || formEpoch !== operationEpoch) return;
        state = {
          ...state,
          phase: 'idle',
          run: null,
          lastUndo: outcome,
          undoCount: journal.size(),
          disabledCode: null,
        };
        rebuildPreview();
        emit();
      };
      if (journal.requiredUndoCapabilities().has('set-richtext')) {
        state = { ...state, phase: 'filling' };
        emit();
        void journal.undoAllSettled(minted.value).then(complete);
      } else {
        complete(journal.undoAll(minted.value));
      }
    },
    confirmResumeHost(event, shadowRoot) {
      // filling 期间不接受：那一轮的计划已经冻结、用户已经复核过，中途改变
      // 计划的输入会让"你确认的"和"我们做的"不再是同一件事。
      if (disposed || resumeHostConfirmed || state.phase === 'filling') return;
      if (!isTrustedShadowGesture(event, shadowRoot)) return;
      resumeHostConfirmed = true;
      rebuildPreview();
      emit();
    },
    clearUndo() {
      if (disposed) return;
      const cancellingFill = state.phase === 'filling';
      if (cancellingFill) {
        // pagehide may enter BFCache, so keep the session reusable but revoke
        // every async continuation minted for the page that just became hidden.
        formEpoch += 1;
        activeRunAbort?.abort();
        activeRunAbort = null;
        resumePreviewPending = false;
      }
      journal.clear();
      state = cancellingFill
        ? {
            ...state,
            phase: 'idle',
            run: null,
            lastUndo: null,
            undoCount: 0,
            disabledCode: null,
          }
        : { ...state, undoCount: 0, lastUndo: null };
      if (cancellingFill) rebuildPreview();
      emit();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      finishInitialReads();
      activeRunAbort?.abort();
      activeRunAbort = null;
      formEpoch += 1;
      journal.clear();
      state = { ...state, undoCount: 0, lastUndo: null };
      listeners.clear();
    },
  };
}
