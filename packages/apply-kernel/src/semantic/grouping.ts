/**
 * L1 · Physical observations → logical controls (S1, kernel lane).
 *
 * Pure functions. No DOM, no network, no vendor or library names, no values.
 * The digest function is injected so the module stays synchronous and
 * deterministic (RULE-KERNEL-DETERMINISTIC-BOUNDARY).
 *
 * The one job here: decide which observed controls are the SAME question.
 * Nothing about how to write them — that stays with the UA-4 writer.
 */

import type { PilotUa1VisibleControl } from '@edaix/contracts/draft';
import { monthCandidates } from '../collectionProjection.ts';
import type {
  DateShape,
  Digest64,
  GroupingEvidence,
  LogicalControl,
  LogicalControlKind,
  LogicalControlMember,
  LogicalOption,
  StructureSidecar,
  StructureSidecarEntry,
} from './ir.ts';

/** Injected synchronous digest (SHA-256 hex in production). Parts join with a single space. */
export type Digest = (...parts: readonly string[]) => Digest64;

/** Month spellings are calendar knowledge already owned by the kernel projection layer. */
const MONTH_NAMES: ReadonlySet<string> = new Set(
  Array.from({ length: 12 }, (_, i) => monthCandidates(i + 1))
    .flat()
    .filter((c) => /^[a-z]+$/iu.test(c))
    .map((c) => c.toLowerCase()),
);

function optionsLookLikeMonths(all: readonly LogicalOption[]): boolean {
  const options = all.filter((o) => !o.placeholder);
  const named = options.filter((o) => MONTH_NAMES.has(o.accessibleName.trim().toLowerCase()));
  return options.length >= 12 && named.length >= 12;
}

function optionsLookLikeYears(all: readonly LogicalOption[]): boolean {
  const options = all.filter((o) => !o.placeholder);
  const years = options.filter((o) => /^(19|20)\d{2}$/u.test(o.accessibleName.trim()));
  return options.length >= 5 && years.length >= options.length - 1;
}

/** Form-control ARIA roles: a leaf widget that carries an answer. Groups (radiogroup) are not in it. */
export const FORM_ROLES = new Set<NonNullable<PilotUa1VisibleControl['role']>>([
  'checkbox', 'switch', 'radio', 'combobox', 'listbox', 'slider', 'spinbutton', 'textbox', 'searchbox',
]);

/** The role/type shape of a control; all `baseKind` needs besides sidecar evidence. */
export type ControlShape = Pick<PilotUa1VisibleControl, 'inputType' | 'role'>;

export function baseKind(c: ControlShape, s: StructureSidecarEntry | null): LogicalControlKind {
  const t = c.inputType;
  const r = c.role;
  if (t === 'password') return 'PASSWORD';
  // An explicit form-control ARIA role on a <button> (the Radix/Headless-UI
  // pattern) is the host's own statement of what the control IS; the
  // tag-derived inputType is only a fallback.
  if (r !== null && FORM_ROLES.has(r) && (t === 'button' || t === 'submit' || t === 'reset' || t === 'image' || t === null)) {
    switch (r) {
      case 'checkbox': return 'CHECKBOX_SINGLE';
      case 'switch': return 'SWITCH';
      case 'radio': return 'RADIO_GROUP';
      case 'combobox': return 'COMBOBOX';
      case 'listbox': return s?.multiple ? 'SELECT_MANY' : 'SELECT_ONE';
      case 'slider': return 'RANGE';
      case 'spinbutton': return 'NUMBER';
      case 'textbox': return t === null ? 'TEXT_RICH' : 'TEXT_SINGLE';
      case 'searchbox': return 'TEXT_SINGLE';
    }
  }
  if (t === 'file') return 'FILE';
  if (t === 'submit' || t === 'reset' || t === 'button' || t === 'image' || r === 'button') return 'BUTTON';
  if (t === 'textarea') return 'TEXT_MULTILINE';
  if (t === 'select-one') return 'SELECT_ONE';
  if (t === 'select-multiple') return 'SELECT_MANY';
  if (t === 'radio' || r === 'radio' || r === 'radiogroup') return 'RADIO_GROUP';
  if (t === 'checkbox' || r === 'checkbox') return 'CHECKBOX_SINGLE';
  if (r === 'switch') return 'SWITCH';
  if (t === 'number') return 'NUMBER';
  if (t === 'range' || r === 'slider') return 'RANGE';
  if (r === 'spinbutton') return 'NUMBER';
  if (t === 'date' || t === 'month' || t === 'week' || t === 'time' || t === 'datetime-local') return 'DATE';
  // A text input whose placeholder is a closed date mask is a DATE by page
  // evidence, not by label inference.
  if (t === 'text' && (s?.placeholderShape === 'MONTH_YEAR_MASK' || s?.placeholderShape === 'DATE_MASK')) return 'DATE';
  if (r === 'combobox') return 'COMBOBOX';
  if (r === 'listbox') return s?.multiple ? 'SELECT_MANY' : 'SELECT_ONE';
  if (t === 'text' || t === 'email' || t === 'tel' || t === 'url' || t === 'search' || t === 'color') return 'TEXT_SINGLE';
  return 'UNKNOWN';
}

/**
 * The compiler's own kind for a bare role/type shape, with no sidecar evidence.
 * UA-1 reads this instead of restating the native-type / ARIA-role priority.
 */
export function formalKindOfShape(shape: ControlShape): LogicalControlKind {
  return baseKind(shape, null);
}

/**
 * A pure action by the compiler's own priority: BUTTON, and only BUTTON. A
 * form-control role on a <button> is a question (Radix/Headless-UI), a
 * type=file with role=button is FILE, a password is PASSWORD -- none of them
 * is an action, whatever hides it.
 */
export function isPureActivatorShape(shape: ControlShape): boolean {
  return formalKindOfShape(shape) === 'BUTTON';
}

function dateShapeOf(c: PilotUa1VisibleControl, kind: LogicalControlKind, s: StructureSidecarEntry | null): DateShape | null {
  if (kind !== 'DATE') return null;
  switch (c.inputType) {
    case 'date': return 'NATIVE_DATE';
    case 'month': return 'NATIVE_MONTH';
    case 'week': return 'NATIVE_WEEK';
    case 'time': return 'NATIVE_TIME';
    case 'datetime-local': return 'NATIVE_DATETIME_LOCAL';
    default: return s?.placeholderShape === 'MONTH_YEAR_MASK' || s?.placeholderShape === 'DATE_MASK' ? 'TEXT_MASKED' : 'TEXT_FREE';
  }
}

interface RawLogical {
  kind: LogicalControlKind;
  members: LogicalControlMember[];
  grouping: GroupingEvidence;
  options: LogicalOption[];
  optionsIncomplete: boolean;
  required: boolean;
  disabled: boolean;
  readOnly: boolean;
  accessibleName: string | null;
  label: string | null;
  legend: string | null;
  autocomplete: readonly string[];
  dateShape: DateShape | null;
  documentOrder: number;
}

export interface GroupingInput {
  readonly controls: readonly PilotUa1VisibleControl[];
  readonly structure: StructureSidecar | null;
}

export interface GroupingResult {
  readonly controls: readonly LogicalControl[];
  /**
   * `c<packet position>:<identityDigest>` → logical control id, one entry per
   * OBSERVATION. Keying by address alone would silently merge two controls that
   * share a UA-1 address, and the totality check could not see the loss.
   */
  readonly observationIndex: Readonly<Record<string, Digest64>>;
  /** Observed controls that reached no logical control. Non-empty means fail closed. */
  readonly unplaced: readonly Digest64[];
}

export function buildLogicalControls(epoch: GroupingInput, digest: Digest): GroupingResult {
  const sidecar = new Map<Digest64, StructureSidecarEntry>();
  for (const e of epoch.structure?.entries ?? []) sidecar.set(e.identityDigest, e);
  const order = (d: Digest64, fallback: number): number => sidecar.get(d)?.documentOrder ?? fallback;
  const optionsOf = (c: PilotUa1VisibleControl, s: StructureSidecarEntry | null): LogicalOption[] =>
    c.options.map((o, i) => ({
      identityDigest: o.identityDigest,
      accessibleName: o.accessibleName,
      placeholder: s?.placeholderOptionIndexes.includes(i) ?? false,
    }));
  const memberOption = (c: PilotUa1VisibleControl): LogicalOption =>
    ({ identityDigest: c.identityDigest, accessibleName: c.accessibleName ?? c.label ?? '', placeholder: false });

  const raws: RawLogical[] = [];
  const placed = new Set<Digest64>();
  const groupByKey = new Map<string, RawLogical>();
  const groupControls = new Map<Digest64, RawLogical>();

  const controlsInOrder = [...epoch.controls].map((c, i) => ({ c, i }))
    .sort((a, b) => order(a.c.identityDigest, a.i) - order(b.c.identityDigest, b.i));

  // Pass 1: a role=radiogroup container becomes the group owner, so its own
  // role=radio children are counted once instead of twice.
  for (const { c, i } of controlsInOrder) {
    if (c.role !== 'radiogroup') continue;
    const s = sidecar.get(c.identityDigest) ?? null;
    const raw: RawLogical = {
      kind: 'RADIO_GROUP',
      members: [{ identityDigest: c.identityDigest, role: 'NATIVE_TARGET' }],
      grouping: 'RADIOGROUP_OPTIONS',
      options: optionsOf(c, s),
      optionsIncomplete: s?.optionsOverflow ?? false,
      required: c.required, disabled: s?.disabled ?? false, readOnly: s?.readOnly ?? false,
      accessibleName: c.accessibleName, label: c.label, legend: c.legend, autocomplete: c.autocomplete,
      dateShape: null, documentOrder: order(c.identityDigest, i),
    };
    raws.push(raw);
    groupControls.set(c.identityDigest, raw);
    placed.add(c.identityDigest);
  }

  // Pass 2: everything else.
  let lastLegendGroup: { legend: string; kind: 'RADIO_GROUP' | 'CHECKBOX_GROUP'; raw: RawLogical } | null = null;
  for (const { c, i } of controlsInOrder) {
    if (placed.has(c.identityDigest)) continue;
    const s = sidecar.get(c.identityDigest) ?? null;
    const kind = baseKind(c, s);
    const docOrder = order(c.identityDigest, i);

    // Member of a radiogroup owner seen in pass 1: exact evidence.
    const owner = s?.memberOfGroupControl ? groupControls.get(s.memberOfGroupControl) : undefined;
    if (owner) {
      owner.members.push({ identityDigest: c.identityDigest, role: 'GROUP_MEMBER' });
      owner.required = owner.required || c.required;
      placed.add(c.identityDigest);
      continue;
    }

    const isMemberKind = kind === 'RADIO_GROUP' || kind === 'CHECKBOX_SINGLE';

    // Shared name (form + name attribute digest): exact evidence.
    if (isMemberKind && s?.groupKeyDigest) {
      const key = `name:${s.groupKeyDigest}`;
      const existing = groupByKey.get(key);
      if (existing) {
        existing.members.push({ identityDigest: c.identityDigest, role: 'GROUP_MEMBER' });
        existing.options.push(memberOption(c));
        existing.required = existing.required || c.required;
        if (existing.kind === 'CHECKBOX_SINGLE') existing.kind = 'CHECKBOX_GROUP';
        placed.add(c.identityDigest);
        continue;
      }
      const raw: RawLogical = {
        kind,
        members: [{ identityDigest: c.identityDigest, role: 'GROUP_MEMBER' }],
        grouping: 'SHARED_NAME',
        options: [memberOption(c)],
        optionsIncomplete: false,
        required: c.required, disabled: s.disabled, readOnly: s.readOnly,
        accessibleName: c.legend ?? c.accessibleName, label: c.label, legend: c.legend, autocomplete: c.autocomplete,
        dateShape: null, documentOrder: docOrder,
      };
      raws.push(raw);
      groupByKey.set(key, raw);
      placed.add(c.identityDigest);
      continue;
    }

    // No sidecar: contiguous same-legend members group structurally only. The
    // consumer must treat SHARED_FIELDSET_LEGEND as weaker than exact evidence.
    if (isMemberKind && c.legend !== null && epoch.structure === null) {
      const gk = kind === 'RADIO_GROUP' ? 'RADIO_GROUP' : 'CHECKBOX_GROUP';
      // Only the immediately preceding member-kind control can still be the open
      // group: any other control resets it below, so adjacency needs no ordinal test.
      if (lastLegendGroup && lastLegendGroup.legend === c.legend && lastLegendGroup.kind === gk) {
        const g = lastLegendGroup.raw;
        g.members.push({ identityDigest: c.identityDigest, role: 'GROUP_MEMBER' });
        g.options.push(memberOption(c));
        g.required = g.required || c.required;
        g.kind = gk;
        placed.add(c.identityDigest);
        continue;
      }
      const raw: RawLogical = {
        kind: gk === 'RADIO_GROUP' ? 'RADIO_GROUP' : 'CHECKBOX_SINGLE',
        members: [{ identityDigest: c.identityDigest, role: 'GROUP_MEMBER' }],
        grouping: 'SHARED_FIELDSET_LEGEND',
        options: [memberOption(c)],
        optionsIncomplete: false,
        required: c.required, disabled: false, readOnly: false,
        accessibleName: c.legend, label: c.label, legend: c.legend, autocomplete: c.autocomplete,
        dateShape: null, documentOrder: docOrder,
      };
      raws.push(raw);
      lastLegendGroup = { legend: c.legend, kind: gk, raw };
      placed.add(c.identityDigest);
      continue;
    }
    lastLegendGroup = null;

    raws.push({
      kind,
      members: [{ identityDigest: c.identityDigest, role: 'NATIVE_TARGET' }],
      grouping: 'NONE',
      options: optionsOf(c, s),
      optionsIncomplete: s?.optionsOverflow ?? false,
      required: c.required, disabled: s?.disabled ?? false, readOnly: s?.readOnly ?? false,
      accessibleName: c.accessibleName, label: c.label, legend: c.legend, autocomplete: c.autocomplete,
      dateShape: dateShapeOf(c, kind, s), documentOrder: docOrder,
    });
    placed.add(c.identityDigest);
  }

  // Pass 3: a month select immediately followed by a year select in the same
  // row is one date question, not two choices.
  const merged: RawLogical[] = [];
  const consumed = new Set<RawLogical>();
  const sorted = [...raws].sort((a, b) => a.documentOrder - b.documentOrder);
  for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i]!;
    if (consumed.has(a)) continue;
    const b = sorted[i + 1];
    if (
      b && !consumed.has(b) &&
      a.kind === 'SELECT_ONE' && b.kind === 'SELECT_ONE' &&
      optionsLookLikeMonths(a.options) && optionsLookLikeYears(b.options) &&
      sameRow(sidecar, a, b)
    ) {
      merged.push({
        ...a,
        kind: 'DATE',
        members: [
          { identityDigest: a.members[0]!.identityDigest, role: 'SPLIT_PART' },
          { identityDigest: b.members[0]!.identityDigest, role: 'SPLIT_PART' },
        ],
        grouping: 'NONE',
        options: [],
        optionsIncomplete: a.optionsIncomplete || b.optionsIncomplete,
        required: a.required || b.required, disabled: a.disabled || b.disabled, readOnly: a.readOnly || b.readOnly,
        accessibleName: a.legend ?? a.accessibleName,
        dateShape: 'SPLIT_MONTH_YEAR',
      });
      consumed.add(a);
      consumed.add(b);
      continue;
    }
    merged.push(a);
  }

  const controls: LogicalControl[] = merged.map((r) => {
    // Identity spine: element tokens when the sidecar has them (stable across
    // sibling insert/remove), else the epoch-local UA-1 address digests.
    const memberIds = r.members
      .map((m) => sidecar.get(m.identityDigest)?.elementToken ?? m.identityDigest)
      .sort();
    return Object.freeze({
      id: digest('logical', ...memberIds),
      kind: r.kind,
      members: Object.freeze([...r.members]),
      grouping: r.grouping,
      dateShape: r.dateShape,
      options: Object.freeze([...r.options]),
      optionsIncomplete: r.optionsIncomplete,
      required: r.required,
      disabled: r.disabled,
      readOnly: r.readOnly,
      accessibleName: r.accessibleName,
      label: r.label,
      legend: r.legend,
      autocomplete: r.autocomplete,
    });
  });

  // One index entry per observation. A control the packet lists twice at one
  // address is two observations and must reach two entries or fail closed.
  const ownerOf = new Map<Digest64, Digest64>();
  for (const lc of controls) for (const m of lc.members) ownerOf.set(m.identityDigest, lc.id);
  const observationIndex: Record<string, Digest64> = {};
  const unplaced: Digest64[] = [];
  const takenBy = new Map<Digest64, number>();
  epoch.controls.forEach((c, i) => {
    const owner = ownerOf.get(c.identityDigest);
    if (owner === undefined) { unplaced.push(c.identityDigest); return; }
    const first = takenBy.get(c.identityDigest);
    if (first !== undefined) {
      // The same address twice in one packet: the second observation has no
      // logical control of its own, so it is unplaced rather than absorbed.
      unplaced.push(c.identityDigest);
      return;
    }
    takenBy.set(c.identityDigest, i);
    observationIndex[`c${i}:${c.identityDigest}`] = owner;
  });
  return { controls, observationIndex, unplaced };
}

function sameRow(sidecar: Map<Digest64, StructureSidecarEntry>, a: RawLogical, b: RawLogical): boolean {
  const ra = sidecar.get(a.members[0]!.identityDigest)?.row ?? null;
  const rb = sidecar.get(b.members[0]!.identityDigest)?.row ?? null;
  if (ra === null && rb === null) return true;
  if (ra === null || rb === null) return false;
  return ra.rowGroupDigest === rb.rowGroupDigest && ra.rowElementToken === rb.rowElementToken;
}
