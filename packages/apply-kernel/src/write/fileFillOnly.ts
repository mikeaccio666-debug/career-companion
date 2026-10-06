/**
 * One prepared, fill-only resume File attachment. No download, journal or restore.
 *
 * The caller supplies a verified in-memory File, exact rule/target binding and a
 * monotonic trusted-user edit epoch. Neither a File nor a successful readback
 * grants permission: active set-file authority, fresh source/execution approval
 * and the caller's page/Submit/lease fence must all remain valid.
 */
import type { ApplyErrorCode, ScanRoot } from '../contracts.ts';
import { checkActiveCapability, type HostWriteAuthority } from '../grant.ts';
import type { ApplyPolicy } from '../policy.ts';
import {
  consumeFillOnlyHostWriteAuthority,
  executeFillOnlySemanticWrite,
  type FillOnlySemanticResult,
} from './fillOnlySemantic.ts';
import {
  hasSafeResumeFileIdentity,
  isApprovedResumeFileTarget,
  matchesFileAccept,
} from './setFile.ts';
import type { HostValidationSignals } from './verify.ts';

export interface ResumeFileFillOnlyInput {
  readonly authority: HostWriteAuthority;
  readonly policy: ApplyPolicy;
  readonly authorizeWrite: () => Promise<boolean>;
  readonly executionFence: () => ApplyErrorCode | null;
  /** Must represent actual host upload/parse acceptance, not only local files. */
  readonly readHostValidation: (target: HTMLInputElement) => HostValidationSignals;
  readonly lateRecheckMs: number;
  readonly operationTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly settle?: (signal?: AbortSignal) => Promise<void> | void;
  readonly lateRecheckDelay?: (milliseconds: number, signal?: AbortSignal) => Promise<void> | void;
}

export interface ResumeFileFillOnlyTransaction {
  readonly isEmpty: () => boolean;
  readonly isAtAnswer: () => boolean;
  readonly fillOnly: (input: ResumeFileFillOnlyInput) => Promise<FillOnlySemanticResult>;
}

/** Local resource ceiling; the caller must also supply its stricter approved limit. */
export const RESUME_FILE_FILL_ONLY_MAX_BYTES = 10 * 1024 * 1024;

export function prepareResumeFileFillOnly(input: Readonly<{
  target: HTMLInputElement;
  file: File;
  root: ScanRoot;
  maximumFileBytes: number;
  exactTargetCurrent: () => boolean;
  /** Caller-owned trusted events only; this writer's synthetic change is not a user edit. */
  getTrustedUserEditEpoch: () => number;
}>): ResumeFileFillOnlyTransaction | null {
  try {
    const { target, file, root, maximumFileBytes } = input;
    const document = target.ownerDocument;
    const view = document.defaultView;
    if (!view || !(target instanceof view.HTMLInputElement) || !(file instanceof view.File) ||
        typeof input.exactTargetCurrent !== 'function' ||
        typeof input.getTrustedUserEditEpoch !== 'function' ||
        !Number.isSafeInteger(maximumFileBytes) || maximumFileBytes <= 0 ||
        maximumFileBytes > RESUME_FILE_FILL_ONLY_MAX_BYTES ||
        !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > maximumFileBytes ||
        target.multiple || !isApprovedResumeFileTarget(target, root) ||
        !matchesFileAccept(target.getAttribute('accept') ?? '', file)) return null;

    const fileMetadata = Object.freeze([file.name, file.type, file.size, file.lastModified]);
    const epoch = input.getTrustedUserEditEpoch();
    if (!Number.isSafeInteger(epoch) || epoch < 0) return null;
    const descriptor = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'files');
    const getFiles = descriptor?.get;
    const setFiles = descriptor?.set;
    const connected = Object.getOwnPropertyDescriptor(view.Node.prototype, 'isConnected')?.get;
    const dispatch = view.EventTarget.prototype.dispatchEvent;
    const EventConstructor = view.Event;
    const TransferConstructor = view.DataTransfer;
    if (!getFiles || !setFiles || !connected || typeof dispatch !== 'function' ||
        typeof TransferConstructor !== 'function') return null;

    const parent = target.parentNode;
    const tree = target.getRootNode();
    const form = target.form;
    const attributes = Object.freeze([
      'id', 'name', 'type', 'accept', 'multiple', 'disabled', 'readonly', 'required',
      'aria-disabled', 'aria-readonly',
    ].map((key) => Object.freeze([key, target.getAttribute(key)] as const)));
    let consumed = false;
    const readFiles = (): FileList | null => {
      try {
        const files: unknown = getFiles.call(target);
        // The list comes only from the captured native input accessor, never
        // from a caller-provided readback. Ownership is the exact File object,
        // not the prototype of a DOM collection.
        return files !== null && typeof files === 'object' ? files as FileList : null;
      } catch { return null; }
    };
    const empty = (): boolean => {
      try {
        const files = readFiles();
        return files !== null && files.length === 0;
      } catch { return false; }
    };
    const atAnswer = (): boolean => {
      try {
        const files = readFiles();
        return files !== null && files.length === 1 && files[0] === file;
      } catch { return false; }
    };
    const nativeIdentityCurrent = (): boolean => {
      try {
        return connected.call(target) === true && target.ownerDocument === document &&
          target.parentNode === parent && target.getRootNode() === tree && target.form === form &&
          target.type === 'file' && !target.disabled && !target.matches(':disabled') &&
          !target.readOnly && !target.multiple &&
          (target.getAttribute('aria-disabled') ?? '').trim().toLowerCase() !== 'true' &&
          (target.getAttribute('aria-readonly') ?? '').trim().toLowerCase() !== 'true' &&
          attributes.every(([key, value]) => target.getAttribute(key) === value);
      } catch { return false; }
    };
    const sourceAndTargetCurrent = (): boolean => {
      try {
        return input.exactTargetCurrent() === true && input.getTrustedUserEditEpoch() === epoch &&
          [file.name, file.type, file.size, file.lastModified].every((value, index) => value === fileMetadata[index]) &&
          hasSafeResumeFileIdentity(target, root) && nativeIdentityCurrent();
      } catch { return false; }
    };
    if (!sourceAndTargetCurrent()) return null;

    return Object.freeze({
      isEmpty: () => !consumed && sourceAndTargetCurrent() && empty(),
      isAtAnswer: () => !consumed && sourceAndTargetCurrent() && atAnswer(),
      async fillOnly(fill: ResumeFileFillOnlyInput): Promise<FillOnlySemanticResult> {
        if (consumed) return Object.freeze({ ok: false, code: 'CAPABILITY_DISABLED' });
        consumed = true;
        const grantFence = (): ApplyErrorCode | null => {
          if (fill.authority.purpose !== 'fill') return 'CAPABILITY_DISABLED';
          if (fill.policy.enabled !== true) return 'POLICY_DISABLED';
          if (fill.policy.capabilities['set-file'] !== true) return 'CAPABILITY_DISABLED';
          const permission = checkActiveCapability(fill.authority, 'set-file');
          return permission.ok ? null : permission.code;
        };
        const executionFence = (): ApplyErrorCode | null => {
          try {
            if (fill.signal?.aborted) return 'ABORTED';
            const permission = grantFence();
            if (permission !== null) return permission;
            const current = fill.executionFence();
            if (fill.signal?.aborted) return 'ABORTED';
            // Caller proof code can release the active grant while returning
            // a current-looking answer. Never retain permission across it.
            return current === null ? grantFence() : current;
          } catch { return 'CAPABILITY_DISABLED'; }
        };
        const targetFence = (): ApplyErrorCode | null =>
          sourceAndTargetCurrent() ? null : 'IDENTITY_CHANGED';
        const terminalStateCurrent = (written: boolean): boolean => {
          // The final execution callback can change labels, source bindings or
          // the user's FileList while returning null. Re-prove the target and
          // expected native state after it; no execution callback follows this
          // proof before the setter or event dispatch.
          if (!sourceAndTargetCurrent() ||
              (!written && !isApprovedResumeFileTarget(target, root)) ||
              input.getTrustedUserEditEpoch() !== epoch || grantFence() !== null) return false;
          return hasSafeResumeFileIdentity(target, root) && nativeIdentityCurrent() &&
            (written ? atAnswer() : empty()) && !fill.signal?.aborted;
        };
        const forwardCurrent = (): boolean => {
          try {
            if (executionFence() !== null || targetFence() !== null) return false;
            // The visible trigger may disappear after the host starts uploading;
            // it is a pre-write proof, not a post-upload identity requirement.
            if (!isApprovedResumeFileTarget(target, root) || !empty()) return false;
            if (executionFence() !== null || fill.signal?.aborted) return false;
            return terminalStateCurrent(false);
          } catch { return false; }
        };

        return executeFillOnlySemanticWrite({
          authorizeWrite: fill.authorizeWrite,
          executionFence,
          targetFence,
          isAtPreWriteState: empty,
          isAtWrittenState: atAnswer,
          writeForward: (authority) => {
            // Materialize the FileList before the final callback-capable proofs.
            const transfer = new TransferConstructor();
            transfer.items.add(file);
            const files = transfer.files;
            if (files.length !== 1 || files[0] !== file || !forwardCurrent() ||
                !consumeFillOnlyHostWriteAuthority(authority)) return false;
            setFiles.call(target, files);
            if (!atAnswer() || executionFence() !== null || targetFence() !== null ||
                executionFence() !== null) return false;
            const event = new EventConstructor('change', { bubbles: true, composed: true });
            // Event construction is callback-capable too; do not carry a prior
            // grant across it or emit any event after Submit/retarget/reupload.
            if (executionFence() !== null || targetFence() !== null || !atAnswer() ||
                executionFence() !== null || !terminalStateCurrent(true)) return false;
            Reflect.apply(dispatch, target, [event]);
            return atAnswer();
          },
          readHostValidation: () => fill.readHostValidation(target),
          lateRecheckMs: fill.lateRecheckMs,
          operationTimeoutMs: fill.operationTimeoutMs,
          signal: fill.signal,
          settle: fill.settle,
          lateRecheckDelay: fill.lateRecheckDelay,
        });
      },
    });
  } catch { return null; }
}
