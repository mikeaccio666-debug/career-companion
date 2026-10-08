import type { PoolClient } from 'pg';
import type {
  CompanionBirthCommand, CompanionBirthViewerState, CompanionPublicInkToken,
  PublicCompanionBirthReceipt, PublicCompanionSealCandidates,
} from '@companion/platform-contracts';
import type { FixedSessionContext } from './auth.ts';
import type { CompanionSealRendered } from './companion-seal-rendering.ts';

/** Server-captured source facts. These are neither HTTP inputs nor execution grants. */
export interface BirthIdentityCapture {
  readonly identityDraftId: string;
  readonly companionId: string;
  readonly taskId: string;
  readonly identityRevision: number;
  readonly name: string;
  readonly nameOrigin: 'user_typed';
  readonly sealChar: string;
  readonly sealCandidates: PublicCompanionSealCandidates;
  readonly inkToken: CompanionPublicInkToken;
  readonly selectionId: string;
  readonly selectionOperationId: string;
  readonly selectionRevision: number;
  readonly nameApplicationOperationId: string;
  readonly nameSubmissionId: string;
  readonly nameGeneration: number;
  readonly bundleRevision: number;
  readonly contentDigest: string;
  readonly reviewDigest: string;
  readonly identityPayloadDigest: string;
  readonly selectionPayloadDigest: string;
  readonly selectionOperationPayloadDigest: string;
}

export interface BirthCapture {
  readonly ownerId: string;
  readonly acceptedAuthVersion: string;
  readonly terms: Readonly<{ version: string; contentDigest: string; reviewDigest: string }>;
  readonly task: Readonly<{
    id: string; companionId: string; answersId: string; generation: number;
    sourceDraftId: string; sourceRevision: number; sourceReceiptVersion: 1 | 2 | null;
  }>;
  readonly prefix: Readonly<{ id: string; version: 1 | 2; digest: string }> | null;
  readonly inventory: Readonly<{ tipId: string; revision: number; tipDigest: string }>;
  readonly identity: Readonly<BirthIdentityCapture>;
}

/** Own-origin persistence uses the caller's transaction. A storage decoder never
 * grants admission to a new birth or invokes a current-policy/model gate. */
export interface BirthOriginStore {
  findOwn(client: PoolClient, ownerId: string, key: string): Promise<null | Readonly<{
    request: Readonly<CompanionBirthCommand>;
    receipt: Readonly<PublicCompanionBirthReceipt>;
  }>>;
  assertUnborn(client: PoolClient, ownerId: string): Promise<void>;
  writeAtomic(client: PoolClient, context: FixedSessionContext,
    command: Readonly<CompanionBirthCommand>, capture: Readonly<BirthCapture>,
    rendered: Readonly<CompanionSealRendered>, signal?: AbortSignal): Promise<Readonly<PublicCompanionBirthReceipt>>;
  readCurrent(client: PoolClient, ownerId: string): Promise<CompanionBirthViewerState>;
  readSealAsset(client: PoolClient, ownerId: string, assetId: string): Promise<Readonly<CompanionSealRendered> | null>;
}
