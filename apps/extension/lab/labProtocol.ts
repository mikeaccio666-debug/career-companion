/**
 * ATS lab command channel (VIBE_DIST=ats-lab only).
 *
 * Two transports carry the same commands: extension runtime messages (toolbar
 * action, lab page) and a page-visible DOM event that the Playwright harness
 * dispatches from the main world. Because objects do not cross worlds, the
 * DOM event carries a JSON string and results are published as a JSON string
 * attribute on the document element. This channel exists only in lab builds.
 */

export const LAB_COMMAND_EVENT = 'edaix-lab:command';
export const LAB_READY_ATTRIBUTE = 'data-edaix-lab';
export const LAB_RESULT_ATTRIBUTE_PREFIX = 'data-edaix-lab-result-';

export type LabCommandKind = 'probe' | 'scan' | 'fill' | 'next' | 'prestep' | 'snapshot' | 'dom' | 'status';

export interface LabCommandOptions {
  /** fill: overwrite non-empty controls too (default false = fill empty only). */
  readonly overwrite?: boolean;
  /** fill: add mock answers for questions the profile cannot answer (default true). */
  readonly mockAnswers?: boolean;
  /** fill: answer self-identification questions with a decline option (default true). */
  readonly selfIdentification?: boolean;
  /** prestep: let the lab accept a vendor's data-consent gate for the mock applicant (default false). */
  readonly consentGates?: boolean;
}

export interface LabCommand {
  readonly id: string;
  readonly kind: LabCommandKind;
  readonly options?: LabCommandOptions;
}

const LAB_COMMAND_KINDS: readonly string[] = ['probe', 'scan', 'fill', 'next', 'prestep', 'snapshot', 'dom', 'status'];

export function parseLabCommand(raw: unknown): LabCommand | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { id?: unknown; kind?: unknown; options?: unknown };
  if (typeof candidate.id !== 'string' || typeof candidate.kind !== 'string') return null;
  if (!LAB_COMMAND_KINDS.includes(candidate.kind)) return null;
  const rawOptions = typeof candidate.options === 'object' && candidate.options !== null
    ? (candidate.options as { overwrite?: unknown; mockAnswers?: unknown; selfIdentification?: unknown; consentGates?: unknown })
    : null;
  const options: LabCommandOptions | undefined = rawOptions === null
    ? undefined
    : {
        overwrite: rawOptions.overwrite === true,
        mockAnswers: rawOptions.mockAnswers !== false,
        selfIdentification: rawOptions.selfIdentification !== false,
        consentGates: rawOptions.consentGates === true,
      };
  return {
    id: candidate.id,
    kind: candidate.kind as LabCommandKind,
    ...(options ? { options } : {}),
  };
}
