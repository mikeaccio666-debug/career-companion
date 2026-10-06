/**
 * L2 · Observation epochs → question graph (S1, kernel lane).
 *
 * Pure functions. The only cross-epoch state is row incarnation: which repeated
 * row is still the same row after the host adds, removes or re-renders one
 * (F-06). Everything else is per-epoch.
 *
 * Fails closed, and proves it before returning: a broken epoch chain, a sidecar
 * that does not bind to the exact packet, contradictory evidence, or a single
 * observation that reaches no node stops the compile with a stable reason. The
 * finished graph is run through the conservation checker before it ships, so an
 * internally inconsistent graph is never handed to a consumer.
 */

import type { PilotUa1PageBinding, PilotUa1VisibleControl } from '@edaix/contracts/draft';
import { buildLogicalControls, type Digest } from './grouping.ts';
import { checkInvariants } from './invariants.ts';
import type {
  Digest64,
  LogicalControl,
  Node,
  ObservationEpoch,
  ObservationEpochCause,
  QuestionGraph,
  QuestionGraphCompile,
  RowIncarnation,
  StructureSidecar,
  StructureSidecarEntry,
} from './ir.ts';

export const SEMANTIC_COMPILER_VERSION = 'semantic-compiler-1' as const;

/** Exact packet digest: a StructureSidecarV1 binds to this, never to the binding alone. */
export function packetDigestOf(controls: readonly PilotUa1VisibleControl[], digest: Digest): Digest64 {
  return digest('packet', JSON.stringify(controls));
}

export interface EpochInput {
  readonly cause: ObservationEpochCause;
  readonly binding: PilotUa1PageBinding;
  /** The certified UA-1 packet controls, byte-for-byte. */
  readonly controls: readonly PilotUa1VisibleControl[];
  readonly structure: StructureSidecar | null;
  /** Digests of controls UA-1 observed but suppressed (honeypots). */
  readonly suppressedControls: readonly Digest64[];
  /** Hidden natives the scan saw but did not emit (no identity yet). */
  readonly hiddenNotObservedCount: number;
  /** After our own addRow: the row group we added to, so its origin is not guessed. */
  readonly attributedAddRowGroup: Digest64 | null;
}

type Fail = Extract<QuestionGraphCompile, { ok: false }>;
const fail = (reason: Fail['reason'], unplaced: readonly Digest64[] = []): Fail =>
  ({ ok: false, code: 'COMPILE_INCOMPLETE', unplaced, reason });

function sidecarBound(input: EpochInput, index: number, digest: Digest): boolean {
  const sc = input.structure;
  if (sc === null) return true;
  const known = new Set(input.controls.map((c) => c.identityDigest));
  return (
    sc.schemaVersion === 1 &&
    sc.packetDigest === packetDigestOf(input.controls, digest) &&
    sc.epochIndex === index &&
    sc.compilerVersion === SEMANTIC_COMPILER_VERSION &&
    sc.counts.controls === input.controls.length &&
    sc.counts.entries === sc.entries.length &&
    sc.counts.suppressed === input.suppressedControls.length &&
    sc.counts.hiddenNotObserved === input.hiddenNotObservedCount &&
    // One entry per control. Two entries for one control is contradictory
    // evidence, and last-write-wins would silently discard the first.
    new Set(sc.entries.map((e) => e.identityDigest)).size === sc.entries.length &&
    sc.entries.every((e) => known.has(e.identityDigest))
  );
}

/** Within one epoch a row slot must report one ordinal and one shape. */
function rowEvidenceConsistent(sc: StructureSidecar | null): boolean {
  if (sc === null) return true;
  const seen = new Map<string, string>();
  for (const e of sc.entries) {
    if (!e.row) continue;
    const slot = `${e.row.rowGroupDigest}:${e.row.rowElementToken}`;
    const claim = `${e.row.ordinal}:${e.row.shapeDigest}`;
    const first = seen.get(slot);
    if (first !== undefined && first !== claim) return false;
    seen.set(slot, claim);
  }
  return true;
}

function suppressedControl(d: Digest64, digest: Digest): LogicalControl {
  return Object.freeze({
    id: digest('logical', d),
    kind: 'UNKNOWN' as const,
    members: Object.freeze([{ identityDigest: d, role: 'NATIVE_TARGET' as const }]),
    grouping: 'NONE' as const,
    dateShape: null,
    options: Object.freeze([]),
    optionsIncomplete: false,
    required: false,
    disabled: false,
    readOnly: false,
    accessibleName: null,
    label: null,
    legend: null,
    autocomplete: Object.freeze([]),
  });
}

interface GraphState {
  epochs: ObservationEpoch[];
  nodes: Map<Digest64, Node>;
  /** Keyed by incarnation token: a slot may hold several incarnations over time. */
  rows: Map<Digest64, RowIncarnation>;
  /** Slot → the incarnation currently occupying it. */
  slotToken: Map<string, Digest64>;
  observationIndex: Record<string, Digest64>;
  controlIndex: Record<Digest64, Digest64>;
}

export function compileGraph(inputs: readonly EpochInput[], digest: Digest): QuestionGraphCompile {
  const st: GraphState = {
    epochs: [], nodes: new Map(), rows: new Map(), slotToken: new Map(),
    observationIndex: {}, controlIndex: {},
  };
  const generations = new Set<Digest64>();

  for (let k = 0; k < inputs.length; k += 1) {
    const input = inputs[k]!;
    const previous = st.epochs[k - 1] ?? null;
    // A generation the chain has already seen is not a new observation. Same-URL
    // in-place injection must mint a fresh one, so a repeat anywhere in the
    // chain is the signature we fence, not only a repeat of the previous epoch.
    if (generations.has(input.binding.domGeneration)) return fail('EPOCH_CHAIN_BROKEN');
    generations.add(input.binding.domGeneration);

    if (!sidecarBound(input, k, digest) || !rowEvidenceConsistent(input.structure)) {
      return fail('SIDECAR_MISMATCH');
    }
    // A control cannot be both emitted and suppressed in one epoch: that single
    // observation would otherwise reach two nodes.
    const emitted = new Set(input.controls.map((c) => c.identityDigest));
    const overlap = input.suppressedControls.filter((d) => emitted.has(d));
    if (overlap.length > 0) return fail('MEMBER_IN_TWO_CONTROLS', overlap);

    const { controls, observationIndex, unplaced } = buildLogicalControls(input, digest);
    if (unplaced.length > 0) return fail('UNPLACED_OBSERVATION', unplaced);
    // The digest is injected. A weak one that collides would give two distinct
    // logical controls the same id, and they would silently share a node while
    // every totality check still passed. Refuse rather than lose a control.
    const ids = new Set(controls.map((c) => c.id));
    if (ids.size !== controls.length) return fail('INVARIANT_VIOLATION', [...ids]);
    for (const [slot, lc] of Object.entries(observationIndex)) st.observationIndex[`${k}:${slot}`] = lc;

    const sidecar = new Map<Digest64, StructureSidecarEntry>();
    for (const e of input.structure?.entries ?? []) sidecar.set(e.identityDigest, e);

    // Row incarnations (I3). A slot keeps its incarnation across an ordinal
    // shift; a re-render mints a new one and the old one stays in the graph,
    // retired, so a consumer can still resolve a node written before the change.
    const seenSlots = new Set<string>();
    const rowByControl = new Map<Digest64, RowIncarnation>();
    const bornThisEpoch: RowIncarnation[] = [];
    const keptThisEpoch = new Set<Digest64>();
    for (const lc of controls) {
      const r = sidecar.get(lc.members[0]!.identityDigest)?.row ?? null;
      if (!r) continue;
      const slot = `${r.rowGroupDigest}:${r.rowElementToken}`;
      seenSlots.add(slot);
      const currentToken = st.slotToken.get(slot);
      const current = currentToken === undefined ? undefined : st.rows.get(currentToken);
      let incarnation: RowIncarnation;
      if (current && current.retiredAtEpoch === null) {
        incarnation = { ...current, currentOrdinal: r.ordinal };
        keptThisEpoch.add(incarnation.token);
      } else {
        incarnation = {
          rowGroupDigest: r.rowGroupDigest,
          rowElementToken: r.rowElementToken,
          token: digest('incarnation', r.rowGroupDigest, String(k), String(r.ordinal), r.rowElementToken, r.shapeDigest),
          birthEpoch: k,
          currentOrdinal: r.ordinal,
          retiredAtEpoch: null,
          origin: 'HOST_PRESENT',
        };
        bornThisEpoch.push(incarnation);
      }
      st.rows.set(incarnation.token, incarnation);
      st.slotToken.set(slot, incarnation.token);
      rowByControl.set(lc.id, incarnation);
    }

    // A live row whose group was observed this epoch but whose own slot was not
    // is retired. A group absent from this epoch was simply not looked at, and
    // withholding Undo for a row we never checked is worse than keeping it.
    const groupsThisEpoch = new Set([...rowByControl.values()].map((r) => r.rowGroupDigest));
    for (const [slot, token] of st.slotToken) {
      const inc = st.rows.get(token);
      if (!inc || inc.retiredAtEpoch !== null) continue;
      if (!seenSlots.has(slot) && groupsThisEpoch.has(inc.rowGroupDigest)) {
        st.rows.set(token, { ...inc, retiredAtEpoch: k });
      }
    }

    // Our own addRow may be claimed only when the evidence is unambiguous:
    // exactly one new incarnation in that group, and every row that was already
    // live there kept its token. A re-render that replaced the whole list is
    // ambiguous, and over-claiming a host row holding the user's data is the
    // unsafe direction.
    if (input.attributedAddRowGroup !== null && k > 0) {
      const group = input.attributedAddRowGroup;
      const born = bornThisEpoch.filter((r) => r.rowGroupDigest === group);
      const priorLive = [...st.rows.values()].filter(
        (r) => r.rowGroupDigest === group && r.birthEpoch < k && r.retiredAtEpoch === null,
      );
      if (born.length === 1 && priorLive.every((r) => keptThisEpoch.has(r.token))) {
        const added = { ...born[0]!, origin: 'ADDED_BY_US' as const };
        st.rows.set(added.token, added);
        for (const [lcId, inc] of rowByControl) if (inc.token === added.token) rowByControl.set(lcId, added);
      }
    }

    // Suppressed controls stay in the graph so a honeypot is never a silent drop.
    input.suppressedControls.forEach((d, j) => {
      const id = digest('node', 'DECOY', d);
      const lcId = digest('logical', d);
      const key = `${k}:s${j}:${d}`;
      if (st.observationIndex[key] !== undefined && st.observationIndex[key] !== lcId) {
        return;
      }
      st.observationIndex[key] = lcId;
      const existing = st.nodes.get(id);
      st.controlIndex[lcId] = id;
      st.nodes.set(id, existing
        ? { ...existing, lastObservedEpoch: k }
        : { id, kind: 'DECOY', control: suppressedControl(d, digest), firstObservedEpoch: k, lastObservedEpoch: k, rowToken: null });
    });

    for (const lc of controls) {
      const inc = rowByControl.get(lc.id) ?? null;
      const kind: Node['kind'] = lc.kind === 'BUTTON' ? 'ACTION' : 'QUESTION';
      const id = digest('node', kind, lc.id, inc?.token ?? '');
      const existing = st.nodes.get(id);
      if (st.controlIndex[lc.id] !== undefined && st.controlIndex[lc.id] !== id) {
        return fail('CONTROL_IN_TWO_NODES', [lc.id]);
      }
      let node: Node;
      if (kind === 'ACTION') {
        const inputType = input.controls.find((c) => c.identityDigest === lc.members[0]!.identityDigest)?.inputType ?? null;
        node = {
          id, kind: 'ACTION', control: lc, rowToken: inc?.token ?? null,
          firstObservedEpoch: existing?.firstObservedEpoch ?? k, lastObservedEpoch: k,
          actionClass: inputType === 'submit' ? 'SUBMIT' : inputType === 'reset' ? 'RESET' : 'OTHER',
        };
      } else {
        const stem = lc.legend ?? lc.label ?? lc.accessibleName ?? '';
        node = {
          id, kind: 'QUESTION', control: lc, rowToken: inc?.token ?? null,
          firstObservedEpoch: existing?.firstObservedEpoch ?? k, lastObservedEpoch: k,
          stemDigest: digest('stem', stem), required: lc.required,
        };
      }
      st.controlIndex[lc.id] = id;
      st.nodes.set(id, node);
    }

    st.epochs.push({
      schemaVersion: 1, index: k, cause: input.cause, binding: input.binding,
      parentDomGeneration: previous?.binding.domGeneration ?? null,
      controls: input.controls,
      hiddenNotObservedCount: input.hiddenNotObservedCount,
      suppressedControls: input.suppressedControls,
      structure: input.structure,
    });
  }

  const last = inputs[inputs.length - 1];
  if (!last) return fail('EPOCH_CHAIN_BROKEN');
  const graph: QuestionGraph = {
    schemaVersion: 1,
    binding: last.binding,
    epochs: st.epochs,
    nodes: [...st.nodes.values()],
    rows: [...st.rows.values()],
    observationIndex: st.observationIndex,
    controlIndex: st.controlIndex,
  };
  // The checker is the contract. Running it on our own output means a graph that
  // breaks conservation fails closed here instead of reaching a consumer. With
  // the guards above no known input reaches it; it exists so that a future edit
  // which breaks conservation fails here rather than at a writer.
  const violations = checkInvariants(graph);
  if (violations.length > 0) {
    return fail('INVARIANT_VIOLATION', violations.flatMap((v) => v.ids));
  }
  return { ok: true, graph };
}
