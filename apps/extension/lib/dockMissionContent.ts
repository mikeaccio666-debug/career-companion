import type { ApplyFormDescriptor } from '@edaix/apply-kernel/contracts';
import { isCoverLetterField } from '@edaix/apply-kernel/guards';
import type { ReceiptFieldOutcome } from '@edaix/contracts/draft';
import {
  createDockMissionCoverLetterIntent,
  createDockMissionRunBeginIntent,
  createDockMissionRunFinishIntent,
  createDockSubmitConfirmedIntent,
  parseDockMissionCoverLetterReply,
  parseDockMissionRunBeginReply,
  type DockMissionCoverLetterTrigger,
} from './dockMissionIntent';
import { pageSaysSubmitted } from './submitController';

/**
 * Content-script side of the dock Mission wiring (2026-09-24). Only on a page bound to a
 * Mission the user started in the portal (the READY face). It asks the worker to record
 * the run, fetch the cover letter the form needs and report a confirmed submission; the
 * fill itself stays the gesture engine's, and never waits long on any of this.
 */

/** How long a dock run waits for the Mission's record before filling anyway. */
export const MISSION_RUN_WAIT_MS = 4_000;
/** How long the next page keeps looking for the site's confirmation after a 提交. */
const ARRIVAL_CONFIRMATION_WAIT_MS = 6_000;
const ARRIVAL_CONFIRMATION_POLL_MS = 500;

type PageRef = Readonly<{ origin: string; pathname: string }>;
type Send = (message: unknown) => Promise<unknown>;
/** Adds the loaded-document path when a single-page app changed the address (sender check). */
type Wrap = <T extends object>(intent: T | null) => T | null;

export interface DockMissionSession {
  /** Record this run for the page's Mission; resolves to its ticket, or null (no record). */
  begin(scan: Readonly<{ fieldKeys: readonly string[]; vendor: string | null }>): Promise<string | null>;
  /** The run's outcomes for the claimed keys; the worker files the receipt. */
  finish(ticket: string, outcomes: readonly ReceiptFieldOutcome[]): void;
  /** The Mission's cover letter as text, generated if the Mission has none yet. */
  coverLetter(trigger: DockMissionCoverLetterTrigger): Promise<string | null>;
  /** The site confirmed the submission from this page. */
  confirmSubmitted(): void;
  /**
   * The dock just pressed the site's final submit for the user (his 提交 in the dock):
   * once the site confirms on this page, report it. Any other outcome reports nothing.
   */
  afterDockSubmit(outcome: Promise<unknown>): void;
  /** A page reached right after 提交: report once the site's confirmation shows. */
  confirmArrival(doc: Document): void;
}

export function createDockMissionSession(deps: Readonly<{
  send: Send;
  page: () => PageRef;
  wrap: Wrap;
  wait?: (ms: number) => Promise<void>;
}>): DockMissionSession {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const ask = async (intent: object | null): Promise<unknown> => {
    const wrapped = deps.wrap(intent);
    if (wrapped === null) return null;
    try {
      return await deps.send(wrapped);
    } catch {
      return null;
    }
  };
  const confirmSubmitted = (): void => {
    const { origin, pathname } = deps.page();
    void ask(createDockSubmitConfirmedIntent(origin, pathname));
  };
  const session: DockMissionSession = {
    async begin(scan) {
      if (scan.vendor === null || scan.fieldKeys.length === 0) return null;
      const { origin, pathname } = deps.page();
      const reply = parseDockMissionRunBeginReply(
        await ask(createDockMissionRunBeginIntent(origin, pathname, scan.fieldKeys, scan.vendor)),
      );
      return reply?.kind === 'MISSION_RUN' ? reply.ticket : null;
    },
    finish(ticket, outcomes) {
      const { origin, pathname } = deps.page();
      void ask(createDockMissionRunFinishIntent(origin, pathname, ticket, outcomes));
    },
    async coverLetter(trigger) {
      const { origin, pathname } = deps.page();
      const reply = parseDockMissionCoverLetterReply(
        await ask(createDockMissionCoverLetterIntent(origin, pathname, trigger)),
      );
      return reply?.kind === 'COVER_LETTER_TEXT' ? reply.text : null;
    },
    confirmSubmitted,
    afterDockSubmit(outcome) {
      void outcome.then((settled) => { if (settled === 'SUBMITTED') confirmSubmitted(); }, () => {});
    },
    confirmArrival(doc) {
      void (async () => {
        for (let waited = 0; waited <= ARRIVAL_CONFIRMATION_WAIT_MS; waited += ARRIVAL_CONFIRMATION_POLL_MS) {
          if (pageSaysSubmitted(doc)) {
            confirmSubmitted();
            return;
          }
          await wait(ARRIVAL_CONFIRMATION_POLL_MS);
        }
      })();
    },
  };
  return Object.freeze(session);
}

/**
 * Whether this form asks for a cover letter the kernel can type (a textarea or plain-text
 * editor named as one), and whether it insists. File-only letter fields are not counted:
 * the dock does not upload a letter file (yet), so writing one would be charged for nothing.
 */
export function coverLetterDemand(descriptor: ApplyFormDescriptor): 'REQUIRED' | 'OPTIONAL' | 'NONE' {
  let demand: 'REQUIRED' | 'OPTIONAL' | 'NONE' = 'NONE';
  for (const field of descriptor.fields) {
    const element = field.element;
    const typable = field.kind === 'textarea'
      ? isCoverLetterField(field.label, [
          element.getAttribute('name'),
          element.getAttribute('id'),
          element.getAttribute('data-automation-id'),
          element.getAttribute('data-ui'),
          element.getAttribute('data-qa'),
          element.getAttribute('data-testid'),
          element.getAttribute('aria-label'),
          element.getAttribute('placeholder'),
        ])
      : field.kind === 'richtext' && field.plainTextContenteditableAttestation?.purpose === 'cover-letter';
    if (!typable) continue;
    if (field.required) return 'REQUIRED';
    demand = 'OPTIONAL';
  }
  return demand;
}

/** Settles with the promise, or with null once `ms` passed; the promise itself runs on. */
export function withinBudget<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => { setTimeout(() => resolve(null), ms); })]);
}
