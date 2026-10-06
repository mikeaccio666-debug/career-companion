/**
 * Vector harness for the Semantic Compiler (S1).
 *
 * A vector is a value-free page fixture plus the graph the compiler must
 * produce from it. Digests are real SHA-256 (node:crypto), exactly the shape
 * UA-1 emits. Nothing here touches the DOM.
 */

import { createHash } from 'node:crypto';
import type { PilotUa1VisibleControl, PilotUa2Classification } from '@edaix/contracts/draft';
import { classifyQuestions } from '../../src/semantic/classify.ts';
import { SEMANTIC_COMPILER_VERSION, compileGraph, packetDigestOf, type EpochInput } from '../../src/semantic/graph.ts';
import type { Digest } from '../../src/semantic/grouping.ts';
import { checkInvariants } from '../../src/semantic/invariants.ts';
import type { StructureSidecarEntry } from '../../src/semantic/ir.ts';

export const sha256: Digest = (...parts) => createHash('sha256').update(parts.join(' '), 'utf8').digest('hex');

/** Every digest in a vector is derived from a readable ref, so fixtures stay legible. */
export const d = (ref: string): string => sha256('ref', ref);

/**
 * Control shapes a host actually renders. A preset carries no semantics of its
 * own: it expands to the exact `inputType`/`role` pair a vector would otherwise
 * restate, and any field a vector sets explicitly still wins.
 */
export const SHAPES = {
  TEXT: { inputType: 'text', role: 'textbox' },
  TEXTAREA: { inputType: 'textarea', role: 'textbox' },
  EMAIL: { inputType: 'email', role: 'textbox' },
  TEL: { inputType: 'tel', role: 'textbox' },
  URL: { inputType: 'url', role: 'textbox' },
  NUMBER: { inputType: 'number', role: 'spinbutton' },
  PASSWORD: { inputType: 'password', role: 'textbox' },
  SELECT: { inputType: 'select-one', role: 'combobox' },
  RADIO: { inputType: 'radio', role: 'radio' },
  CHECKBOX: { inputType: 'checkbox', role: 'checkbox' },
  FILE: { inputType: 'file', role: 'textbox' },
  DATE: { inputType: 'date', role: 'textbox' },
  SUBMIT: { inputType: 'submit', role: 'button' },
  LISTBOX: { role: 'listbox' },
  RICHTEXT: { role: 'textbox' },
} as const satisfies Record<string, Partial<Pick<VectorControlFields, 'inputType' | 'role'>>>;
export type ShapeName = keyof typeof SHAPES;

/** Option lists several vectors need verbatim. Synthetic fixture text, never page data. */
export const OPTION_PRESETS = {
  MONTHS: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  MONTHS_SHORT_11: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November'],
  YEARS_6: ['2019', '2020', '2021', '2022', '2023', '2024'],
  YEARS_START_6: ['2020', '2021', '2022', '2023', '2024', '2025'],
  YEARS_32: Array.from({ length: 32 }, (_, i) => String(1995 + i)),
  NO_YES: ['No', 'Yes'],
} as const;
export type OptionPreset = keyof typeof OPTION_PRESETS;

interface VectorControlFields {
  role?: PilotUa1VisibleControl['role'];
  inputType?: PilotUa1VisibleControl['inputType'];
}

export interface VectorControl {
  ref: string;
  /** Expands to an inputType/role pair; explicit fields still win. */
  shape?: ShapeName;
  /** Expands to a shared option list; an explicit `options` still wins. */
  optionsPreset?: OptionPreset;
  role?: PilotUa1VisibleControl['role'];
  inputType?: PilotUa1VisibleControl['inputType'];
  autocomplete?: string[];
  required?: boolean;
  accessibleName?: string | null;
  label?: string | null;
  legend?: string | null;
  options?: string[];
  /** Sidecar evidence. */
  groupKey?: string;
  row?: { group: string; ordinal: number; shape: string; element: string };
  memberOf?: string;
  element?: string;
  placeholderShape?: 'MONTH_YEAR_MASK' | 'DATE_MASK';
  optionsOverflow?: boolean;
  placeholderOptions?: number[];
  fileAccept?: 'DOCUMENT' | 'IMAGE' | 'ANY' | 'OTHER' | null;
  disabled?: boolean;
  readOnly?: boolean;
  multiple?: boolean;
}

/** Every field the sidecar binds, so the binding is tested per field, not per class. */
export const SIDECAR_TAMPERS = [
  'PACKET_DIGEST', 'EPOCH', 'VERSION', 'SCHEMA',
  'COUNT_CONTROLS', 'COUNT_ENTRIES', 'COUNT_SUPPRESSED', 'COUNT_HIDDEN',
  'DUPLICATE_ENTRY',
] as const;
export type SidecarTamper = (typeof SIDECAR_TAMPERS)[number];

/**
 * A later epoch usually differs from the one before it by a few controls. Saying
 * what CHANGED is both shorter and a better description of the scenario than
 * restating the whole packet, so an epoch may inherit and then edit.
 */
export interface EpochDelta {
  /** Start from the previous epoch's controls instead of listing them again. */
  inherit: true;
  /** Refs the host removed. */
  remove?: string[];
  /**
   * Edits keyed by the ref as it was. Changing `ref` models a UA-1 ADDRESS
   * change; because that is exactly the case where element identity decides the
   * outcome, such a patch must state `element` explicitly.
   */
  patch?: Record<string, Partial<VectorControl>>;
  /** Controls the host inserted, placed before the named ref. */
  insertBefore?: { ref: string; controls: VectorControl[] };
  /** Controls the host appended. */
  add?: VectorControl[];
}

export interface VectorEpoch {
  cause: EpochInput['cause'];
  domGeneration: string;
  /** false = no sidecar at all (UA-1 packet only). */
  sidecar?: boolean;
  sidecarTamper?: SidecarTamper;
  /** Omitted when `delta` inherits the previous epoch's packet. */
  controls?: VectorControl[];
  delta?: EpochDelta;
  suppressed?: string[];
  hiddenNotObserved?: number;
  attributedAddRowGroup?: string;
  /** Inherited from the previous epoch when the packet is, then overridden here. */
  ua2?: Record<string, {
    kind: PilotUa2Classification['kind'];
    canonicalField?: PilotUa2Classification['canonicalField'];
    confidence?: PilotUa2Classification['confidence'];
    reasonCode?: PilotUa2Classification['reasonCode'];
  }>;
}

/** After expansion every epoch is fully explicit; this is what the compiler sees. */
export type ExpandedEpoch = Omit<VectorEpoch, 'controls' | 'delta' | 'ua2'> & {
  controls: VectorControl[];
  ua2: NonNullable<VectorEpoch['ua2']>;
};

export interface Vector {
  id: string;
  scenarioClass: string;
  title: string;
  todayBehavior: string;
  origin?: string;
  pathname?: string;
  epochs: VectorEpoch[];
  expected: {
    compile?: 'OK' | 'COMPILE_INCOMPLETE';
    compileReason?: string;
    logicalControls?: {
      kind: string;
      members: string[];
      grouping?: string;
      dateShape?: string;
      optionsIncomplete?: boolean;
      placeholderOptions?: number;
      required?: boolean;
      disabled?: boolean;
      readOnly?: boolean;
    }[];
    nodeCount?: number;
    nodeKinds?: Record<string, string>;
    actionClasses?: Record<string, string>;
    liveRows?: number;
    retiredRows?: number;
    rowTokensDiffer?: [string, string][];
    /** The two refs must resolve to the same node — identity survived the epoch. */
    sameNode?: [string, string][];
    differentNode?: [string, string][];
    rowRetired?: Record<string, boolean>;
    rowOrigins?: Record<string, string>;
    rowOrdinals?: Record<string, number>;
    /** ref -> [firstObservedEpoch, lastObservedEpoch]. */
    observedEpochs?: Record<string, [number, number]>;
    /** Read straight off the node, so a stale copy on the node cannot pass. */
    nodeRowRetired?: Record<string, boolean>;
    classifications?: Record<string, {
      kind?: string;
      merge?: string;
      stemGuard?: string;
      confidence?: string;
      canonicalField?: string | null;
      duplicateRootStem?: boolean;
    }>;
    hiddenNotObservedByEpoch?: number[];
  };
}

function expandControl(c: VectorControl): VectorControl {
  const { shape, optionsPreset, ...rest } = c;
  const out: VectorControl = { ...(shape ? SHAPES[shape] : {}), ...rest };
  if (optionsPreset && out.options === undefined) out.options = [...OPTION_PRESETS[optionsPreset]];
  return out;
}

function applyDelta(previous: readonly VectorControl[], delta: EpochDelta): VectorControl[] {
  const removed = new Set(delta.remove ?? []);
  let out: VectorControl[] = previous.filter((c) => !removed.has(c.ref)).map((c) => ({ ...c }));
  // Insert before patching, so every ref a delta names is the ref the PREVIOUS
  // epoch used. A delta that had to know its own rename order would be a trap.
  if (delta.insertBefore) {
    const i = out.findIndex((c) => c.ref === delta.insertBefore!.ref);
    if (i === -1) throw new Error(`delta inserts before unknown control "${delta.insertBefore.ref}"`);
    out = [...out.slice(0, i), ...delta.insertBefore.controls.map(expandControl), ...out.slice(i)];
  }
  for (const [ref, patch] of Object.entries(delta.patch ?? {})) {
    const i = out.findIndex((c) => c.ref === ref);
    if (i === -1) throw new Error(`delta patches unknown control "${ref}"`);
    if (patch.ref !== undefined && patch.ref !== ref && patch.element === undefined) {
      // A renamed ref is a changed UA-1 address, and whether the element behind
      // it is the same one is the whole question. Never let it default.
      throw new Error(`delta renames "${ref}" to "${patch.ref}" without stating element`);
    }
    out[i] = expandControl({ ...out[i]!, ...patch });
  }
  return [...out, ...(delta.add ?? []).map(expandControl)];
}

/**
 * Normalises a vector's epoch list into the full, explicit form the compiler is
 * fed: shape and option presets expanded, deltas applied, UA-2 inherited.
 *
 * Exported so an equivalence check can prove a fixture refactor changed no
 * scenario: the expansion before and after must be byte-identical.
 */
export function expandEpochs(v: Vector): ExpandedEpoch[] {
  const out: ExpandedEpoch[] = [];
  for (const e of v.epochs) {
    const { controls, delta, ua2, ...rest } = e;
    if ((controls === undefined) === (delta === undefined)) {
      throw new Error(`epoch must have exactly one of controls or delta (${v.id})`);
    }
    const previous = out[out.length - 1];
    if (delta && !previous) throw new Error(`the first epoch cannot inherit (${v.id})`);
    const expanded = delta ? applyDelta(previous!.controls, delta) : controls!.map(expandControl);

    // UA-2 answers per control, so an inherited packet inherits its answers.
    // A patch that renamed a control carries its classification to the new ref.
    let inherited: ExpandedEpoch['ua2'] = {};
    if (delta && previous) {
      const renamed = new Map(
        Object.entries(delta.patch ?? {})
          .filter(([from, patch]) => patch.ref !== undefined && patch.ref !== from)
          .map(([from, patch]) => [from, patch.ref!]),
      );
      const live = new Set(expanded.map((c) => c.ref));
      for (const [ref, cls] of Object.entries(previous.ua2)) {
        const key = renamed.get(ref) ?? ref;
        if (live.has(key)) inherited[key] = cls;
      }
    }
    out.push({ ...rest, controls: expanded, ua2: { ...inherited, ...(ua2 ?? {}) } });
  }
  return out;
}

function toEpoch(e: ExpandedEpoch, index: number, origin: string, pathname: string): EpochInput {
  const controls: PilotUa1VisibleControl[] = e.controls.map((c) => ({
    identityDigest: d(c.ref),
    role: c.role ?? null,
    inputType: c.inputType ?? null,
    autocomplete: c.autocomplete ?? [],
    required: c.required ?? false,
    accessibleName: c.accessibleName ?? c.label ?? null,
    label: c.label ?? null,
    legend: c.legend ?? null,
    options: (c.options ?? []).map((o, i) => ({ identityDigest: d(`${c.ref}/option:${i}`), accessibleName: o })),
    fileAccept: c.fileAccept ?? null,
  }));
  const entries: StructureSidecarEntry[] | null = e.sidecar === false ? null : e.controls.map((c, i) => ({
    identityDigest: d(c.ref),
    elementToken: d(`el:${c.element ?? c.ref}`),
    groupKeyDigest: c.groupKey ? d(`group:${c.groupKey}`) : null,
    row: c.row
      ? { rowGroupDigest: d(`rowgroup:${c.row.group}`), ordinal: c.row.ordinal, shapeDigest: d(`shape:${c.row.shape}`), rowElementToken: d(`rowel:${c.row.element}`) }
      : null,
    documentOrder: i,
    memberOfGroupControl: c.memberOf ? d(c.memberOf) : null,
    placeholderShape: c.placeholderShape ?? null,
    optionsOverflow: c.optionsOverflow ?? false,
    placeholderOptionIndexes: c.placeholderOptions ?? [],
    disabled: c.disabled ?? false,
    readOnly: c.readOnly ?? false,
    multiple: c.multiple ?? false,
  }));
  const suppressed = (e.suppressed ?? []).map(d);
  return {
    cause: e.cause,
    binding: { origin, pathname, domGeneration: sha256('gen', e.domGeneration) },
    controls,
    structure: entries === null ? null : {
      schemaVersion: (e.sidecarTamper === 'SCHEMA' ? 2 : 1) as 1,
      packetDigest: e.sidecarTamper === 'PACKET_DIGEST' ? sha256('tampered') : packetDigestOf(controls, sha256),
      epochIndex: e.sidecarTamper === 'EPOCH' ? index + 1 : index,
      compilerVersion: e.sidecarTamper === 'VERSION' ? 'other-compiler' : SEMANTIC_COMPILER_VERSION,
      counts: {
        controls: controls.length + (e.sidecarTamper === 'COUNT_CONTROLS' ? 1 : 0),
        entries: entries.length + (e.sidecarTamper === 'COUNT_ENTRIES' ? 1 : 0),
        suppressed: suppressed.length + (e.sidecarTamper === 'COUNT_SUPPRESSED' ? 1 : 0),
        hiddenNotObserved: (e.hiddenNotObserved ?? 0) + (e.sidecarTamper === 'COUNT_HIDDEN' ? 1 : 0),
      },
      entries: e.sidecarTamper === 'DUPLICATE_ENTRY' && entries[0] ? [...entries, entries[0]] : entries,
    },
    suppressedControls: suppressed,
    hiddenNotObservedCount: e.hiddenNotObserved ?? 0,
    attributedAddRowGroup: e.attributedAddRowGroup ? d(`rowgroup:${e.attributedAddRowGroup}`) : null,
  };
}

const DEFAULT_REASON = (kind: PilotUa2Classification['kind']): PilotUa2Classification['reasonCode'] => (
  kind === 'CANONICAL_FIELD' ? 'CANONICAL_AUTOCOMPLETE_MATCH'
    : kind === 'STRUCTURED_CHOICE' ? 'STRUCTURED_CHOICE_CONTROL'
      : kind === 'STRUCTURED_DATE' ? 'STRUCTURED_DATE_CONTROL'
        : kind === 'STRUCTURED_NUMBER' ? 'STRUCTURED_NUMBER_CONTROL'
          : kind === 'STRUCTURED_FILE' ? 'STRUCTURED_FILE_CONTROL'
            : kind === 'OPEN_QUESTION' ? 'OPEN_QUESTION_CONTROL'
              : kind === 'HUMAN_ACTION_REQUIRED' ? 'HUMAN_ACTION_CONTROL'
                : 'SEMANTIC_CLASSIFICATION_UNRESOLVED'
);

/**
 * Exactly what the compiler is fed for this vector. Exported so a fixture
 * refactor can be proven inert: the compiler input must not move.
 */
export function compiledEpochs(v: Vector): EpochInput[] {
  return expandEpochs(v).map((e, k) => toEpoch(e, k, v.origin ?? 'https://example.invalid', v.pathname ?? '/apply'));
}

/** Runs one vector; returns the list of expectation failures (empty = pass). */
export function runVector(v: Vector): string[] {
  const failures: string[] = [];
  const origin = v.origin ?? 'https://example.invalid';
  const pathname = v.pathname ?? '/apply';
  const refOf = new Map<string, string>();
  for (const e of expandEpochs(v)) for (const c of e.controls) refOf.set(d(c.ref), c.ref);

  const epochs = expandEpochs(v);
  const compiled = compileGraph(epochs.map((e, k) => toEpoch(e, k, origin, pathname)), sha256);
  const exp = v.expected;
  if (exp.compile === 'COMPILE_INCOMPLETE') {
    if (compiled.ok) return ['expected COMPILE_INCOMPLETE, got a graph'];
    if (exp.compileReason && compiled.reason !== exp.compileReason) return [`expected reason ${exp.compileReason}, got ${compiled.reason}`];
    return [];
  }
  if (!compiled.ok) return [`compile failed: ${compiled.reason} unplaced=${compiled.unplaced.map((x) => refOf.get(x) ?? x).join(',')}`];
  const graph = compiled.graph;

  const ua2 = new Map<string, PilotUa2Classification>();
  for (const e of epochs) {
    for (const [ref, c] of Object.entries(e.ua2)) {
      ua2.set(d(ref), {
        identityDigest: d(ref),
        kind: c.kind,
        canonicalField: c.canonicalField ?? null,
        confidence: c.confidence ?? (c.kind === 'UNRESOLVED' ? 'LOW' : 'HIGH'),
        provenance: { source: c.kind === 'CANONICAL_FIELD' ? 'AUTOCOMPLETE' : 'CONTROL_SEMANTICS', semanticDigest: sha256('sem', ref) },
        reasonCode: c.reasonCode ?? DEFAULT_REASON(c.kind),
      });
    }
  }
  const classifications = classifyQuestions(graph, ua2);
  const violations = checkInvariants(graph, classifications);

  // A ref resolves through the epoch in which it was observed: a later epoch may
  // give the same element a different UA-1 address, and the node must survive it.
  const nodeIdOfRef = new Map<string, string>();
  epochs.forEach((e, k) => {
    const keys = [
      ...e.controls.map((c, i) => [c.ref, `${k}:c${i}:${d(c.ref)}`] as const),
      ...(e.suppressed ?? []).map((ref, j) => [ref, `${k}:s${j}:${d(ref)}`] as const),
    ];
    for (const [ref, key] of keys) {
      const lc = graph.observationIndex[key];
      const nodeId = lc === undefined ? undefined : graph.controlIndex[lc];
      if (nodeId !== undefined) nodeIdOfRef.set(ref, nodeId);
    }
  });
  const nodeOf = (ref: string) => graph.nodes.find((n) => n.id === nodeIdOfRef.get(ref));
  const describe = () => graph.nodes
    .map((n) => `${n.control.kind}[${n.control.members.map((m) => refOf.get(m.identityDigest) ?? 'suppressed').join(',')}]`)
    .join(' ');

  for (const lc of exp.logicalControls ?? []) {
    const want = JSON.stringify(lc.members.map(d).sort());
    const found = graph.nodes.find((n) => n.control.kind === lc.kind && JSON.stringify(n.control.members.map((m) => m.identityDigest).sort()) === want);
    if (!found) {
      failures.push(`missing logical control ${lc.kind}[${lc.members.join(',')}]; have ${describe()}`);
      continue;
    }
    const c = found.control;
    const label = `${lc.kind}[${lc.members.join(',')}]`;
    if (lc.grouping !== undefined && c.grouping !== lc.grouping) failures.push(`${label} grouping ${c.grouping} != ${lc.grouping}`);
    if (lc.dateShape !== undefined && c.dateShape !== lc.dateShape) failures.push(`${label} dateShape ${c.dateShape} != ${lc.dateShape}`);
    if (lc.optionsIncomplete !== undefined && c.optionsIncomplete !== lc.optionsIncomplete) failures.push(`${label} optionsIncomplete ${c.optionsIncomplete} != ${lc.optionsIncomplete}`);
    if (lc.placeholderOptions !== undefined && c.options.filter((o) => o.placeholder).length !== lc.placeholderOptions) failures.push(`${label} placeholder options != ${lc.placeholderOptions}`);
    if (lc.required !== undefined && c.required !== lc.required) failures.push(`${label} required ${c.required} != ${lc.required}`);
    if (lc.disabled !== undefined && c.disabled !== lc.disabled) failures.push(`${label} disabled ${c.disabled} != ${lc.disabled}`);
    if (lc.readOnly !== undefined && c.readOnly !== lc.readOnly) failures.push(`${label} readOnly ${c.readOnly} != ${lc.readOnly}`);
  }
  if (exp.nodeCount !== undefined && graph.nodes.length !== exp.nodeCount) failures.push(`nodeCount ${graph.nodes.length} != ${exp.nodeCount}; have ${describe()}`);
  for (const [ref, kind] of Object.entries(exp.nodeKinds ?? {})) {
    const n = nodeOf(ref);
    if (!n) failures.push(`no node for ${ref}`);
    else if (n.kind !== kind) failures.push(`${ref}: node kind ${n.kind} != ${kind}`);
  }
  for (const [ref, cls] of Object.entries(exp.actionClasses ?? {})) {
    const n = nodeOf(ref);
    if (!n || n.kind !== 'ACTION') failures.push(`${ref} is not an action node`);
    else if (n.actionClass !== cls) failures.push(`${ref}: actionClass ${n.actionClass} != ${cls}`);
  }

  const live = graph.rows.filter((r) => r.retiredAtEpoch === null).length;
  if (exp.liveRows !== undefined && live !== exp.liveRows) failures.push(`liveRows ${live} != ${exp.liveRows}`);
  if (exp.retiredRows !== undefined && graph.rows.length - live !== exp.retiredRows) failures.push(`retiredRows ${graph.rows.length - live} != ${exp.retiredRows}`);
  const tokenOf = (ref: string) => nodeOf(ref)?.rowToken ?? null;
  const rowOf = (ref: string) => { const t = tokenOf(ref); return t === null ? undefined : graph.rows.find((r) => r.token === t); };
  // Both sides must resolve. A comparison against a ref that reaches nothing
  // would otherwise pass for the wrong reason.
  for (const [a, b] of exp.rowTokensDiffer ?? []) {
    if (tokenOf(a) === null || tokenOf(b) === null) failures.push(`row tokens should differ but ${tokenOf(a) === null ? a : b} has no row`);
    else if (tokenOf(a) === tokenOf(b)) failures.push(`row tokens should differ: ${a} vs ${b}`);
  }
  for (const [a, b] of exp.sameNode ?? []) {
    const x = nodeIdOfRef.get(a);
    const y = nodeIdOfRef.get(b);
    if (a === b) failures.push(`sameNode compares ${a} with itself and proves nothing`);
    else if (x === undefined || y === undefined) failures.push(`sameNode: ${x === undefined ? a : b} resolves to no node`);
    else if (x !== y) failures.push(`${a} and ${b} should be the same node`);
  }
  for (const [a, b] of exp.differentNode ?? []) {
    const x = nodeIdOfRef.get(a);
    const y = nodeIdOfRef.get(b);
    if (x === undefined || y === undefined) failures.push(`differentNode: ${x === undefined ? a : b} resolves to no node`);
    else if (x === y) failures.push(`${a} and ${b} should be different nodes`);
  }
  for (const [ref, want] of Object.entries(exp.rowRetired ?? {})) {
    const row = rowOf(ref);
    if (!row) failures.push(`${ref} has no row incarnation`);
    else if ((row.retiredAtEpoch !== null) !== want) failures.push(`${ref}: retired ${row.retiredAtEpoch !== null} != ${want}`);
  }
  for (const [ref, want] of Object.entries(exp.rowOrigins ?? {})) {
    const row = rowOf(ref);
    if (!row) failures.push(`${ref} has no row incarnation`);
    else if (row.origin !== want) failures.push(`${ref}: row origin ${row.origin} != ${want}`);
  }
  for (const [ref, [first, last]] of Object.entries(exp.observedEpochs ?? {})) {
    const n = nodeOf(ref);
    if (!n) failures.push(`no node for ${ref}`);
    else if (n.firstObservedEpoch !== first || n.lastObservedEpoch !== last) {
      failures.push(`${ref}: observed epochs [${n.firstObservedEpoch},${n.lastObservedEpoch}] != [${first},${last}]`);
    }
  }
  for (const [ref, want] of Object.entries(exp.rowOrdinals ?? {})) {
    const row = rowOf(ref);
    if (!row) failures.push(`${ref} has no row incarnation`);
    else if (row.currentOrdinal !== want) failures.push(`${ref}: currentOrdinal ${row.currentOrdinal} != ${want}`);
  }
  // Read through the node itself: a node holding a stale copy of its row must fail here.
  for (const [ref, want] of Object.entries(exp.nodeRowRetired ?? {})) {
    const node = nodeOf(ref);
    const token = node?.rowToken ?? null;
    const row = token === null ? undefined : graph.rows.find((r) => r.token === token);
    if (!node) failures.push(`no node for ${ref}`);
    else if (!row) failures.push(`${ref}: node.rowToken resolves to no incarnation`);
    else if ((row.retiredAtEpoch !== null) !== want) failures.push(`${ref}: node row retired ${row.retiredAtEpoch !== null} != ${want}`);
  }

  for (const [ref, want] of Object.entries(exp.classifications ?? {})) {
    const n = nodeOf(ref);
    const c = n ? classifications.find((x) => x.nodeId === n.id) : undefined;
    if (!c) { failures.push(`no classification for ${ref}`); continue; }
    if (want.kind !== undefined && c.kind !== want.kind) failures.push(`${ref}: kind ${c.kind} != ${want.kind}`);
    if (want.merge !== undefined && c.merge !== want.merge) failures.push(`${ref}: merge ${c.merge} != ${want.merge}`);
    if (want.stemGuard !== undefined && c.stemGuard !== want.stemGuard) failures.push(`${ref}: stemGuard ${c.stemGuard} != ${want.stemGuard}`);
    if (want.confidence !== undefined && c.confidence !== want.confidence) failures.push(`${ref}: confidence ${c.confidence} != ${want.confidence}`);
    if (want.canonicalField !== undefined && c.canonicalField !== want.canonicalField) failures.push(`${ref}: canonicalField ${c.canonicalField} != ${want.canonicalField}`);
    if (want.duplicateRootStem !== undefined && c.duplicateRootStem !== want.duplicateRootStem) failures.push(`${ref}: duplicateRootStem ${c.duplicateRootStem} != ${want.duplicateRootStem}`);
  }
  if (exp.hiddenNotObservedByEpoch !== undefined) {
    const got = graph.epochs.map((e) => e.hiddenNotObservedCount);
    if (JSON.stringify(got) !== JSON.stringify(exp.hiddenNotObservedByEpoch)) {
      failures.push(`hiddenNotObservedByEpoch ${JSON.stringify(got)} != ${JSON.stringify(exp.hiddenNotObservedByEpoch)}`);
    }
  }

  if (violations.length > 0) failures.push(`invariant violations: ${violations.map((x) => `${x.invariant}:${x.message}`).join('; ')}`);
  return failures;
}
