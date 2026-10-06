/**
 * Shared vocabulary for job ingestion: run kinds, run states, the decision a
 * scheduler reaches, and the run-log row the admin console renders.
 *
 * Transport is deliberately absent. Whether the supervisor reaches this
 * decision over HTTP or in-process is an open question (it costs a new
 * machine-authentication path either way), and shipping request/response
 * shapes for a transport nobody has chosen would be dead wire surface.
 *
 * Additive L1 slice. Nothing here activates a runtime; the ingestion policy is
 * default-off and fails closed independently.
 */
import type { AgentSchemaEnvelope, IsoDateTime, Uuid } from './common.ts';

export const JOB_INGESTION_RUN_KINDS = ['SCRAPE', 'LIVENESS'] as const;
export type JobIngestionRunKind = (typeof JOB_INGESTION_RUN_KINDS)[number];

export const JOB_INGESTION_RUN_STATES = [
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
] as const;
export type JobIngestionRunState = (typeof JOB_INGESTION_RUN_STATES)[number];

export const JOB_INGESTION_CLAIM_DECISIONS = ['RUN', 'SKIP'] as const;
export type JobIngestionClaimDecision =
  (typeof JOB_INGESTION_CLAIM_DECISIONS)[number];

/**
 * Stable reason codes. The supervisor branches on these and logs nothing else;
 * a SKIP is a normal outcome, not an error, so cron must not treat it as one.
 */
export const JOB_INGESTION_CLAIM_REASONS = [
  /** No prior run of this kind — first execution. */
  'NEVER_RUN',
  /** The configured interval has elapsed since the last run finished. */
  'INTERVAL_ELAPSED',
  /**
   * A prior run has been RUNNING past the stale window and is presumed dead.
   *
   * Only reachable where automatic reclaim is switched on. Reclaiming ends one
   * run and starts another, and nothing stops the previous holder's writes from
   * landing after that point — see `EXPIRED_RUN_NOT_RECLAIMED`.
   */
  'STALE_RUN_RECLAIMED',
  /**
   * A prior run stopped renewing, so its holder is presumed dead, but this
   * deployment does not take runs over automatically.
   *
   * The reason it does not: killing the previous supervisor is not a write
   * fence. The scraper writes through PostgREST with no run id and no lease
   * check, so requests already in flight land whatever the scheduler decides,
   * and the wrapper only notices a lost lease a renewal cycle later. Claiming a
   * new run at that moment can put two writers on the same targets — precisely
   * what the single-active-run index exists to prevent, bypassed from the
   * scheduling side.
   *
   * So this is a SKIP that needs a person: the pipeline stops until someone
   * confirms the old holder is gone. That is the safe direction while writes
   * are unfenced, and it is a normal outcome, not an error.
   */
  'EXPIRED_RUN_NOT_RECLAIMED',
  /** A prior run is still RUNNING inside its window. */
  'ALREADY_RUNNING',
  /** The interval has not elapsed yet. */
  'NOT_DUE',
  /** Ingestion scheduling is switched off for this deployment. */
  'DISABLED',
] as const;
export type JobIngestionClaimReason =
  (typeof JOB_INGESTION_CLAIM_REASONS)[number];

/** One row of the run log as the admin console renders it. */
export interface JobIngestionRunView extends AgentSchemaEnvelope {
  readonly runId: Uuid;
  readonly runKind: JobIngestionRunKind;
  readonly runState: JobIngestionRunState;
  readonly startedAt: IsoDateTime;
  readonly finishedAt: IsoDateTime | null;
  /**
   * When the holder last renewed its lease, or null for a run claimed before
   * leases existed. For a RUNNING row this is the field that separates "still
   * working" from "wedged": startedAt only says how long ago it began, which is
   * why the scheduler stopped judging on it.
   */
  readonly heartbeatAt: IsoDateTime | null;
  readonly targetsAttempted: number;
  readonly targetsSucceeded: number;
  readonly rowsWritten: number;
  readonly failureReason: string | null;
}

export interface JobIngestionRunListResponse extends AgentSchemaEnvelope {
  readonly items: readonly JobIngestionRunView[];
}

/**
 * Page size for the console. The run log is an operational tail, not a data
 * set: an operator asks "what happened lately", and a bound keeps a long-lived
 * deployment from shipping years of history to a browser.
 */
export const JOB_INGESTION_RUN_LIST_LIMIT = 50;

/**
 * Counter ceilings. A supervisor that reports beyond these is malfunctioning or
 * lying; the API rejects rather than storing a number it cannot have produced.
 */
export const JOB_INGESTION_MAX_TARGETS = 100_000;
export const JOB_INGESTION_MAX_ROWS_WRITTEN = 10_000_000;
export const JOB_INGESTION_SUPERVISOR_ID_MAX_LENGTH = 64;
export const JOB_INGESTION_FAILURE_REASON_MAX_LENGTH = 128;

const SUPERVISOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const FAILURE_REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;

export function isJobIngestionRunKind(
  value: unknown,
): value is JobIngestionRunKind {
  return (
    typeof value === 'string' &&
    (JOB_INGESTION_RUN_KINDS as readonly string[]).includes(value)
  );
}

export function isJobIngestionSupervisorId(value: unknown): value is string {
  return typeof value === 'string' && SUPERVISOR_ID_PATTERN.test(value);
}

/**
 * Failure reasons are screaming-snake stable codes. The pattern is the contract
 * boundary that keeps Data-L1 — page text, emails, URLs — out of the run log:
 * none of it can survive this shape.
 */
export function isJobIngestionFailureReason(value: unknown): value is string {
  return typeof value === 'string' && FAILURE_REASON_PATTERN.test(value);
}
