import { setImmediate as yieldEventLoop } from 'node:timers/promises';

/** Buffering and publication boundary for 02 §3.4 / 15 §3.1.
 * The server supplies the reviewer and live turn signal. This module neither
 * authenticates a turn nor implements semantic policy, persistence or retries.
 * Never pass preview `passed_rules` through as approval of arbitrary text. */
export type OutputDecision = 'approve' | 'block' | 'review';
export interface OutputCandidate {
  readonly text: string;
  readonly approvedPrefix: string;
  readonly offset: number;
  readonly final: boolean;
}
export interface ValidatedTextOptions {
  readonly mode: 'sentences' | 'whole';
  readonly signal: AbortSignal;
  readonly maxOutputChars: number;
  readonly maxBufferedChars: number;
  readonly reviewTimeoutMs: number;
  readonly review: (candidate: Readonly<OutputCandidate>, signal: AbortSignal) => Promise<OutputDecision>;
}
export interface ApprovedText {
  readonly type: 'approved_text'; readonly text: string; readonly offset: number;
}
export interface ValidatedTextOutcome {
  readonly status: 'complete' | 'blocked' | 'interrupted';
  readonly reason: null | 'policy_blocked' | 'review_required' | 'review_failed' | 'review_timeout'
    | 'invalid_text' | 'output_limit' | 'buffer_limit' | 'source_failed' | 'cancelled';
  readonly approvedChars: number;
  readonly approvedSegments: number;
}
class OutputStopped extends Error {
  readonly reason: Exclude<ValidatedTextOutcome['reason'], null>;
  constructor(reason: Exclude<ValidatedTextOutcome['reason'], null>) { super('OUTPUT_STREAM_STOPPED'); this.reason = reason; }
}
function stop(reason: Exclude<ValidatedTextOutcome['reason'], null>): never { throw new OutputStopped(reason); }
function bounded(value: number, maximum: number): boolean { return Number.isSafeInteger(value) && value >= 1 && value <= maximum; }
function options(value: ValidatedTextOptions): Readonly<ValidatedTextOptions> {
  if (!value || !['sentences', 'whole'].includes(value.mode) || !(value.signal instanceof AbortSignal)
    || !bounded(value.maxOutputChars, 262144) || !bounded(value.maxBufferedChars, value.maxOutputChars)
    || !bounded(value.reviewTimeoutMs, 60000) || typeof value.review !== 'function') throw new Error('OUTPUT_STREAM_INVALID_OPTIONS');
  return Object.freeze({ ...value });
}
/** Keep a trailing high surrogate until the following provider chunk arrives.
 * No normalization or whitespace trimming: a forwarded speaker stays verbatim. */
function validText(text: string, final: boolean): boolean {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i === text.length - 1) return !final;
      const next = text.charCodeAt(++i); if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The supplied promise may already be scheduled and later reject.
    void work.catch(() => {});
    return Promise.reject(new OutputStopped('cancelled'));
  }
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new OutputStopped('cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    work.then(value => { signal.removeEventListener('abort', cancel); resolve(value); }, error => {
      signal.removeEventListener('abort', cancel); reject(error);
    });
  });
}
/** Text events from this iterator have passed the injected reviewer. They are
 * not yet persisted or authorized for a channel. The caller must perform those
 * steps under its real turn/lease. Stop/rewrite orchestration also belongs there.
 * Sentence mode deliberately retains the last ICU segment for lookahead: `3.`
 * must not publish before a following `14`, nor before closing punctuation.
 * Letters, morning reports and structured deliverables must use whole mode. */
export async function* streamValidatedText(source: AsyncIterable<string>, configuration: ValidatedTextOptions): AsyncGenerator<ApprovedText, ValidatedTextOutcome> {
  const cfg = options(configuration), segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  let iterator: AsyncIterator<string> | undefined;
  let buffer = '', prefix = '', received = 0, segments = 0, pulls = 0, exhausted = false;
  const outcome = (status: ValidatedTextOutcome['status'], reason: ValidatedTextOutcome['reason']): ValidatedTextOutcome =>
    Object.freeze({ status, reason, approvedChars: prefix.length, approvedSegments: segments });
  const active = () => { if (cfg.signal.aborted) stop('cancelled'); };
  const approve = async (text: string, final: boolean): Promise<ApprovedText> => {
    active();
    const controller = new AbortController(), signal = AbortSignal.any([cfg.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), cfg.reviewTimeoutMs);
    let verdict: OutputDecision;
    try {
      verdict = await until(Promise.resolve().then(() => {
        // Cancellation between scheduling and invoking the reviewer must not start it.
        if (signal.aborted) stop('cancelled');
        return cfg.review(Object.freeze({ text, approvedPrefix: prefix, offset: prefix.length, final }), signal);
      }), signal);
    } catch {
      if (cfg.signal.aborted) stop('cancelled');
      if (controller.signal.aborted) stop('review_timeout');
      stop('review_failed');
    } finally { clearTimeout(timer); }
    active();
    if (verdict === 'block') stop('policy_blocked');
    if (verdict === 'review') stop('review_required');
    if (verdict !== 'approve') stop('review_failed');
    const approved = Object.freeze({ type: 'approved_text' as const, text, offset: prefix.length });
    return approved;
  };
  try {
    active();
    iterator = source[Symbol.asyncIterator]();
    while (true) {
      // A stream of immediately resolved (even empty) chunks must not starve
      // the turn deadline, lease heartbeat or cancellation timers.
      if (++pulls % 32 === 0) await until(yieldEventLoop(), cfg.signal);
      let next: IteratorResult<string>;
      try { next = await until(Promise.resolve().then(() => { active(); return iterator!.next(); }), cfg.signal); }
      catch (error) { if (cfg.signal.aborted) stop('cancelled'); if (error instanceof OutputStopped) throw error; stop('source_failed'); }
      active();
      if (next.done) { exhausted = true; break; }
      if (typeof next.value !== 'string') stop('invalid_text');
      received += next.value.length;
      if (received > cfg.maxOutputChars) stop('output_limit');
      const last = buffer.charCodeAt(buffer.length - 1);
      const carry = last >= 0xd800 && last <= 0xdbff ? buffer.slice(-1) : '';
      if (!validText(carry + next.value, false)) stop('invalid_text');
      buffer += next.value;
      if (cfg.mode === 'sentences') {
        // Preserve every code unit, including trailing spaces and CRLF. Holding
        // the last segment prevents a provider chunk from being a sentence boundary.
        const parts = [...segmenter.segment(buffer)];
        for (let i = 0; i < parts.length - 1; i++) {
          if (segments > 0 && segments % 32 === 0) await until(yieldEventLoop(), cfg.signal);
          const candidate = parts[i].segment;
          if (candidate.length > cfg.maxBufferedChars) stop('buffer_limit');
          if (!validText(candidate, true)) stop('invalid_text');
          const approved = await approve(candidate, false);
          buffer = buffer.slice(candidate.length);
          active(); prefix += approved.text; segments++; yield approved; active();
        }
      }
      if (buffer.length > cfg.maxBufferedChars) stop('buffer_limit');
    }
    if (!validText(buffer, true)) stop('invalid_text');
    if (buffer.length) { const approved = await approve(buffer, true); active(); prefix += approved.text; segments++; yield approved; active(); }
    return outcome('complete', null);
  } catch (error) {
    const reason = error instanceof OutputStopped ? error.reason : 'source_failed';
    return outcome(['cancelled', 'source_failed'].includes(reason) ? 'interrupted' : 'blocked', reason);
  } finally {
    // Some provider iterators never finish return() after an interrupted read.
    // Signal cancellation is the caller's transport cancellation mechanism;
    // best-effort iterator cleanup must not hold the user's stop action hostage.
    if (!exhausted && iterator?.return) {
      try { void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* no source text in diagnostics */ }
    }
    buffer = ''; prefix = '';
  }
}
