/**
 * Readback verification for a completed write. The pure comparison helpers
 * deliberately reject prefixes and suffixes: a form adding a country code is
 * a mismatch to review, not a successful phone-number write.
 */

import { scheduleHostStep, type HostStep, type HostStepKind } from './hostSchedule';

export type WriteVerification = 'ok' | 'reverted' | 'mismatch' | 'timeout' | 'aborted';

/**
 * The settle watchdog. A visible page whose animation frames never arrive
 * must not turn into an unbounded pending Fill action or a synchronous false
 * green; the runner reports that as VERIFY_TIMEOUT instead.
 *
 * A hidden page (background tab, minimised or occluded window) is different:
 * there frames are suspended by design, so the settle schedule does not wait
 * for them at all (see `settleAfterHostWrite` and `hostSchedule.ts`).
 */
export const WRITE_VERIFICATION_TIMEOUT_MS = 1_000;

/**
 * 看门狗最多续几次：结算一共三步（两帧、一个宏任务），每一步至多续一次。续满了仍没走完，
 * 就照旧以超时收场——最坏 (1 + 3) 个窗口，有界。
 */
const MAX_WATCHDOG_EXTENSIONS = 3;

class WriteVerificationTimeoutError extends Error {
  constructor() {
    super('Host write verification did not settle in time.');
    this.name = 'WriteVerificationTimeoutError';
  }
}

class WriteVerificationAbortedError extends Error {
  constructor() {
    super('Host write verification was aborted.');
    this.name = 'WriteVerificationAbortedError';
  }
}

/**
 * `settleAfterHostWrite` 的看门狗超时。调用方据此报 VERIFY_TIMEOUT——它说的是「网站没来得及确认」，
 * 不能被折成别的失败（从前单选题把它折成了 HOST_REJECTED，浮层写「网站提示格式不对」）。
 */
export function isWriteVerificationTimeout(error: unknown): boolean {
  return error instanceof WriteVerificationTimeoutError;
}

/** Case-fold and discard formatting only; retain every content character. */
export function normalizeComparableValue(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '');
}

/** Exact equality or equality after formatting-only normalisation. */
export function valuesEquivalent(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  const normalizedExpected = normalizeComparableValue(expected);
  const normalizedActual = normalizeComparableValue(actual);
  return (
    normalizedExpected.length === normalizedActual.length && normalizedExpected === normalizedActual
  );
}

/** Digits only; NFKC first so full-width digits count as digits. */
function telDigits(value: string): string {
  return value.normalize('NFKC').replace(/\D+/g, '');
}

/**
 * ITU-T E.164 country calling codes are one to three digits; the leading digits
 * decide the length. This is static numbering-plan data, not vendor DOM
 * knowledge, and it exists only so a tolerated "dropped country code" is the
 * number's actual code rather than an arbitrary 1–3 digit prefix.
 */
const TWO_DIGIT_CALLING_CODES = new Set([
  '20', '27',
  '30', '31', '32', '33', '34', '36', '39',
  '40', '41', '43', '44', '45', '46', '47', '48', '49',
  '51', '52', '53', '54', '55', '56', '57', '58',
  '60', '61', '62', '63', '64', '65', '66',
  '81', '82', '84', '86',
  '90', '91', '92', '93', '94', '95', '98',
]);

function countryCallingCodeLength(digits: string): number | null {
  const first = digits[0];
  if (first === undefined || first === '0') return null;
  if (first === '1' || first === '7') return 1;
  if (TWO_DIGIT_CALLING_CODES.has(digits.slice(0, 2))) return 2;
  return digits.length >= 3 ? 3 : null;
}

/**
 * The national part of a number whose country calling code the value itself
 * declares (`+1 415 555 0142` → `4155550142`).
 *
 * `null` whenever the split is not provably safe: no declared code (a bare
 * national number must never be trimmed), an unknown leading code, or a
 * remainder too short to be a number. The caller then keeps what it had.
 *
 * It lives next to `telValuesEquivalent` on purpose — both read the same
 * `countryCallingCodeLength` numbering-plan table, so "what we may write" and
 * "what we accept back" can never drift apart.
 */
export function nationalPhoneNumber(value: string): string | null {
  const written = value.normalize('NFKC').trim();
  const digits = telDigits(written);
  const international = written.startsWith('+')
    ? digits
    : written.startsWith('00')
      ? digits.slice(2)
      : null;
  if (international === null) return null;
  const codeLength = countryCallingCodeLength(international);
  if (codeLength === null) return null;
  const national = international.slice(codeLength);
  return national.length >= 4 ? national : null;
}

/**
 * The country calling code a number declares itself (`+1 415 555 0142` → `1`,
 * `0049 30 1234567` → `49`); `null` under the same conditions as
 * `nationalPhoneNumber` (no declared code, an unknown leading code, or a
 * remainder too short to be a number). The engine uses it to pick the form's
 * own calling-code option (2026-09-28, Zalando's "Country Code").
 */
export function phoneCallingCode(value: string): string | null {
  const written = value.normalize('NFKC').trim();
  const digits = telDigits(written);
  const international = written.startsWith('+')
    ? digits
    : written.startsWith('00')
      ? digits.slice(2)
      : null;
  if (international === null) return null;
  const codeLength = countryCallingCodeLength(international);
  if (codeLength === null) return null;
  return international.length - codeLength >= 4 ? international.slice(0, codeLength) : null;
}

/**
 * Phone readback: the same number in a different notation is not a coerced
 * value. Workable (intl-tel-input, 2026-09-15 live) and Rippling (2026-09-15
 * live) both move a written `+1` into their own country selector and reformat
 * the national part (`(415) 555-0142`, `415-555-0142`), which the strict
 * formatting-only comparison reports as VALUE_COERCED.
 *
 * Tolerated, and only when the written value declared the code itself
 * (`+` or `00` prefix): the country code dropped from the input, or the
 * national number shown with a `0` trunk prefix (never for code 1, which has
 * none). Never tolerated: a code the profile did not declare being added, a
 * different or truncated national number, or extra digits.
 */
export function telValuesEquivalent(expected: string, actual: string): boolean {
  if (valuesEquivalent(expected, actual)) return true;
  const expectedDigits = telDigits(expected);
  const actualDigits = telDigits(actual);
  if (expectedDigits === '' || actualDigits === '') return false;
  if (expectedDigits === actualDigits) return true;

  const written = expected.normalize('NFKC').trim();
  const international = written.startsWith('+')
    ? expectedDigits
    : written.startsWith('00')
      ? expectedDigits.slice(2)
      : null;
  if (international === null) return false;
  if (actualDigits === international) return true;
  const codeLength = countryCallingCodeLength(international);
  if (codeLength === null) return false;
  const code = international.slice(0, codeLength);
  const national = international.slice(codeLength);
  if (national.length < 4) return false;
  if (actualDigits === national) return true;
  return code !== '1' && actualDigits === `0${national}`;
}

export interface ReadbackOptions {
  /** Phone-like control: accept the same number in another notation. */
  readonly tel?: boolean;
}

export function classifyReadback(
  expected: string,
  previous: string,
  actual: string,
  options: ReadbackOptions = {},
): WriteVerification {
  const equivalent = options.tel ? telValuesEquivalent : valuesEquivalent;
  if (equivalent(expected, actual)) return 'ok';
  if (valuesEquivalent(previous, actual)) return 'reverted';
  return 'mismatch';
}

/**
 * 宿主自己对一个字段值的判决信号。纯数据结构——读 DOM 由调用方负责，
 * 判据留在这里保持可单测（与 dict/guards 的 HoneypotGeometry 同姿势）。
 */
export interface HostValidationSignals {
  /** `aria-invalid` 原值。注意值域不是布尔：还有 grammar / spelling。 */
  readonly ariaInvalid?: string | null;
  /** 约束校验 API：该控件是否参与校验。 */
  readonly willValidate?: boolean;
  /** 约束校验 API 的结论。只在 willValidate 为真时有意义。 */
  readonly valid?: boolean;
  readonly validationMessage?: string;
  /** aria-errormessage / aria-describedby 指向的可见错误文案。 */
  readonly errorText?: string;
}

export type HostValidationVerdict = 'accepted' | 'rejected' | 'unknown';

/**
 * 宿主接不接受这个值。
 *
 * C6 回读判决只回答「我们写的值还在不在」；这个函数回答另一半。缺了它，面板
 * 会报「已填 12/12」而页面上红着四条错误，用户点提交才发现——「回读判决 +
 * 逐字段可审计」最该兑现的地方反而落空。
 *
 * 优先级：宿主自己的 `aria-invalid` > 浏览器约束校验 > 关联错误文案。
 * 把 aria 放在最前，是因为业务规则（"该邮箱已申请过"）浏览器看不见，而宿主
 * 看得见；浏览器只能判格式。
 *
 * **拿不准一律 unknown。** 把「宿主没表态」误报成「宿主拒收」会让本来填好的
 * 字段被重试阶梯反复重写，比不判更糟。
 */
export function classifyHostValidation(signals: HostValidationSignals): HostValidationVerdict {
  const aria = signals.ariaInvalid?.trim().toLowerCase();
  // 值域：true / false / grammar / spelling。后两者是内容提示，不是"不收这个值"。
  if (aria === 'true') return 'rejected';
  if (aria === 'grammar' || aria === 'spelling') return 'unknown';

  // 约束校验只在控件真的参与校验时有意义：disabled / hidden 控件 valid 恒为真，
  // 那是"没表态"不是"接受"。
  if (signals.willValidate === true && signals.valid !== undefined) {
    return signals.valid ? 'accepted' : 'rejected';
  }

  if (aria === 'false') return 'accepted';
  if (signals.errorText !== undefined && signals.errorText.trim() !== '') return 'rejected';
  return 'unknown';
}

/**
 * Let controlled components complete their queued render work before reading
 * back. C6 deliberately uses a microtask, two frames, and one final macro
 * task; a bounded watchdog turns a suspended frame into a typed failure.
 *
 * 页面看不见的时候（2026-09-23 真实 Chrome 实测）：帧整个停掉、计时器被压到约一秒一次。那时
 * 等帧什么也证明不了——宿主自己排在帧上的活同样不跑——所以两帧与最后那个宏任务都换成宿主任务
 * （MessageChannel，不受节流；React 的调度器在后台就是靠它刷新的）；等的途中页面变成看不见，
 * 也立刻换过去。页面看得见时排程逐字不变。见 `hostSchedule.ts`。
 *
 * 看门狗仍是一只 setTimeout——后台里它自己也被节流，只会晚到、不会早到，所以它仍然有界。
 * 它到点时先看一眼再判：
 *  · 还在等帧、页面却已经看不见（`visibilitychange` 被页面拦下没送到）：改等宿主任务，续一个窗口；
 *  · 在等宿主任务、而且自上次起又走完了至少一步：宿主任务是按先后排队跑的，它慢只能是主线程被
 *    宿主的长任务占着、或者整个标签页被冻结过，不是卡死——续一个窗口；
 *  · 其余一律判超时：看得见的页面等不到帧（与从前完全相同），或者宿主任务一整个窗口都没动。
 * 续的次数有上限（MAX_WATCHDOG_EXTENSIONS），最坏 (1 + 3) 个窗口，永远有界。
 */
export function settleAfterHostWrite(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pendingStep: HostStep | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let completedSteps = 0;
    let completedAtLastWindow = 0;
    let extensions = 0;

    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = null;
      pendingStep?.cancel();
      pendingStep = null;
      signal?.removeEventListener('abort', abort);
      outcome();
    };

    function abort() {
      finish(() => reject(new WriteVerificationAbortedError()));
    }
    const timeout = () => finish(() => reject(new WriteVerificationTimeoutError()));
    const onWatchdog = () => {
      watchdog = null;
      if (settled) return;
      const step = pendingStep;
      const movedOffFrame = step?.moveToTaskIfHidden() === true;
      const stalledButAdvancing =
        !movedOffFrame && step?.waitingOn() === 'task' && completedSteps > completedAtLastWindow;
      if ((movedOffFrame || stalledButAdvancing) && extensions < MAX_WATCHDOG_EXTENSIONS) {
        extensions += 1;
        completedAtLastWindow = completedSteps;
        watchdog = setTimeout(onWatchdog, WRITE_VERIFICATION_TIMEOUT_MS);
        return;
      }
      timeout();
    };
    const next = (kind: HostStepKind, then: () => void) => {
      if (settled) return;
      pendingStep = scheduleHostStep(kind, () => {
        pendingStep = null;
        completedSteps += 1;
        then();
      });
    };
    const scheduleFinalMacro = () => next('macrotask', () => finish(resolve));
    const scheduleSecondFrame = () => next('frame', scheduleFinalMacro);
    const scheduleFirstFrame = () => next('frame', scheduleSecondFrame);

    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    watchdog = setTimeout(onWatchdog, WRITE_VERIFICATION_TIMEOUT_MS);
    // Preserve V2's controlled-component microtask grace period, then add
    // C6's stricter double-frame and final-macrotask confirmation window.
    void Promise.resolve().then(scheduleFirstFrame).catch(timeout);
  });
}

export interface VerifyWrittenValueInput {
  readonly expected: string;
  readonly previous: string;
  readonly readCurrent: () => string;
  /** Rich-text material must survive byte-for-character; no formatting equivalence. */
  readonly exact?: boolean;
  /** Phone-like control: a host may reformat the number or move its country code. */
  readonly tel?: boolean;
  /** Optional late structural/identity fence evaluated at the same readback checkpoint. */
  readonly currentIsValid?: () => boolean;
  /** Page/session invalidation cancels every pending frame and forbids a late read. */
  readonly signal?: AbortSignal;
  /** Injectable test seam; the production runner uses the bounded default schedule. */
  readonly settle?: () => Promise<void> | void;
}

function waitForAbortableSettle(operation: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(new WriteVerificationAbortedError());
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      outcome();
    };
    function onAbort() {
      finish(() => reject(new WriteVerificationAbortedError()));
    }
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/** Settle first, then make the readback result the final write verdict. */
export async function verifyWrittenValue(input: VerifyWrittenValueInput): Promise<WriteVerification> {
  if (input.signal?.aborted) return 'aborted';
  try {
    const injectedSettle = input.settle;
    const operation = injectedSettle
      ? Promise.resolve().then(() => {
          if (input.signal?.aborted) throw new WriteVerificationAbortedError();
          return injectedSettle();
        })
      : settleAfterHostWrite(input.signal);
    await waitForAbortableSettle(operation, input.signal);
  } catch (error) {
    if (error instanceof WriteVerificationTimeoutError) return 'timeout';
    if (error instanceof WriteVerificationAbortedError) return 'aborted';
    throw error;
  }
  if (input.signal?.aborted) return 'aborted';
  if (input.currentIsValid && !input.currentIsValid()) return 'mismatch';
  const actual = input.readCurrent();
  if (input.exact) {
    if (actual === input.expected) return 'ok';
    if (actual === input.previous) return 'reverted';
    return 'mismatch';
  }
  return classifyReadback(input.expected, input.previous, actual, { tel: input.tel === true });
}
