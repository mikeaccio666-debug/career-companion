/**
 * UA-1 StructureSidecarV1 producer.
 *
 * The certified #164 semantic compiler already knows how to group radio and
 * checkbox members, how to keep a row identity across ordinal shifts, and how
 * to tell one control from another at the same DOM address. It reads that from
 * a StructureSidecarV1 — and until now nothing produced one, so every real page
 * compiled on the degraded path: grouping fell back to fieldset legends and
 * identity fell back to the UA-1 address.
 *
 * This module owns only the ASSEMBLY half. Element-derived evidence is gathered
 * at the scan site (pilotUa1DiscoveryRuntime.ts) because element identity only
 * exists there; nothing here touches the DOM. No grouping, row-identity,
 * terminal or writer decision is re-implemented here: this emits evidence, and
 * the compiler remains the single authority on what the evidence means.
 *
 * Value-free by construction. Raw names, labels, placeholders, option text and
 * values are digest INPUTS only, salted with the per-lifecycle nonce; none of
 * them, and no selector or HTML, appears in the output.
 */
import type { PreparePilotUa4WriterBatchInput } from '@edaix/apply-kernel/pilotUa4Writer';

type SemanticEpoch = PreparePilotUa4WriterBatchInput['semanticEpochs'][number];
export type PilotUa1StructureSidecar = NonNullable<SemanticEpoch['structure']>;
export type PilotUa1StructureSidecarEntry = PilotUa1StructureSidecar['entries'][number];

/**
 * The compiler version this producer emits for. `compileGraph` fails closed on
 * a mismatch, so a compiler bump degrades to today's behaviour rather than
 * letting a stale sidecar re-group a packet it no longer describes.
 * Pinned against the kernel constant by test, never imported: semantic/** is
 * deliberately not a package export.
 */
export const PILOT_UA1_SIDECAR_COMPILER_VERSION = 'semantic-compiler-1';

/**
 * The compiler's `Digest` is a caller-supplied port, so its part-joining
 * convention is the only thing a producer can bind to. This reproduces it, and
 * a test pins it against the kernel's own `packetDigestOf`. A consumer that
 * joins differently simply fails closed with SIDECAR_MISMATCH — never a wrong
 * grouping.
 */
export const PILOT_UA1_DIGEST_PART_SEPARATOR = ' ';

export type PilotUa1PlaceholderShape = NonNullable<PilotUa1StructureSidecarEntry['placeholderShape']>;

/** Row evidence as observed in the DOM, before it is digested. */
export interface PilotUa1RawRow {
  /** Structural path of the repeating container these rows belong to. */
  readonly groupPath: string;
  readonly ordinal: number;
  /** Member shape of this row: control kinds plus their accessible names. */
  readonly shapeKey: string;
  /** First-sight ordinal of the row container Element in this lifecycle. */
  readonly rowElementSeq: number;
}

/** Per-control evidence the scan site gathered for one emitted control. */
export interface PilotUa1RawStructureEntry {
  /** Path of the control this entry describes; maps to its identityDigest. */
  readonly path: string;
  /** First-sight ordinal of the control Element in this lifecycle. */
  readonly elementSeq: number;
  /** `<form path> <name attribute>` for a named radio/checkbox; else null. */
  readonly groupKeyRaw: string | null;
  /** Path of the enclosing role=radiogroup control, when it was also emitted. */
  readonly memberOfGroupControlPath: string | null;
  readonly row: PilotUa1RawRow | null;
  readonly placeholderShape: PilotUa1PlaceholderShape | null;
  readonly placeholderOptionIndexes: readonly number[];
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly multiple: boolean;
}

export interface BuildPilotUa1StructureSidecarInput {
  /** The exact parsed packet controls, in packet order. */
  readonly controls: readonly Readonly<{ identityDigest: string }>[];
  /** One raw entry per emitted control, in the same order. */
  readonly raw: readonly PilotUa1RawStructureEntry[];
  readonly lifecycleNonce: string;
  readonly epochIndex: number;
  /**
   * The scan's own drop accounting, now carried on the UA-1 wire. The sidecar's
   * conservation counts must state exactly what the packet states, or
   * `compileGraph` fails closed -- which is why these are passed in rather than
   * assumed to be zero.
   */
  readonly suppressedCount: number;
  readonly hiddenNotObservedCount: number;
  /**
   * False when the scan pruned a subtree it could not prove it counted. The
   * counts above are then a floor rather than a total, and a floor recorded as
   * a conservation count would read as exact -- so no sidecar is emitted at all.
   * There is no non-counting diagnostic channel on this surface today, and this
   * change deliberately does not invent one.
   */
  readonly conserved: boolean;
  readonly digest: (value: string) => Promise<string | null>;
}

/** Reproduces the compiler's `Digest(...parts)` for a producer-side value. */
async function digestParts(
  digest: BuildPilotUa1StructureSidecarInput['digest'],
  ...parts: readonly string[]
): Promise<string | null> {
  return digest(parts.join(PILOT_UA1_DIGEST_PART_SEPARATOR));
}

/**
 * Salted with the lifecycle nonce so a token is meaningless outside the page
 * lifecycle that minted it, and so a raw name can never be recovered from it.
 */
function nonced(nonce: string, kind: string, value: string): string {
  return `${nonce}:${kind}:${value}`;
}

export async function buildPilotUa1StructureSidecar(
  input: BuildPilotUa1StructureSidecarInput,
): Promise<PilotUa1StructureSidecar | null> {
  if (!input.conserved) return null;
  if (input.raw.length !== input.controls.length) return null;

  const identityByPath = new Map<string, string>();
  input.raw.forEach((entry, index) => {
    identityByPath.set(entry.path, input.controls[index]!.identityDigest);
  });

  const entries: PilotUa1StructureSidecarEntry[] = [];
  for (const [index, entry] of input.raw.entries()) {
    const identityDigest = input.controls[index]!.identityDigest;
    const elementToken = await digestParts(
      input.digest,
      nonced(input.lifecycleNonce, 'element', String(entry.elementSeq)),
    );
    if (elementToken === null) return null;

    let groupKeyDigest: string | null = null;
    if (entry.groupKeyRaw !== null) {
      groupKeyDigest = await digestParts(
        input.digest,
        nonced(input.lifecycleNonce, 'group', entry.groupKeyRaw),
      );
      if (groupKeyDigest === null) return null;
    }

    let row: PilotUa1StructureSidecarEntry['row'] = null;
    if (entry.row !== null) {
      const rowGroupDigest = await digestParts(
        input.digest,
        nonced(input.lifecycleNonce, 'rowgroup', entry.row.groupPath),
      );
      const shapeDigest = await digestParts(
        input.digest,
        nonced(input.lifecycleNonce, 'rowshape', entry.row.shapeKey),
      );
      const rowElementToken = await digestParts(
        input.digest,
        nonced(input.lifecycleNonce, 'rowelement', String(entry.row.rowElementSeq)),
      );
      if (rowGroupDigest === null || shapeDigest === null || rowElementToken === null) return null;
      row = Object.freeze({
        rowGroupDigest,
        ordinal: entry.row.ordinal,
        shapeDigest,
        rowElementToken,
      });
    }

    // A member whose group control was not itself emitted has no exact parent
    // evidence; null is the honest answer, and the compiler then counts it on
    // its own rather than folding it into a group it cannot prove.
    const memberOfGroupControl = entry.memberOfGroupControlPath === null
      ? null
      : identityByPath.get(entry.memberOfGroupControlPath) ?? null;

    entries.push(Object.freeze({
      identityDigest,
      elementToken,
      groupKeyDigest,
      row,
      documentOrder: index,
      memberOfGroupControl,
      placeholderShape: entry.placeholderShape,
      // The scan fails closed on an option list longer than the packet bound,
      // so any packet that exists observed every option of every control.
      optionsOverflow: false,
      placeholderOptionIndexes: Object.freeze([...entry.placeholderOptionIndexes]),
      disabled: entry.disabled,
      readOnly: entry.readOnly,
      multiple: entry.multiple,
    }));
  }

  const packetDigest = await digestParts(
    input.digest,
    'packet',
    JSON.stringify(input.controls),
  );
  if (packetDigest === null) return null;

  return Object.freeze({
    schemaVersion: 1 as const,
    packetDigest,
    epochIndex: input.epochIndex,
    compilerVersion: PILOT_UA1_SIDECAR_COMPILER_VERSION,
    counts: Object.freeze({
      controls: input.controls.length,
      entries: entries.length,
      suppressed: input.suppressedCount,
      hiddenNotObserved: input.hiddenNotObservedCount,
    }),
    entries: Object.freeze(entries),
  });
}
