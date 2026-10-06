/**
 * 背景 SW ↔ 内容脚本的内部桥协议（刀六b）。
 *
 * 与 chat↔扩展通道**不同边界**：这条桥完全在扩展内部（runtime port，
 * 网页脚本摸不到），所以允许运送 profile 值下行到填表现场——Data-L1
 * 管的是"不出扩展/不进日志"，不是扩展内部的必要流动。上行方向仍然
 * 只有 key/计数/稳定码（scan 结果与回执结果都是 wire-safe 形状）。
 *
 * descriptor（活元素引用）永不过桥：内容脚本本地留存，桥上只走
 * BridgeScan 的可序列化摘要。
 */

import type { ApplyProfileDraft } from '@edaix/apply-kernel/profileDraft';
import type { ExecutionGrant } from '@edaix/agent-channel';
import type { NeedsUserInputKind, ReceiptFieldOutcome } from '@edaix/contracts/draft';
import {
  parseSubmissionArmDescriptor,
  type SubmissionArmDescriptor,
} from './submissionBoundaryProtocol';
import {
  parseRuntimeExecutionAuthorization,
  type RuntimeExecutionAuthorization,
} from './executionRuntimeAuthority';

export const KERNEL_BRIDGE_PORT_NAME = 'edaix-kernel-bridge';

/** 桥两端共用的最小端口面（真实现 = chrome.runtime Port；测试用假端口对）。 */
export interface BridgePortLike {
  postMessage(message: unknown): void;
  onMessage: { addListener(handler: (message: unknown) => void): void };
  onDisconnect: { addListener(handler: () => void): void };
  disconnect(): void;
}

/**
 * Mission-bound resume bytes for one fill (CAP-AF-053). They travel only on this
 * extension-internal port, base64 because the port carries JSON; the background verified
 * the digest and size cap before attaching them, the content side rebuilds the File.
 */
export interface BridgeResumeFile {
  readonly fileName: string;
  readonly sha256: string;
  readonly size: number;
  readonly bytesBase64: string;
}

/** 扫描结果的可序列化形状（与 KernelPageScan 同源，去掉活 descriptor）。 */
export interface BridgeScan {
  readonly jobId: string;
  readonly canonicalOrigin: string;
  readonly fieldKeys: readonly string[];
  readonly scanDigest: string;
}

export type BridgeRequest =
  | {
      readonly kind: 'bridge/discovery-scan';
      readonly requestId: string;
      readonly runtime: RuntimeExecutionAuthorization & { readonly purpose: 'DISCOVERY' };
    }
  | {
      readonly kind: 'bridge/scan';
      readonly requestId: string;
      /** Selector-free binding; complete rules stay in the atomic local cache. */
      readonly runtime?: RuntimeExecutionAuthorization;
    }
  | {
      readonly kind: 'bridge/revalidate-scan';
      readonly requestId: string;
      readonly scanDigest: string;
      readonly canonicalOrigin: string;
      readonly pathname: string;
      /** Must equal the selector-free binding retained with the scan. */
      readonly runtime?: RuntimeExecutionAuthorization;
    }
  | {
      readonly kind: 'bridge/submission-arm';
      readonly requestId: string;
      /** Binds the blocker to the exact locally retained scan descriptor. */
      readonly scanDigest: string;
      readonly descriptor: SubmissionArmDescriptor;
    }
  | {
      readonly kind: 'bridge/fill';
      readonly requestId: string;
      readonly grant: ExecutionGrant;
      /** claim 绑定"那一次扫描"——内容侧与 lastScan 比对，不符全 DETACHED。 */
      readonly scanDigest: string;
      readonly profile: ApplyProfileDraft;
      /** Must equal the binding retained with the exact scan. */
      readonly runtime?: RuntimeExecutionAuthorization;
      /** Only valid together with `runtime`: a verified canonical target is what makes the file attachable. */
      readonly resume?: BridgeResumeFile;
    }
  | { readonly kind: 'bridge/stop'; readonly requestId: string };

export type BridgeEvent =
  | {
      readonly kind: 'bridge/discovery-result';
      readonly requestId: string;
      readonly scan: BridgeScan | null;
    }
  | { readonly kind: 'bridge/scan-result'; readonly requestId: string; readonly scan: BridgeScan | null }
  | {
      readonly kind: 'bridge/revalidate-scan-result';
      readonly requestId: string;
      readonly accepted: boolean;
    }
  | {
      readonly kind: 'bridge/submission-arm-result';
      readonly requestId: string;
      readonly accepted: boolean;
    }
  | { readonly kind: 'bridge/fill-outcome'; readonly requestId: string; readonly outcome: ReceiptFieldOutcome }
  | {
      readonly kind: 'bridge/needs-user-input';
      readonly requestId: string;
      readonly inputKind: NeedsUserInputKind;
      readonly fieldKey?: string;
    }
  | {
      readonly kind: 'bridge/fill-result';
      readonly requestId: string;
      readonly outcomes: readonly ReceiptFieldOutcome[];
    };

const REQUEST_KINDS = [
  'bridge/discovery-scan',
  'bridge/scan',
  'bridge/revalidate-scan',
  'bridge/submission-arm',
  'bridge/fill',
  'bridge/stop',
] as const;
const EVENT_KINDS = [
  'bridge/discovery-result', 'bridge/scan-result',
  'bridge/revalidate-scan-result', 'bridge/submission-arm-result',
  'bridge/fill-outcome', 'bridge/needs-user-input', 'bridge/fill-result',
] as const;
const INPUT_KINDS = ['IN_PAGE_ACTION', 'CHAT_ANSWER', 'SENSITIVE_CONFIRM'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** grant 的运行时形状——parse 的返回类型承诺多少就查多少，不靠 as 白给。 */
function isGrantShape(value: unknown): value is ExecutionGrant {
  if (!isRecord(value)) return false;
  return (
    typeof value['missionId'] === 'string' &&
    typeof value['missionStepId'] === 'string' &&
    isStringArray(value['fieldKeys']) &&
    isStringArray(value['allowedActions']) &&
    typeof value['executionLease'] === 'string' &&
    typeof value['leaseExpiresAt'] === 'number' &&
    typeof value['intentVersion'] === 'number' &&
    typeof value['planDigest'] === 'string' &&
    typeof value['jobIdentityHash'] === 'string' &&
    typeof value['fieldSchemaVersion'] === 'number' &&
    isProfileSnapshotShape(value['profileSnapshot'])
  );
}

function isProfileSnapshotShape(value: unknown): value is ExecutionGrant['profileSnapshot'] {
  if (!isRecord(value)) return false;
  return (
    typeof value['revision'] === 'string' &&
    typeof value['deletionEpoch'] === 'string' &&
    typeof value['snapshotDigest'] === 'string'
  );
}

function isResumeFileShape(value: unknown): value is BridgeResumeFile {
  if (!isRecord(value) || !exactRecord(value, ['fileName', 'sha256', 'size', 'bytesBase64'])) return false;
  return (
    typeof value['fileName'] === 'string' && value['fileName'] !== '' &&
    typeof value['sha256'] === 'string' && /^sha256:[0-9a-f]{64}$/.test(value['sha256']) &&
    Number.isSafeInteger(value['size']) && (value['size'] as number) > 0 &&
    typeof value['bytesBase64'] === 'string' && value['bytesBase64'] !== ''
  );
}

function isOutcomeShape(value: unknown): value is ReceiptFieldOutcome {
  if (!isRecord(value)) return false;
  if (typeof value['key'] !== 'string' || typeof value['ok'] !== 'boolean') return false;
  if ('reason' in value && typeof value['reason'] !== 'string') return false;
  // Data-L1 绊线：outcome 帧带出值类键，整帧作废。
  if ('value' in value || 'label' in value) return false;
  return true;
}

/** fail-closed 结构判定：桥虽在扩展内部，畸形帧也一律丢弃不猜。 */
export function parseBridgeRequest(input: unknown): BridgeRequest | null {
  if (!isRecord(input)) return null;
  const kind = input['kind'];
  if (typeof kind !== 'string' || !(REQUEST_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof input['requestId'] !== 'string' || input['requestId'] === '') return null;
  if (kind === 'bridge/discovery-scan') {
    const runtime = parseRuntimeExecutionAuthorization(input['runtime']);
    if (
      !exactRecord(input, ['kind', 'requestId', 'runtime']) ||
      runtime?.purpose !== 'DISCOVERY'
    ) return null;
  }
  if (kind === 'bridge/scan') {
    const keys = 'runtime' in input
      ? ['kind', 'requestId', 'runtime']
      : ['kind', 'requestId'];
    if (!exactRecord(input, keys)) return null;
    if (
      'runtime' in input &&
      parseRuntimeExecutionAuthorization(input['runtime'])?.purpose !== 'EXECUTION'
    ) {
      return null;
    }
  }
  if (kind === 'bridge/revalidate-scan') {
    const keys = 'runtime' in input
      ? ['kind', 'requestId', 'scanDigest', 'canonicalOrigin', 'pathname', 'runtime']
      : ['kind', 'requestId', 'scanDigest', 'canonicalOrigin', 'pathname'];
    if (
      !exactRecord(input, keys) ||
      typeof input['scanDigest'] !== 'string' ||
      input['scanDigest'] === '' ||
      typeof input['canonicalOrigin'] !== 'string' ||
      input['canonicalOrigin'] === '' ||
      typeof input['pathname'] !== 'string' ||
      !input['pathname'].startsWith('/') ||
      input['pathname'].includes('?') ||
      input['pathname'].includes('#') ||
      ('runtime' in input &&
        parseRuntimeExecutionAuthorization(input['runtime'])?.purpose !== 'EXECUTION')
    ) return null;
  }
  if (kind === 'bridge/submission-arm') {
    if (
      !exactRecord(input, ['kind', 'requestId', 'scanDigest', 'descriptor']) ||
      typeof input['scanDigest'] !== 'string' ||
      input['scanDigest'] === '' ||
      !parseSubmissionArmDescriptor(input['descriptor'])
    ) return null;
  }
  if (kind === 'bridge/fill') {
    const optional = ['runtime', 'resume'].filter((key) => key in input);
    if (!exactRecord(input, ['kind', 'requestId', 'grant', 'scanDigest', 'profile', ...optional])) return null;
    if (!isGrantShape(input['grant'])) return null;
    if (typeof input['scanDigest'] !== 'string' || input['scanDigest'] === '') return null;
    const profile = input['profile'];
    if (!isRecord(profile)) return null;
    if (!Object.values(profile).every((value) => typeof value === 'string')) return null;
    if (
      'runtime' in input &&
      parseRuntimeExecutionAuthorization(input['runtime'])?.purpose !== 'EXECUTION'
    ) {
      return null;
    }
    // A resume without the runtime binding has no verified target behind it: whole frame invalid.
    if ('resume' in input && (!('runtime' in input) || !isResumeFileShape(input['resume']))) return null;
  }
  if (kind === 'bridge/stop' && !exactRecord(input, ['kind', 'requestId'])) return null;
  return input as BridgeRequest;
}

/** 背景端入站帧的对称校验——上行会进 chat 通道回执，不做裸 as 强转。 */
export function parseBridgeEvent(input: unknown): BridgeEvent | null {
  if (!isRecord(input)) return null;
  const kind = input['kind'];
  if (typeof kind !== 'string' || !(EVENT_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof input['requestId'] !== 'string' || input['requestId'] === '') return null;
  switch (kind) {
    case 'bridge/discovery-result':
    case 'bridge/scan-result': {
      if (!exactRecord(input, ['kind', 'requestId', 'scan'])) return null;
      const scan = input['scan'];
      if (scan === null) break;
      if (
        !isRecord(scan) ||
        !exactRecord(scan, ['jobId', 'canonicalOrigin', 'fieldKeys', 'scanDigest']) ||
        typeof scan['jobId'] !== 'string' ||
        typeof scan['canonicalOrigin'] !== 'string' ||
        !isStringArray(scan['fieldKeys']) ||
        typeof scan['scanDigest'] !== 'string'
      ) {
        return null;
      }
      break;
    }
    case 'bridge/revalidate-scan-result': {
      if (
        !exactRecord(input, ['kind', 'requestId', 'accepted']) ||
        typeof input['accepted'] !== 'boolean'
      ) return null;
      break;
    }
    case 'bridge/submission-arm-result': {
      if (
        !exactRecord(input, ['kind', 'requestId', 'accepted']) ||
        typeof input['accepted'] !== 'boolean'
      ) return null;
      break;
    }
    case 'bridge/fill-outcome': {
      if (!isOutcomeShape(input['outcome'])) return null;
      break;
    }
    case 'bridge/needs-user-input': {
      if (!(INPUT_KINDS as readonly string[]).includes(input['inputKind'] as string)) return null;
      if ('fieldKey' in input && typeof input['fieldKey'] !== 'string') return null;
      break;
    }
    case 'bridge/fill-result': {
      const outcomes = input['outcomes'];
      if (!Array.isArray(outcomes) || !outcomes.every(isOutcomeShape)) return null;
      break;
    }
  }
  return input as BridgeEvent;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
