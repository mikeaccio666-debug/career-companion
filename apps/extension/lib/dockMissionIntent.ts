import type { ReceiptFieldOutcome } from '@edaix/contracts/draft';
import {
  PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
  createPilotUa5ConnectedPageReady,
} from './pilotUa5ConnectedProtocol';
import { documentPathField, keysBesidesDocumentPath, readDocumentPathname } from './documentPath';

/**
 * Content script → worker, on a Mission-bound page (2026-09-24). Four messages, all
 * value-free: they name the page (the worker checks it against the sender), and carry only
 * canonical keys, stable codes and an opaque ticket. The worker holds every credential,
 * the lease and the Mission; nothing here can nominate one.
 *
 *  - `dock/mission-run-begin`   the dock is about to fill this page: record the run.
 *  - `dock/mission-run-finish`  the fill ended: report the claimed keys' outcomes.
 *  - `dock/mission-cover-letter` the form wants a cover letter: its text, or a refusal.
 *  - `dock/submit-confirmed`    the site confirmed a submission from this page.
 */

type PageIntent = Readonly<{
  version: typeof PILOT_UA5_CONNECTED_PROTOCOL_VERSION;
  origin: string;
  pathname: string;
  /** Where the SPA document loaded, when it has since moved (sender check uses it). */
  documentPathname?: string;
}>;

export type DockMissionRunBeginIntent = PageIntent & Readonly<{
  kind: 'dock/mission-run-begin';
  fieldKeys: readonly string[];
  vendor: string;
}>;

export type DockMissionRunFinishIntent = PageIntent & Readonly<{
  kind: 'dock/mission-run-finish';
  ticket: string;
  outcomes: readonly Pick<ReceiptFieldOutcome, 'key' | 'ok' | 'reason'>[];
}>;

export const DOCK_MISSION_COVER_LETTER_TRIGGERS = ['FORM_REQUIRED', 'USER_REQUEST'] as const;
export type DockMissionCoverLetterTrigger = (typeof DOCK_MISSION_COVER_LETTER_TRIGGERS)[number];

export type DockMissionCoverLetterIntent = PageIntent & Readonly<{
  kind: 'dock/mission-cover-letter';
  trigger: DockMissionCoverLetterTrigger;
}>;

export type DockSubmitConfirmedIntent = PageIntent & Readonly<{ kind: 'dock/submit-confirmed' }>;

export type DockMissionRunBeginReply =
  | Readonly<{ kind: 'MISSION_RUN'; ticket: string }>
  | Readonly<{ kind: 'NO_RUN'; code: string }>;

export type DockMissionCoverLetterReply =
  | Readonly<{ kind: 'COVER_LETTER_TEXT'; text: string }>
  | Readonly<{ kind: 'REFUSED'; code: string }>;

const MAX_KEYS = 64;
const MAX_OUTCOMES = 400;
const KEY = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
const TICKET = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VENDOR = /^[a-z][a-z0-9-]{0,31}$/;
/** Same bound as the Mission materials entry's letter text. */
const MAX_LETTER_TEXT_LENGTH = 12_000;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = keysBesidesDocumentPath(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

/** The page part every message shares, checked with the page-identity rules. */
function parsePage(candidate: Record<string, unknown>): PageIntent | null {
  if (
    candidate['version'] !== PILOT_UA5_CONNECTED_PROTOCOL_VERSION ||
    typeof candidate['origin'] !== 'string' ||
    typeof candidate['pathname'] !== 'string'
  ) return null;
  const ready = createPilotUa5ConnectedPageReady(candidate['origin'], candidate['pathname']);
  if (ready === null) return null;
  const loaded = readDocumentPathname(candidate, ready.origin);
  if (loaded === null) return null;
  return Object.freeze({
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin: ready.origin,
    pathname: ready.pathname,
    ...documentPathField(loaded, ready.pathname),
  });
}

export function parseDockMissionRunBeginIntent(value: unknown): DockMissionRunBeginIntent | null {
  if (!record(value) || value['kind'] !== 'dock/mission-run-begin') return null;
  if (!exactKeys(value, ['kind', 'version', 'origin', 'pathname', 'fieldKeys', 'vendor'])) return null;
  const page = parsePage(value);
  const keys = value['fieldKeys'];
  const vendor = value['vendor'];
  if (
    page === null ||
    !Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS ||
    !keys.every((key) => typeof key === 'string' && KEY.test(key)) ||
    typeof vendor !== 'string' || !VENDOR.test(vendor)
  ) return null;
  return Object.freeze({
    kind: 'dock/mission-run-begin',
    ...page,
    fieldKeys: Object.freeze([...new Set(keys as string[])].sort()),
    vendor,
  });
}

export function createDockMissionRunBeginIntent(
  origin: string,
  pathname: string,
  fieldKeys: readonly string[],
  vendor: string,
): DockMissionRunBeginIntent | null {
  return parseDockMissionRunBeginIntent({
    kind: 'dock/mission-run-begin',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin,
    pathname,
    fieldKeys: [...fieldKeys],
    vendor,
  });
}

export function parseDockMissionRunFinishIntent(value: unknown): DockMissionRunFinishIntent | null {
  if (!record(value) || value['kind'] !== 'dock/mission-run-finish') return null;
  if (!exactKeys(value, ['kind', 'version', 'origin', 'pathname', 'ticket', 'outcomes'])) return null;
  const page = parsePage(value);
  const ticket = value['ticket'];
  const outcomes = value['outcomes'];
  if (page === null || typeof ticket !== 'string' || !TICKET.test(ticket)) return null;
  if (!Array.isArray(outcomes) || outcomes.length > MAX_OUTCOMES) return null;
  const parsed: Pick<ReceiptFieldOutcome, 'key' | 'ok' | 'reason'>[] = [];
  for (const outcome of outcomes) {
    if (!record(outcome)) return null;
    const names = Object.keys(outcome);
    if (!names.every((name) => name === 'key' || name === 'ok' || name === 'reason')) return null;
    const key = outcome['key'];
    const ok = outcome['ok'];
    const reason = outcome['reason'];
    if (typeof key !== 'string' || !KEY.test(key) || typeof ok !== 'boolean') return null;
    if (reason !== undefined && (typeof reason !== 'string' || !CODE.test(reason))) return null;
    parsed.push(Object.freeze({
      key,
      ok,
      ...(reason === undefined ? {} : { reason: reason as ReceiptFieldOutcome['reason'] }),
    }));
  }
  return Object.freeze({ kind: 'dock/mission-run-finish', ...page, ticket, outcomes: Object.freeze(parsed) });
}

export function createDockMissionRunFinishIntent(
  origin: string,
  pathname: string,
  ticket: string,
  outcomes: readonly ReceiptFieldOutcome[],
): DockMissionRunFinishIntent | null {
  return parseDockMissionRunFinishIntent({
    kind: 'dock/mission-run-finish',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin,
    pathname,
    ticket,
    // Keys and stable codes only: the source tag and anything else stay in the page. An entry
    // this message cannot carry is left out rather than costing the whole receipt: the worker
    // reports the claimed Profile keys only.
    outcomes: outcomes
      .filter((outcome) => KEY.test(outcome.key))
      .slice(0, MAX_OUTCOMES)
      .map((outcome) => ({
        key: outcome.key,
        ok: outcome.ok,
        ...(outcome.reason === undefined || !CODE.test(outcome.reason) ? {} : { reason: outcome.reason }),
      })),
  });
}

export function parseDockMissionCoverLetterIntent(value: unknown): DockMissionCoverLetterIntent | null {
  if (!record(value) || value['kind'] !== 'dock/mission-cover-letter') return null;
  if (!exactKeys(value, ['kind', 'version', 'origin', 'pathname', 'trigger'])) return null;
  const page = parsePage(value);
  const trigger = value['trigger'];
  if (page === null || !(DOCK_MISSION_COVER_LETTER_TRIGGERS as readonly unknown[]).includes(trigger)) return null;
  return Object.freeze({
    kind: 'dock/mission-cover-letter',
    ...page,
    trigger: trigger as DockMissionCoverLetterTrigger,
  });
}

export function createDockMissionCoverLetterIntent(
  origin: string,
  pathname: string,
  trigger: DockMissionCoverLetterTrigger,
): DockMissionCoverLetterIntent | null {
  return parseDockMissionCoverLetterIntent({
    kind: 'dock/mission-cover-letter',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin,
    pathname,
    trigger,
  });
}

export function parseDockSubmitConfirmedIntent(value: unknown): DockSubmitConfirmedIntent | null {
  if (!record(value) || value['kind'] !== 'dock/submit-confirmed') return null;
  if (!exactKeys(value, ['kind', 'version', 'origin', 'pathname'])) return null;
  const page = parsePage(value);
  return page === null ? null : Object.freeze({ kind: 'dock/submit-confirmed', ...page });
}

export function createDockSubmitConfirmedIntent(origin: string, pathname: string): DockSubmitConfirmedIntent | null {
  return parseDockSubmitConfirmedIntent({
    kind: 'dock/submit-confirmed',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin,
    pathname,
  });
}

export function parseDockMissionRunBeginReply(value: unknown): DockMissionRunBeginReply | null {
  if (!record(value)) return null;
  if (value['kind'] === 'MISSION_RUN' && typeof value['ticket'] === 'string' && TICKET.test(value['ticket'])) {
    return Object.freeze({ kind: 'MISSION_RUN', ticket: value['ticket'] });
  }
  if (value['kind'] === 'NO_RUN' && typeof value['code'] === 'string' && CODE.test(value['code'])) {
    return Object.freeze({ kind: 'NO_RUN', code: value['code'] });
  }
  return null;
}

export function parseDockMissionCoverLetterReply(value: unknown): DockMissionCoverLetterReply | null {
  if (!record(value)) return null;
  if (
    value['kind'] === 'COVER_LETTER_TEXT' &&
    typeof value['text'] === 'string' &&
    value['text'].trim() !== '' &&
    value['text'].length <= MAX_LETTER_TEXT_LENGTH
  ) {
    return Object.freeze({ kind: 'COVER_LETTER_TEXT', text: value['text'] });
  }
  if (value['kind'] === 'REFUSED' && typeof value['code'] === 'string' && CODE.test(value['code'])) {
    return Object.freeze({ kind: 'REFUSED', code: value['code'] });
  }
  return null;
}
