/**
 * UA-5 vertical composition — DRAFT wire.
 *
 * One authenticated call composes the rungs that already exist: UA-2 classifies
 * the certified UA-1 packet, UA-3 mints the exact-page candidate, #164's
 * compiler derives the logical questions, and UA-4 issues the write authority.
 * The extension then drives the sole UA-4 composition port with the result.
 *
 * The response carries only what a value-free chain may carry: digests,
 * ordinals, booleans and closed sets. No raw answer value, no page HTML, no
 * selector, no token. It grants no Submit: every constraint the rungs already
 * publish is restated here so a consumer cannot read admission as permission.
 */

import type { PilotUa1PageBinding, PilotUa1DiscoveryPacket } from './pilotUa1Discovery.ts';
import {
  parsePilotUa1DiscoveryPacket,
  PILOT_UA1_MAX_CONTROLS,
  PILOT_UA1_MAX_HIDDEN_NOT_OBSERVED,
  PILOT_UA1_MAX_OPAQUE_BOUNDARIES,
} from './pilotUa1Discovery.ts';
import type { PilotUa3CandidateRule } from './pilotUa3CandidateRule.ts';
import { parsePilotUa3CandidateRule } from './pilotUa3CandidateRule.ts';
import type {
  PilotUa4TerminalState,
  PilotUa4WriteEffect,
  PilotUa4UnobservedRegion,
  PilotUa4WriteAuthority,
} from './pilotUa4WriteAuthority.ts';
import {
  PILOT_UA4_MAX_UNOBSERVED_REGIONS,
  PILOT_UA4_TERMINAL_STATES,
  parsePilotUa4WriteAuthorityResponse,
  parseUnobservedRegions,
} from './pilotUa4WriteAuthority.ts';

export const PILOT_UA5_SCHEMA_VERSION = 1 as const;
/**
 * The run projection has its own wire version. Version 2 (BREAKING-L2-T, ATOMIC
 * with UA-4 ledger v2) carries the ledger's `unobservedRegions` through to the
 * panel and ties them to `discoveryComplete`, so no projection can present a
 * whole-page completion over a page it did not wholly observe. v1 is rejected.
 */
export const PILOT_UA5_RUN_PROJECTION_SCHEMA_VERSION = 2 as const;
export const PILOT_UA5_TRIGGER = 'USER_CURRENT_PAGE_REQUEST' as const;

/**
 * An independent, additive read-only observation. It is neither a terminal
 * ledger nor a run projection. Missing wizard identity cannot become a page
 * number, a whole-form denominator or write permission through this shape.
 */
export type PilotUa5ReadOnlyScan = Readonly<{
  schemaVersion: 1;
  observedControls: number;
  hiddenNotObservedCount: number;
  unobservedRegions: number;
  structureAvailable: boolean;
  pageIdentity: 'UNVERIFIED';
}>;

export const PILOT_UA5_FAILURE_CODES = [
  'PILOT_CAPABILITY_DISABLED',
  'PILOT_UA5_INPUT_INVALID',
  'PILOT_UA5_STRUCTURE_UNAVAILABLE',
  'PILOT_UA5_CLASSIFICATION_UNAVAILABLE',
  'PILOT_UA5_CANDIDATE_UNAVAILABLE',
  'PILOT_UA5_COMPILATION_INCOMPLETE',
  'PILOT_UA5_AUTHORITY_UNAVAILABLE',
] as const;
export type PilotUa5FailureCode = (typeof PILOT_UA5_FAILURE_CODES)[number];

/**
 * The StructureSidecarV1 the UA-1 producer built for this exact packet.
 *
 * It has to cross the wire: the backend compiles the same epochs to derive the
 * question ids it authorizes, and the extension compiles them again inside the
 * UA-4 writer port. If only one side held the sidecar the two compilations would
 * disagree and UA-4 would refuse the batch, which is the correct failure but the
 * wrong reason. Digests, ordinals, booleans and closed sets only.
 */
export type PilotUa5StructureRow = Readonly<{
  identityDigest: string;
  elementToken: string;
  groupKeyDigest: string | null;
  row: Readonly<{
    rowGroupDigest: string;
    ordinal: number;
    shapeDigest: string;
    rowElementToken: string;
  }> | null;
  documentOrder: number;
  memberOfGroupControl: string | null;
  placeholderShape: 'MONTH_YEAR_MASK' | 'DATE_MASK' | null;
  optionsOverflow: boolean;
  placeholderOptionIndexes: readonly number[];
  disabled: boolean;
  readOnly: boolean;
  multiple: boolean;
}>;

export type PilotUa5Structure = Readonly<{
  schemaVersion: 1;
  packetDigest: string;
  epochIndex: number;
  compilerVersion: string;
  counts: Readonly<{
    controls: number;
    entries: number;
    suppressed: number;
    hiddenNotObserved: number;
  }>;
  entries: readonly PilotUa5StructureRow[];
}>;

export type PilotUa5CompositionRequest = Readonly<{
  schemaVersion: typeof PILOT_UA5_SCHEMA_VERSION;
  trigger: typeof PILOT_UA5_TRIGGER;
  /** The certified UA-1 packet, unchanged, including its observation accounting. */
  discovery: PilotUa1DiscoveryPacket;
  /**
   * Null is not "no structure to report": it means no sidecar was produced, and
   * the chain fails closed rather than grouping on legend evidence alone.
   */
  structure: PilotUa5Structure | null;
}>;

/**
 * One row per logical question, for the product panel. `admission` is an outlook
 * and never a claim that anything was written; it also names WHO owes this row
 * its terminal, because a question UA-4's prepare step neither mints a terminal
 * for nor asks a host to execute would otherwise leave the ledger a row short.
 */
export type PilotUa5QuestionRow = Readonly<{
  questionId: string;
  required: boolean;
  /** Closed writer kind, or null when no writer can ever take this question. */
  writerKind: string | null;
  /** How many observed controls this one question is made of. */
  memberCount: number;
  admission: PilotUa5Admission;
}>;

/**
 * - `AUTHORIZED` / `BLOCKED_OPTIONS_INCOMPLETE`: UA-4 owns this row's terminal.
 * - `TERMINAL_FROM_CLASSIFICATION`: UA-4's prepare step mints it from the
 *   classification alone; no authority was ever needed.
 * - `ANSWER_AUTHORITY_MISSING`: writable and cleanly classified, but the owner's
 *   Profile holds no confirmed fact for it, so nothing may be written.
 */
export const PILOT_UA5_ADMISSIONS = [
  'AUTHORIZED',
  'BLOCKED_OPTIONS_INCOMPLETE',
  'TERMINAL_FROM_CLASSIFICATION',
  'ANSWER_AUTHORITY_MISSING',
] as const;
export type PilotUa5Admission = (typeof PILOT_UA5_ADMISSIONS)[number];

export type PilotUa5PanelProjection = Readonly<{
  schemaVersion: typeof PILOT_UA5_SCHEMA_VERSION;
  binding: PilotUa1PageBinding;
  rows: readonly PilotUa5QuestionRow[];
  /** Recomputed, never supplied: a caller cannot assert its own completeness. */
  summary: Readonly<{
    observableQuestions: number;
    requiredQuestions: number;
    authorizedQuestions: number;
    requiredAuthorizedQuestions: number;
  }>;
}>;

export type PilotUa5CompositionResponse =
  | Readonly<{
      ok: true;
      schemaVersion: typeof PILOT_UA5_SCHEMA_VERSION;
      candidateRule: PilotUa3CandidateRule;
      authority: PilotUa4WriteAuthority;
      projection: PilotUa5PanelProjection;
      constraints: Readonly<{
        submit: 'FORBIDDEN';
        remoteCode: 'FORBIDDEN';
        rawValues: 'NEVER_TRANSMITTED';
        activationState: 'DEFAULT_OFF';
        releaseState: 'NOT_RELEASED';
      }>;
    }>
  | Readonly<{
      ok: false;
      schemaVersion: typeof PILOT_UA5_SCHEMA_VERSION;
      code: PilotUa5FailureCode;
    }>;

/**
 * One row per logical question in the run's own ledger, projected for the panel.
 * The state comes from the UA-4 terminal ledger; this adds no second ledger.
 */
export type PilotUa5RunRow = Readonly<{
  questionId: string;
  required: boolean;
  state: PilotUa4TerminalState;
  /** The closed reason the terminal carries, when it carries one. */
  reason: string | null;
  writeEffect?: PilotUa4WriteEffect;
}>;

export type PilotUa5RunProjection = Readonly<{
  schemaVersion: typeof PILOT_UA5_RUN_PROJECTION_SCHEMA_VERSION;
  binding: PilotUa1PageBinding;
  /** False whenever a row is DISCOVERY_INCOMPLETE or a region was not observed. */
  discoveryComplete: boolean;
  rows: readonly PilotUa5RunRow[];
  /** From the ledger, unchanged: not questions, never written, shown as such. */
  unobservedRegions: readonly PilotUa4UnobservedRegion[];
  summary: Readonly<{
    observableQuestions: number;
    requiredQuestions: number;
    /** Required OBSERVED questions whose terminal is a completed one, for "N of M". */
    requiredCompleted: number;
    terminalQuestions: number;
    unobservedRegions: number;
  }>;
}>;

/** Terminals that count as a required question being done, closed and explicit. */
export const PILOT_UA5_COMPLETED_STATES: readonly PilotUa4TerminalState[] = Object.freeze([
  'FILLED',
  'PREFILLED',
]);

export type PilotUa5ParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: 'PILOT_UA5_INPUT_INVALID' }>;

const failure = (): Readonly<{ ok: false; code: 'PILOT_UA5_INPUT_INVALID' }> =>
  Object.freeze({ ok: false, code: 'PILOT_UA5_INPUT_INVALID' as const });

type DataValues = Readonly<Record<string, unknown>>;

function exactDataValues(value: unknown, keys: readonly string[]): DataValues | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    result[key] = descriptor.value;
  }
  return result;
}

export function parsePilotUa5ReadOnlyScan(value: unknown): PilotUa5ParseResult<PilotUa5ReadOnlyScan> {
  try {
    const fields = exactDataValues(value, [
      'schemaVersion', 'observedControls', 'hiddenNotObservedCount',
      'unobservedRegions', 'structureAvailable', 'pageIdentity',
    ]);
    if (!fields || fields.schemaVersion !== 1 || fields.pageIdentity !== 'UNVERIFIED' ||
        typeof fields.structureAvailable !== 'boolean') return failure();
    const count = (candidate: unknown, maximum: number): candidate is number =>
      typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= maximum;
    if (!count(fields.observedControls, PILOT_UA1_MAX_CONTROLS) ||
        !count(fields.hiddenNotObservedCount, PILOT_UA1_MAX_HIDDEN_NOT_OBSERVED) ||
        !count(fields.unobservedRegions, PILOT_UA1_MAX_OPAQUE_BOUNDARIES)) return failure();
    return Object.freeze({ ok: true, value: Object.freeze({
      schemaVersion: 1,
      observedControls: fields.observedControls,
      hiddenNotObservedCount: fields.hiddenNotObservedCount,
      unobservedRegions: fields.unobservedRegions,
      structureAvailable: fields.structureAvailable,
      pageIdentity: 'UNVERIFIED',
    }) });
  } catch { return failure(); }
}

export function parsePilotUa5CompositionRequest(
  value: unknown,
): PilotUa5ParseResult<PilotUa5CompositionRequest> {
  try {
    const fields = exactDataValues(value, ['schemaVersion', 'trigger', 'discovery', 'structure']);
    if (!fields || fields.schemaVersion !== 1 || fields.trigger !== PILOT_UA5_TRIGGER) return failure();
    const discovery = parsePilotUa1DiscoveryPacket(fields.discovery);
    if (!discovery.ok) return failure();
    const structure = fields.structure === null ? null : parseStructure(fields.structure);
    if (fields.structure !== null && structure === null) return failure();
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        schemaVersion: 1,
        trigger: PILOT_UA5_TRIGGER,
        discovery: discovery.value,
        structure,
      }),
    });
  } catch {
    return failure();
  }
}

const PLACEHOLDER_SHAPES = new Set<string>(['MONTH_YEAR_MASK', 'DATE_MASK']);

/** Digests, ordinals, booleans and closed sets. Nothing here can carry a value. */
function parseStructure(value: unknown): PilotUa5Structure | null {
  const fields = exactDataValues(value, [
    'schemaVersion', 'packetDigest', 'epochIndex', 'compilerVersion', 'counts', 'entries',
  ]);
  if (
    !fields || fields.schemaVersion !== 1 ||
    typeof fields.packetDigest !== 'string' || !SHA256_HEX.test(fields.packetDigest) ||
    typeof fields.epochIndex !== 'number' || !Number.isSafeInteger(fields.epochIndex) || fields.epochIndex < 0 ||
    typeof fields.compilerVersion !== 'string' || !SAFE_ID.test(fields.compilerVersion)
  ) return null;
  const counts = exactDataValues(fields.counts, [
    'controls', 'entries', 'suppressed', 'hiddenNotObserved',
  ]);
  const entrySource = exactArray(fields.entries, 500);
  if (!counts || !entrySource) return null;
  for (const key of ['controls', 'entries', 'suppressed', 'hiddenNotObserved'] as const) {
    const count = counts[key];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null;
  }
  const entries: PilotUa5StructureRow[] = [];
  const seen = new Set<string>();
  for (const item of entrySource) {
    const entry = exactDataValues(item, [
      'identityDigest', 'elementToken', 'groupKeyDigest', 'row', 'documentOrder',
      'memberOfGroupControl', 'placeholderShape', 'optionsOverflow',
      'placeholderOptionIndexes', 'disabled', 'readOnly', 'multiple',
    ]);
    if (
      !entry ||
      typeof entry.identityDigest !== 'string' || !SHA256_HEX.test(entry.identityDigest) ||
      seen.has(entry.identityDigest) ||
      typeof entry.elementToken !== 'string' || !SHA256_HEX.test(entry.elementToken) ||
      (entry.groupKeyDigest !== null && (typeof entry.groupKeyDigest !== 'string' || !SHA256_HEX.test(entry.groupKeyDigest))) ||
      typeof entry.documentOrder !== 'number' || !Number.isSafeInteger(entry.documentOrder) || entry.documentOrder < 0 ||
      (entry.memberOfGroupControl !== null && (typeof entry.memberOfGroupControl !== 'string' || !SHA256_HEX.test(entry.memberOfGroupControl))) ||
      (entry.placeholderShape !== null && (typeof entry.placeholderShape !== 'string' || !PLACEHOLDER_SHAPES.has(entry.placeholderShape))) ||
      typeof entry.optionsOverflow !== 'boolean' ||
      typeof entry.disabled !== 'boolean' || typeof entry.readOnly !== 'boolean' ||
      typeof entry.multiple !== 'boolean'
    ) return null;
    const indexSource = exactArray(entry.placeholderOptionIndexes, 500);
    if (!indexSource) return null;
    const placeholderOptionIndexes: number[] = [];
    for (const index of indexSource) {
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return null;
      placeholderOptionIndexes.push(index);
    }
    let row: PilotUa5StructureRow['row'] = null;
    if (entry.row !== null) {
      const raw = exactDataValues(entry.row, ['rowGroupDigest', 'ordinal', 'shapeDigest', 'rowElementToken']);
      if (
        !raw ||
        typeof raw.rowGroupDigest !== 'string' || !SHA256_HEX.test(raw.rowGroupDigest) ||
        typeof raw.ordinal !== 'number' || !Number.isSafeInteger(raw.ordinal) || raw.ordinal < 0 ||
        typeof raw.shapeDigest !== 'string' || !SHA256_HEX.test(raw.shapeDigest) ||
        typeof raw.rowElementToken !== 'string' || !SHA256_HEX.test(raw.rowElementToken)
      ) return null;
      row = Object.freeze({
        rowGroupDigest: raw.rowGroupDigest, ordinal: raw.ordinal,
        shapeDigest: raw.shapeDigest, rowElementToken: raw.rowElementToken,
      });
    }
    seen.add(entry.identityDigest);
    entries.push(Object.freeze({
      identityDigest: entry.identityDigest,
      elementToken: entry.elementToken,
      groupKeyDigest: entry.groupKeyDigest as string | null,
      row,
      documentOrder: entry.documentOrder,
      memberOfGroupControl: entry.memberOfGroupControl as string | null,
      placeholderShape: entry.placeholderShape as PilotUa5StructureRow['placeholderShape'],
      optionsOverflow: entry.optionsOverflow,
      placeholderOptionIndexes: Object.freeze(placeholderOptionIndexes),
      disabled: entry.disabled,
      readOnly: entry.readOnly,
      multiple: entry.multiple,
    }));
  }
  if (counts.entries !== entries.length) return null;
  return Object.freeze({
    schemaVersion: 1,
    packetDigest: fields.packetDigest,
    epochIndex: fields.epochIndex,
    compilerVersion: fields.compilerVersion,
    counts: Object.freeze({
      controls: counts.controls as number,
      entries: counts.entries as number,
      suppressed: counts.suppressed as number,
      hiddenNotObserved: counts.hiddenNotObserved as number,
    }),
    entries: Object.freeze(entries),
  });
}

const ADMISSIONS = new Set<string>(PILOT_UA5_ADMISSIONS);
const TERMINAL_STATES = new Set<string>(PILOT_UA4_TERMINAL_STATES);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const ANSWER_AUTHORITIES = new Set<string>(['PROFILE_CONFIRMED', 'SCOPED_MEMORY_CONFIRMED', 'USER_CONFIRMED']);

function parseBinding(value: unknown): PilotUa1PageBinding | null {
  const fields = exactDataValues(value, ['origin', 'pathname', 'domGeneration']);
  if (
    !fields ||
    typeof fields.origin !== 'string' || fields.origin.length === 0 || fields.origin.length > 2048 ||
    typeof fields.pathname !== 'string' || fields.pathname.length === 0 || fields.pathname.length > 2048 ||
    typeof fields.domGeneration !== 'string' || !/^[a-f0-9]{64}$/.test(fields.domGeneration)
  ) return null;
  return Object.freeze({
    origin: fields.origin,
    pathname: fields.pathname,
    domGeneration: fields.domGeneration,
  });
}

function exactArray(value: unknown, max: number): readonly unknown[] | null {
  if (!Array.isArray(value)) return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1 || ownKeys.some((key) => typeof key !== 'string')) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

/** The run projection is always revalidated; a caller cannot assert its own counts. */
export function parsePilotUa5RunProjection(
  value: unknown,
): PilotUa5ParseResult<PilotUa5RunProjection> {
  try {
    const fields = exactDataValues(value, [
      'schemaVersion', 'binding', 'discoveryComplete', 'rows', 'unobservedRegions', 'summary',
    ]);
    if (
      !fields ||
      fields.schemaVersion !== PILOT_UA5_RUN_PROJECTION_SCHEMA_VERSION ||
      typeof fields.discoveryComplete !== 'boolean'
    ) return failure();
    const binding = parseBinding(fields.binding);
    const rowSource = exactArray(fields.rows, 500);
    const regionSource = exactArray(fields.unobservedRegions, PILOT_UA4_MAX_UNOBSERVED_REGIONS);
    const summary = exactDataValues(fields.summary, [
      'observableQuestions', 'requiredQuestions', 'requiredCompleted', 'terminalQuestions',
      'unobservedRegions',
    ]);
    if (!binding || !rowSource || !regionSource || !summary) return failure();
    const rows: PilotUa5RunRow[] = [];
    const seen = new Set<string>();
    for (const item of rowSource) {
      const changed = exactDataValues(item, ['questionId', 'required', 'state', 'reason', 'writeEffect']);
      if (changed && (changed.state !== 'POLICY_BLOCKED' || changed.writeEffect !== 'MAY_HAVE_CHANGED')) return failure();
      const row = exactDataValues(item, ['questionId', 'required', 'state', 'reason']) ?? changed;
      if (
        !row ||
        typeof row.questionId !== 'string' || !SAFE_ID.test(row.questionId) || seen.has(row.questionId) ||
        typeof row.required !== 'boolean' ||
        typeof row.state !== 'string' || !TERMINAL_STATES.has(row.state) ||
        (row.reason !== null && (typeof row.reason !== 'string' || !SAFE_ID.test(row.reason)))
      ) return failure();
      seen.add(row.questionId);
      rows.push(Object.freeze({
        questionId: row.questionId,
        required: row.required,
        state: row.state as PilotUa4TerminalState,
        reason: row.reason as string | null,
        ...(changed ? { writeEffect: 'MAY_HAVE_CHANGED' as const } : {}),
      }));
    }
    const regions = parseUnobservedRegions(regionSource, seen);
    if (regions === null) return failure();
    const requiredQuestions = rows.filter((row) => row.required).length;
    const requiredCompleted = rows.filter(
      (row) => row.required && PILOT_UA5_COMPLETED_STATES.includes(row.state),
    ).length;
    const incomplete = rows.some((row) => row.state === 'DISCOVERY_INCOMPLETE') || regions.length > 0;
    if (
      fields.discoveryComplete === incomplete ||
      summary.observableQuestions !== rows.length ||
      summary.requiredQuestions !== requiredQuestions ||
      summary.requiredCompleted !== requiredCompleted ||
      summary.terminalQuestions !== rows.length ||
      summary.unobservedRegions !== regions.length
    ) return failure();
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        schemaVersion: PILOT_UA5_RUN_PROJECTION_SCHEMA_VERSION,
        binding,
        discoveryComplete: fields.discoveryComplete,
        rows: Object.freeze(rows),
        unobservedRegions: regions,
        summary: Object.freeze({
          observableQuestions: rows.length,
          requiredQuestions,
          requiredCompleted,
          terminalQuestions: rows.length,
          unobservedRegions: regions.length,
        }),
      }),
    });
  } catch {
    return failure();
  }
}

export function parsePilotUa5CompositionResponse(
  value: unknown,
): PilotUa5ParseResult<PilotUa5CompositionResponse> {
  try {
    const failed = exactDataValues(value, ['ok', 'schemaVersion', 'code']);
    if (failed) {
      if (
        failed.ok !== false || failed.schemaVersion !== 1 ||
        typeof failed.code !== 'string' ||
        !PILOT_UA5_FAILURE_CODES.includes(failed.code as PilotUa5FailureCode)
      ) return failure();
      return Object.freeze({
        ok: true,
        value: Object.freeze({
          ok: false,
          schemaVersion: 1,
          code: failed.code as PilotUa5FailureCode,
        }),
      });
    }
    const fields = exactDataValues(value, [
      'ok', 'schemaVersion', 'candidateRule', 'authority', 'projection', 'constraints',
    ]);
    if (!fields || fields.ok !== true || fields.schemaVersion !== 1) return failure();
    const rule = parsePilotUa3CandidateRule(fields.candidateRule);
    const authority = parsePilotUa4WriteAuthorityResponse({
      ok: true, schemaVersion: 1, authority: fields.authority,
    });
    const constraints = exactDataValues(fields.constraints, [
      'submit', 'remoteCode', 'rawValues', 'activationState', 'releaseState',
    ]);
    if (
      !rule.ok || !authority.ok || !authority.value.ok || !constraints ||
      constraints.submit !== 'FORBIDDEN' ||
      constraints.remoteCode !== 'FORBIDDEN' ||
      constraints.rawValues !== 'NEVER_TRANSMITTED' ||
      constraints.activationState !== 'DEFAULT_OFF' ||
      constraints.releaseState !== 'NOT_RELEASED'
    ) return failure();
    const projection = parseProjection(fields.projection);
    if (!projection) return failure();
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        ok: true,
        schemaVersion: 1,
        candidateRule: rule.value,
        authority: authority.value.authority,
        projection,
        constraints: Object.freeze({
          submit: 'FORBIDDEN' as const,
          remoteCode: 'FORBIDDEN' as const,
          rawValues: 'NEVER_TRANSMITTED' as const,
          activationState: 'DEFAULT_OFF' as const,
          releaseState: 'NOT_RELEASED' as const,
        }),
      }),
    });
  } catch {
    return failure();
  }
}

function parseProjection(value: unknown): PilotUa5PanelProjection | null {
  const fields = exactDataValues(value, ['schemaVersion', 'binding', 'rows', 'summary']);
  if (!fields || fields.schemaVersion !== 1) return null;
  const binding = parseBinding(fields.binding);
  const rowSource = exactArray(fields.rows, 500);
  const summary = exactDataValues(fields.summary, [
    'observableQuestions', 'requiredQuestions', 'authorizedQuestions', 'requiredAuthorizedQuestions',
  ]);
  if (!binding || !rowSource || !summary) return null;
  const rows: PilotUa5QuestionRow[] = [];
  const seen = new Set<string>();
  for (const item of rowSource) {
    const row = exactDataValues(item, ['questionId', 'required', 'writerKind', 'memberCount', 'admission']);
    if (
      !row ||
      typeof row.questionId !== 'string' || !SAFE_ID.test(row.questionId) || seen.has(row.questionId) ||
      typeof row.required !== 'boolean' ||
      (row.writerKind !== null && (typeof row.writerKind !== 'string' || !SAFE_ID.test(row.writerKind))) ||
      typeof row.memberCount !== 'number' || !Number.isSafeInteger(row.memberCount) || row.memberCount < 1 ||
      typeof row.admission !== 'string' || !ADMISSIONS.has(row.admission)
    ) return null;
    seen.add(row.questionId);
    rows.push(Object.freeze({
      questionId: row.questionId,
      required: row.required,
      writerKind: row.writerKind as string | null,
      memberCount: row.memberCount,
      admission: row.admission as PilotUa5QuestionRow['admission'],
    }));
  }
  const requiredQuestions = rows.filter((row) => row.required).length;
  const authorizedQuestions = rows.filter((row) => row.admission === 'AUTHORIZED').length;
  const requiredAuthorizedQuestions = rows.filter(
    (row) => row.required && row.admission === 'AUTHORIZED',
  ).length;
  if (
    summary.observableQuestions !== rows.length ||
    summary.requiredQuestions !== requiredQuestions ||
    summary.authorizedQuestions !== authorizedQuestions ||
    summary.requiredAuthorizedQuestions !== requiredAuthorizedQuestions
  ) return null;
  return Object.freeze({
    schemaVersion: 1,
    binding,
    rows: Object.freeze(rows),
    summary: Object.freeze({
      observableQuestions: rows.length,
      requiredQuestions,
      authorizedQuestions,
      requiredAuthorizedQuestions,
    }),
  });
}
