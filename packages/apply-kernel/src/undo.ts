/**
 * Per-session undo journal.
 *
 * `record()` is the sole issuer of WriteTicket. Because every host writer
 * requires that opaque ticket, a value cannot be written through the supported
 * primitives unless its pre-write state was recorded first.
 *
 * What Undo does **not** cover, stated rather than implied (2026-09-23):
 * choice questions on the fill-first lane are never recorded here — native
 * radio/checkbox groups (`write/choiceGroup.ts` `fillChoiceGroup`) and
 * ARIA-proxied questions alike (`write/proxyChoiceGroup.ts`: Ashby's
 * `button[aria-pressed]` yes/no, Workable's `role=radio` proxies). The
 * fill-first lane freezes product Undo (apps/extension AGENTS, 2026-09-05), and
 * for proxies there is no write we could reverse anyway: the ARIA state is the
 * host's to change and we never write attributes. The only way back would be
 * another host click — possible for a toggle (live Ashby 2026-09-23: clicking
 * the pressed option un-presses it), impossible for a checked `role=radio`
 * (Workable) — and an automatic "un-answer" click is exactly the kind of
 * unreviewed host action this lane does not take. So `undoAll()` leaves those
 * answers as the host shows them, `canUndo()` is false for a run that wrote
 * only them, and the user changes such an answer on the page.
 */

import type {
  ComboboxSemanticUndoTransaction,
  PlainTextContenteditableAttestation,
  Result,
  ScanRoot,
  WriteTicket,
} from './contracts';
export type { WriteTicket } from './contracts';
import { readValue } from './fieldIdentity';
import {
  consumeAuthority,
  checkActiveCapability,
  releaseAuthority,
  type HostWriteAuthority,
  type WriteCapability,
} from './grant';
import { clearHostFile } from './write/setFile';
import { writeSelectIndex, writeSelectValue, writeTextValue } from './write/setValue';
import {
  forgetPlainTextContenteditableTicket,
  hasExactPlainTextContenteditableRestoration,
  restorePlainTextContenteditableTicket,
  sealPlainTextContenteditableTicket,
  settledPlainTextContenteditableRestoration,
} from './write/setPlainTextContenteditable';
import { isCurrentPlainTextContenteditableAttestation } from './rules/plainTextContenteditable';

const TICKET: unique symbol = Symbol('WriteTicket');
const recordedTickets = new WeakMap<WriteTicket, {
  readonly element: Writable;
  readonly context: PlainTextContenteditableUndoContext | undefined;
}>();

/** Runtime brand for the dedicated writer; structural casts cannot mint it. */
export function isRecordedPlainTextContenteditableTicket(
  ticket: WriteTicket,
  element: HTMLElement,
  root: ScanRoot,
  attestation: PlainTextContenteditableAttestation,
): boolean {
  const recorded = recordedTickets.get(ticket);
  return recorded?.element === element && recorded.context?.root === root &&
    recorded.context.attestation === attestation;
}

type Writable = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;

interface UndoEntry {
  readonly ticket: WriteTicket;
  readonly element: Writable;
  readonly previousValue: string;
  /** Needed only for a native select that intentionally had no selection. */
  readonly previousSelectedIndex: number | null;
  /** Written value is needed to avoid overwriting a user's later edit. */
  wroteValue: string | null;
  /** File identity is stricter than name/size: a same-named user file is still theirs. */
  wroteFile: File | null;
  readonly plainTextContenteditable: PlainTextContenteditableUndoContext | null;
  /** Opaque exact semantic state; never replaced by raw input value/index. */
  semanticUndo: ComboboxSemanticUndoTransaction | null;
}

export interface PlainTextContenteditableUndoContext {
  readonly root: ScanRoot;
  readonly attestation: PlainTextContenteditableAttestation;
}

export interface UndoRecordOptions {
  readonly plainTextContenteditable?: PlainTextContenteditableUndoContext;
}

export interface UndoOutcome {
  readonly restored: number;
  readonly skippedUserEdited: number;
  readonly abandonedDetached: number;
  readonly failed: number;
  readonly remaining: number;
}

export interface UndoJournal {
  /** Records the original value and returns the only ticket a fill writer accepts. */
  record(
    element: Writable,
    options?: UndoRecordOptions,
  ): Result<WriteTicket, 'JOURNAL_UNAVAILABLE'>;
  /**
   * Mark a host value that Undo may restore. Usually this is a verified fill;
   * a failed verification may also retain a coerced value, which must not lose
   * the user's explicit way back to the pre-write snapshot.
   */
  /**
   * 宿主结构动作（加行）的票据：没有可恢复的值，只证明日志此刻可用（不在撤销 / 结算中）。
   * 它不进条目——本轮加的行今天没有删行路径可撤，撤销只还原行里写进去的值。
   */
  recordStructuralAction(): Result<WriteTicket, 'JOURNAL_UNAVAILABLE'>;
  commit(ticket: WriteTicket, wroteValue: string): void;
  /** Commit a rule-owned semantic Undo after exact selected-state readback. */
  commitSemantic(ticket: WriteTicket, undo: ComboboxSemanticUndoTransaction): boolean;
  /**
   * Retain the same exact written-state handle after synchronous compensation
   * cannot prove the pre-write state. This is not a success commit, and an
   * unsealed third state receives no retained restore capability.
   */
  retainSemanticFailure(ticket: WriteTicket, undo: ComboboxSemanticUndoTransaction): boolean;
  /** Commit the exact File object attached by this session. It never leaves memory. */
  commitFile(ticket: WriteTicket, wroteFile: File): void;
  /** A failed write must not leave a phantom undo entry behind. */
  abandon(ticket: WriteTicket): void;
  canUndo(): boolean;
  /**
   * Is any recorded field still restorable — i.e. still in the document?
   *
   * The session needs this to decide whether a host-side form change should
   * drop the journal. It must be answered **here** rather than by handing out
   * the entries: an entry carries the pre-write value, which is L1 data
   * (通用铁律 4) and has no business leaving this module.
   *
   * An empty journal is vacuously fine; there is nothing to promise.
   */
  hasRestorable(): boolean;
  size(): number;
  /** Minimal capability set needed to restore currently committed entries. */
  requiredUndoCapabilities(): ReadonlySet<WriteCapability>;
  /** Synchronous compatibility for native controls; rich text requires settlement. */
  undoAll(authority: HostWriteAuthority): UndoOutcome;
  /** Rich-text restoration stays pending until bounded semantic readback completes. */
  undoAllSettled(authority: HostWriteAuthority): Promise<UndoOutcome>;
  clear(): void;
}

function ticket(purpose: WriteTicket['purpose']): WriteTicket {
  // `TICKET` remains a runtime-local marker while the non-exported brand in
  // contracts.ts preserves the compile-time issuer boundary for leaf imports.
  return { [TICKET]: 'write-ticket', purpose } as unknown as WriteTicket;
}

function emptyOutcome(remaining: number): UndoOutcome {
  return {
    restored: 0,
    skippedUserEdited: 0,
    abandonedDetached: 0,
    failed: 0,
    remaining,
  };
}

/**
 * A journal belongs to one mounted autofill session, never to the module. This
 * prevents unrelated tabs/tests from sharing host-node references and lets the
 * content/session owner decide when its lifecycle is over.
 */
export function createUndoJournal(): UndoJournal {
  let entries: UndoEntry[] = [];
  const byTicket = new Map<WriteTicket, UndoEntry>();
  let undoActive = false;
  let settling = false;
  let richSettlementSink: Array<{ entry: UndoEntry; verified: Promise<boolean> }> | null = null;

  function remove(entry: UndoEntry): void {
    recordedTickets.delete(entry.ticket);
    forgetPlainTextContenteditableTicket(entry.ticket);
    try {
      entry.semanticUndo?.dispose();
    } catch {
      // Disposal is best-effort listener cleanup; it never changes the stable
      // restore outcome and must not revive an already retired authority.
    }
    byTicket.delete(entry.ticket);
    entries = entries.filter((candidate) => candidate !== entry);
  }

  const journal: UndoJournal = {
    record(element, options) {
      let issued: WriteTicket | undefined;
      try {
        if (undoActive || settling) return { ok: false, code: 'JOURNAL_UNAVAILABLE' };
        const nativeControl = element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement;
        const richtext = options?.plainTextContenteditable;
        if (
          (nativeControl && richtext) ||
          (!nativeControl && (
            !richtext ||
            !isCurrentPlainTextContenteditableAttestation({
              attestation: richtext.attestation,
              root: richtext.root,
              element,
              purpose: 'fill',
            })
          ))
        ) {
          return { ok: false, code: 'JOURNAL_UNAVAILABLE' };
        }
        issued = ticket('fill');
        recordedTickets.set(issued, { element, context: richtext });
        if (richtext && !sealPlainTextContenteditableTicket(
          issued, element, richtext.root, richtext.attestation,
        )) {
          recordedTickets.delete(issued);
          return { ok: false, code: 'JOURNAL_UNAVAILABLE' };
        }
        const entry: UndoEntry = {
          ticket: issued,
          element,
          previousValue: readValue(element),
          previousSelectedIndex: element instanceof HTMLSelectElement ? element.selectedIndex : null,
          wroteValue: null,
          wroteFile: null,
          plainTextContenteditable: options?.plainTextContenteditable ?? null,
          semanticUndo: null,
        };
        entries.push(entry);
        byTicket.set(issued, entry);
        return { ok: true, value: issued };
      } catch {
        if (issued) {
          recordedTickets.delete(issued);
          forgetPlainTextContenteditableTicket(issued);
        }
        return { ok: false, code: 'JOURNAL_UNAVAILABLE' };
      }
    },
    recordStructuralAction() {
      if (undoActive || settling) return { ok: false, code: 'JOURNAL_UNAVAILABLE' };
      return { ok: true, value: ticket('fill') };
    },
    commit(issued, wroteValue) {
      const entry = byTicket.get(issued);
      if (entry) {
        entry.wroteValue = wroteValue;
        entry.semanticUndo = null;
      }
    },
    commitSemantic(issued, undo) {
      const entry = byTicket.get(issued);
      if (!entry) return false;
      try {
        if (
          !undo ||
          typeof undo.isAtWrittenState !== 'function' ||
          typeof undo.restorePreWrite !== 'function' ||
          typeof undo.isAtPreWriteState !== 'function' ||
          typeof undo.ownsEventTarget !== 'function' ||
          typeof undo.wasUserEdited !== 'function' ||
          typeof undo.dispose !== 'function' ||
          undo.isAtWrittenState() !== true
        ) return false;
      } catch {
        return false;
      }
      entry.wroteValue = null;
      entry.wroteFile = null;
      entry.semanticUndo = undo;
      return true;
    },
    retainSemanticFailure(issued, undo) {
      const entry = byTicket.get(issued);
      if (!entry) return false;
      if (
        !undo ||
        typeof undo.isAtWrittenState !== 'function' ||
        typeof undo.restorePreWrite !== 'function' ||
        typeof undo.isAtPreWriteState !== 'function' ||
        typeof undo.ownsEventTarget !== 'function' ||
        typeof undo.wasUserEdited !== 'function' ||
        typeof undo.dispose !== 'function'
      ) return false;
      entry.wroteValue = null;
      entry.wroteFile = null;
      entry.semanticUndo = undo;
      return true;
    },
    commitFile(issued, wroteFile) {
      const entry = byTicket.get(issued);
      if (entry?.element instanceof HTMLInputElement && entry.element.type === 'file') {
        entry.wroteFile = wroteFile;
      }
    },
    abandon(issued) {
      const entry = byTicket.get(issued);
      if (entry) remove(entry);
    },
    canUndo() {
      return entries.length > 0;
    },
    hasRestorable() {
      return entries.length === 0 || entries.some(
        (entry) => entry.semanticUndo !== null || entry.element.isConnected,
      );
    },
    size() {
      return entries.length;
    },
    requiredUndoCapabilities() {
      return new Set(
        entries.flatMap<WriteCapability>((entry) => {
          if (entry.semanticUndo) return ['set-combobox'];
          if (entry.wroteFile) return ['set-file'];
          if (
            !(entry.element instanceof HTMLInputElement) &&
            !(entry.element instanceof HTMLTextAreaElement) &&
            !(entry.element instanceof HTMLSelectElement)
          ) return ['set-richtext'];
          return [entry.element instanceof HTMLSelectElement ? 'set-select' : 'set-text'];
        }),
      );
    },
    undoAll(authority) {
      if (undoActive || settling) return emptyOutcome(entries.length);
      const consumed = consumeAuthority(authority);
      if (!consumed.ok) return emptyOutcome(entries.length);
      if (authority.purpose !== 'undo') {
        releaseAuthority(authority);
        return emptyOutcome(entries.length);
      }
      undoActive = true;

      let restored = 0;
      let skippedUserEdited = 0;
      let abandonedDetached = 0;
      let failed = 0;
      const remaining: UndoEntry[] = [];

      try {
        for (const entry of [...entries].reverse()) {
          if (byTicket.get(entry.ticket) !== entry) continue;
          if (entry.semanticUndo) {
            const capability = checkActiveCapability(consumed.value, 'set-combobox');
            if (!capability.ok) {
              failed += 1;
              remaining.push(entry);
              continue;
            }
            try {
              if (entry.semanticUndo.wasUserEdited() === true) {
                remove(entry);
                skippedUserEdited += 1;
                continue;
              }
              if (entry.semanticUndo.isAtPreWriteState() === true) {
                remove(entry);
                restored += 1;
                continue;
              }
              // Never overwrite a third semantic state. A normal committed
              // transaction must still be at its exact written seal; a
              // retained failure handle may classify its session-owned
              // residual state as written. Anything else remains visible as a
              // failed Undo item instead of receiving a blind restore click.
              if (entry.semanticUndo.isAtWrittenState() !== true) {
                failed += 1;
                remaining.push(entry);
                continue;
              }
              if (
                entry.semanticUndo.restorePreWrite() === true &&
                entry.semanticUndo.isAtPreWriteState() === true
              ) {
                remove(entry);
                restored += 1;
              } else {
                failed += 1;
                remaining.push(entry);
              }
            } catch {
              failed += 1;
              remaining.push(entry);
            }
            continue;
          }
          if (!entry.element.isConnected) {
            remove(entry);
            abandonedDetached += 1;
            continue;
          }
          if (entry.wroteFile) {
            const currentFile =
              entry.element instanceof HTMLInputElement && entry.element.files?.length === 1
                ? entry.element.files[0]
                : null;
            if (currentFile !== entry.wroteFile) {
              // The candidate cleared or replaced it. Never retain a future
              // capability that might later erase their new selection.
              remove(entry);
              skippedUserEdited += 1;
              continue;
            }
            const restoredFile = clearHostFile({
              element: entry.element as HTMLInputElement,
              expectedFile: entry.wroteFile,
              authority: consumed.value,
              ticket: ticket('restore'),
            });
            if (restoredFile.ok) {
              remove(entry);
              restored += 1;
            } else {
              failed += 1;
              remaining.push(entry);
            }
            continue;
          }
          if (entry.plainTextContenteditable) {
            // A synchronous boolean is not proof against host microtasks.
            // Only the settled path can restore this sealed empty snapshot.
            const result = richSettlementSink === null
              ? null
              : restorePlainTextContenteditableTicket(entry.ticket, consumed.value);
            if (result?.ok) {
              richSettlementSink!.push({ entry, verified: result.value });
            } else {
              failed += 1;
            }
            remaining.push(entry);
            continue;
          }
          if (entry.wroteValue === null || readValue(entry.element) !== entry.wroteValue) {
            skippedUserEdited += 1;
            remaining.push(entry);
            continue;
          }

          const restoreTicket = ticket('restore');
          const result = entry.element instanceof HTMLSelectElement
            ? writeSelectValue(entry.element, entry.previousValue, consumed.value, restoreTicket)
            : entry.element instanceof HTMLInputElement || entry.element instanceof HTMLTextAreaElement
              ? writeTextValue(entry.element, entry.previousValue, consumed.value, restoreTicket)
              : { ok: false as const, code: 'IDENTITY_CHANGED' as const };

          const restoreResult =
            !result.ok &&
            entry.element instanceof HTMLSelectElement &&
            entry.previousValue === '' &&
            entry.previousSelectedIndex === -1
              ? writeSelectIndex(entry.element, -1, consumed.value, restoreTicket)
              : result;

          if (restoreResult.ok) {
            remove(entry);
            restored += 1;
          } else {
            failed += 1;
            remaining.push(entry);
          }
        }
      } finally {
        releaseAuthority(authority);
        undoActive = false;
      }

      entries = remaining.reverse().filter((entry) => byTicket.get(entry.ticket) === entry);
      return { restored, skippedUserEdited, abandonedDetached, failed, remaining: entries.length };
    },
    async undoAllSettled(authority) {
      if (undoActive || settling) return emptyOutcome(entries.length);
      const pending: Array<{ entry: UndoEntry; verified: Promise<boolean> }> = [];
      richSettlementSink = pending;
      let outcome: UndoOutcome;
      try {
        outcome = journal.undoAll(authority);
      } finally {
        richSettlementSink = null;
      }
      settling = true;
      try {
        let restored = outcome.restored;
        let failed = outcome.failed;
        // All setters ran synchronously above, and that authority is already
        // released. The continuation only reads and finalizes exact tickets.
        for (const { entry, verified } of pending) {
          const held = await verified;
          if (byTicket.get(entry.ticket) !== entry) continue;
          if (held && await settledPlainTextContenteditableRestoration(entry.ticket) &&
            hasExactPlainTextContenteditableRestoration(entry.ticket)) {
            remove(entry);
            restored += 1;
          } else {
            failed += 1;
          }
        }
        return { ...outcome, restored, failed, remaining: entries.length };
      } finally {
        settling = false;
      }
    },
    clear() {
      for (const entry of entries) remove(entry);
      entries = [];
      byTicket.clear();
    },
  };
  return journal;
}
