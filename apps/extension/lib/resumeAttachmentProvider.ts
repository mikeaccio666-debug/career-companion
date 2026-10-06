import {
  parseResumeAtsAttachmentTargetV1,
  parseUuid,
  type ListResumeSelectionOptionsResponseV1,
  type ResumeAtsAttachmentPlanV1,
  type ResumeAtsAttachmentTargetV1,
} from '@edaix/contracts';
import type { ApplyMaterialsResult } from './applyMaterialsClient';
import { encodeBase64 } from './binaryEncoding';
import type { ResumeAttachmentClient } from './resumeAttachmentClient';
import type {
  DockResumeAttachmentIntent,
  DockResumeAttachmentReply,
  ResumeAttachmentRefusal,
} from './resumeAttachmentIntent';

/**
 * worker 侧：把内容脚本的 PLAN / RELEASE 变成对后端的问询与释出（P1-4）。
 *
 * ## 附哪一份
 *
 * 手势填写没有选简历那一幕（那是 mission 路的 APPLY 场景才有的）。这里的规则是：
 * 账号里的**默认**那一份；没有默认但只有一份，就是那一份；有好几份又没有默认，
 * **拒**（`RESUME_CHOICE_REQUIRED`）而不是替他挑——附错版本比不附更糟。
 *
 * ## 收件人由 worker 自己组
 *
 * `canonicalOrigin` 与 `jobId`（= pathname）都取自消息里 worker 已经和 sender.url
 * 逐字核对过的那两项，不接受内容脚本另报的值。真正的判断在服务端：域名过得了
 * 运营清单，plan 才答 200，内容脚本据此才把 `targetVerified` 置真。
 *
 * ## PLAN 的答复留一会儿，字节永远不留
 *
 * RELEASE 要带回 PLAN 钉下的三个值，所以 PLAN 的答复按「哪个标签页、哪一页」
 * 记一小段时间。MV3 worker 随时会死；RELEASE 找不到那份记录就当场再问一次，
 * 不把「worker 重启了」变成「简历没附上」。字节则只在这一次答复里经过，
 * 不进 Map、不进 storage、不进日志。
 */
/**
 * A Mission-bound page's own resume (2026-09-24): the tailored version the Mission's
 * application bundle pins, released to that Mission's verified page through the Mission
 * materials entry. PLAN answers name and size only; RELEASE brings the bytes.
 */
export interface MissionResumeSupply {
  plan(): Promise<
    | Readonly<{ ok: true; fileName: string; size: number }>
    | Readonly<{ ok: false; code: ResumeAttachmentRefusal }>
  >;
  release(): Promise<
    | Readonly<{ ok: true; fileName: string; size: number; bytes: Uint8Array }>
    | Readonly<{ ok: false; code: ResumeAttachmentRefusal }>
  >;
}

export interface ResumeAttachmentProviderDeps {
  readonly listResumes: () => Promise<ApplyMaterialsResult<ListResumeSelectionOptionsResponseV1>>;
  readonly client: ResumeAttachmentClient;
  /**
   * The Mission this sender's page is bound to supplies the resume (2026-09-24): on a bound
   * page neither the prepared-resume lookup nor the library default is ever asked. Null when
   * the page is not bound to an open Mission.
   */
  readonly missionResume?: (
    senderKey: string,
    page: Readonly<{ origin: string; pathname: string }>,
  ) => Promise<MissionResumeSupply | null>;
  /** 只记稳定原因码（RULE-GLOBAL-DATA-L1）。 */
  readonly onDiagnostic?: (code: string) => void;
  readonly now?: () => number;
  readonly planTtlMs?: number;
}

export interface ResumeAttachmentProvider {
  /** `senderKey` 由调用方从 sender（标签页 id）取，用来把 PLAN 与 RELEASE 配成一对。 */
  handle(intent: DockResumeAttachmentIntent, senderKey: string): Promise<DockResumeAttachmentReply>;
}

const DEFAULT_PLAN_TTL_MS = 10 * 60_000;

type Planned = Readonly<{ plan: ResumeAtsAttachmentPlanV1; target: ResumeAtsAttachmentTargetV1; expiresAt: number }>;
type Refused = Readonly<{ kind: 'REFUSED'; code: ResumeAttachmentRefusal }>;

export function createResumeAttachmentProvider(deps: ResumeAttachmentProviderDeps): ResumeAttachmentProvider {
  const now = deps.now ?? (() => Date.now());
  const ttlMs = Number.isFinite(deps.planTtlMs) && Number(deps.planTtlMs) > 0 ? Number(deps.planTtlMs) : DEFAULT_PLAN_TTL_MS;
  const diag = (code: string): void => {
    try {
      deps.onDiagnostic?.(code);
    } catch {
      // 诊断通道自己坏了不该影响填写。
    }
  };
  const planned = new Map<string, Planned>();

  async function planFor(intent: DockResumeAttachmentIntent, key: string): Promise<Planned | Refused> {
    const target = parseResumeAtsAttachmentTargetV1({ canonicalOrigin: intent.origin, jobId: intent.pathname });
    if (target === null) {
      diag('RESUME_ATTACHMENT_TARGET_INVALID');
      return refused('UNAVAILABLE');
    }
    // 先问「这一页有没有为它准备好的简历」——用户在 ArgoLand 里对这个岗位 Start applying
    // 改出的那一版。有就附它；没有（页面不在目录里、没准备过）才退到简历库的默认版。
    // 问不到不算错：退回默认版，只记码（2026-09-21 Mike：附的应该是为这个岗位改过的那份）。
    // 简历库清单与「为这个岗位准备过的那一版」同时问（2026-09-23 测速：三次往返排队要一秒多）。
    // 清单只在没有准备过的版本时才用得上；多问的那一次是只读的。
    const listing = deps.listResumes();
    // 用不上时没人等它：失败也不能变成一条没人接的拒绝。
    listing.catch(() => {});
    const prepared = await deps.client.prepared(target);
    if (!prepared.ok) diag(`RESUME_ATTACHMENT_PREPARED_LOOKUP_${prepared.code}`);
    const preparedVersionId = prepared.ok ? prepared.value.resumeVersionId : null;
    let resumeVersionId: ReturnType<typeof parseUuid>;
    if (preparedVersionId !== null) {
      resumeVersionId = parseUuid(preparedVersionId);
      if (resumeVersionId === null) {
        diag('RESUME_ATTACHMENT_VERSION_ID_INVALID');
        return refused('UNAVAILABLE');
      }
      diag('RESUME_ATTACHMENT_PREPARED_FOR_JOB');
    } else {
      const list = await listing;
      if (!list.ok) {
        diag(`RESUME_ATTACHMENT_LIST_${list.code}`);
        return refused(list.code === 'JOB_NOT_FOUND' ? 'UNAVAILABLE' : list.code);
      }
      const choice = chooseResume(list.value);
      if (!choice.ok) {
        diag(`RESUME_ATTACHMENT_${choice.code}`);
        return refused(choice.code);
      }
      resumeVersionId = parseUuid(choice.resumeVersionId);
      if (resumeVersionId === null) {
        diag('RESUME_ATTACHMENT_VERSION_ID_INVALID');
        return refused('UNAVAILABLE');
      }
      diag('RESUME_ATTACHMENT_DEFAULT_VERSION');
    }
    const result = await deps.client.plan({ resumeVersionId, target });
    if (!result.ok) {
      // 服务端的码缀在后面（RESUME_ATTACHMENT_PLAN_RESUME_UNAVAILABLE_VERSION_NOT_READY）：
      // 同一个 RESUME_UNAVAILABLE，下一步却可能是「去上传」「等渲染」或「重选版本」。
      diag(`RESUME_ATTACHMENT_PLAN_${result.code}${serverSuffix(result.serverCode)}`);
      return refused(result.code);
    }
    const entry: Planned = Object.freeze({ plan: result.value, target, expiresAt: now() + ttlMs });
    planned.set(key, entry);
    return entry;
  }

  function fresh(key: string): Planned | undefined {
    const entry = planned.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now()) {
      planned.delete(key);
      return undefined;
    }
    return entry;
  }

  async function missionReply(
    mission: MissionResumeSupply,
    step: DockResumeAttachmentIntent['step'],
  ): Promise<DockResumeAttachmentReply> {
    if (step === 'PLAN') {
      const plan = await mission.plan();
      if (!plan.ok) {
        diag(`RESUME_ATTACHMENT_MISSION_PLAN_${plan.code}`);
        return refused(plan.code);
      }
      diag('RESUME_ATTACHMENT_MISSION_MATERIAL');
      return { kind: 'RESUME_ATTACHMENT_PLAN', fileName: plan.fileName, size: plan.size };
    }
    const released = await mission.release();
    if (!released.ok) {
      diag(`RESUME_ATTACHMENT_MISSION_RELEASE_${released.code}`);
      return refused(released.code);
    }
    diag('RESUME_ATTACHMENT_MISSION_RELEASED');
    return {
      kind: 'RESUME_ATTACHMENT_FILE',
      fileName: released.fileName,
      size: released.size,
      bytesBase64: encodeBase64(released.bytes),
    };
  }

  return Object.freeze({
    async handle(intent: DockResumeAttachmentIntent, senderKey: string): Promise<DockResumeAttachmentReply> {
      // Without the Mission hook nothing is awaited here: the prepared lookup and the library
      // read below still leave together, on the same turn as the message.
      const mission = deps.missionResume === undefined
        ? null
        : await deps.missionResume(senderKey, { origin: intent.origin, pathname: intent.pathname }).catch(() => null);
      if (mission !== null) return missionReply(mission, intent.step);
      const key = `${senderKey}\n${intent.origin}\n${intent.pathname}`;
      if (intent.step === 'PLAN') {
        const entry = await planFor(intent, key);
        if ('kind' in entry) return entry;
        return { kind: 'RESUME_ATTACHMENT_PLAN', fileName: entry.plan.fileName, size: entry.plan.size };
      }

      const cached = fresh(key);
      let entry: Planned | Refused = cached ?? await planFor(intent, key);
      if ('kind' in entry) return entry;
      let released = await deps.client.release(entry.plan, entry.target);
      // 记着的那份计划可能已经过期（用户刚在门户换了版本）：重问一次，只重问一次。
      if (!released.ok && released.code === 'RESUME_UNAVAILABLE' && cached !== undefined) {
        planned.delete(key);
        entry = await planFor(intent, key);
        if ('kind' in entry) return entry;
        released = await deps.client.release(entry.plan, entry.target);
      }
      if (!released.ok) {
        diag(`RESUME_ATTACHMENT_RELEASE_${released.code}${serverSuffix(released.serverCode)}`);
        return refused(released.code);
      }
      diag('RESUME_ATTACHMENT_RELEASED');
      return {
        kind: 'RESUME_ATTACHMENT_FILE',
        fileName: released.value.fileName,
        size: released.value.size,
        bytesBase64: encodeBase64(released.value.bytes),
      };
    },
  });
}

function chooseResume(
  list: ListResumeSelectionOptionsResponseV1,
): Readonly<{ ok: true; resumeVersionId: string }> | Readonly<{ ok: false; code: 'NO_RESUME' | 'RESUME_CHOICE_REQUIRED' }> {
  const items = list.items;
  if (items.length === 0) return { ok: false, code: 'NO_RESUME' };
  const byDefaultId = list.defaultResumeVersionId === null
    ? undefined
    : items.find((item) => item.resumeVersionId === list.defaultResumeVersionId);
  const chosen = byDefaultId ?? items.find((item) => item.isDefault) ?? (items.length === 1 ? items[0] : undefined);
  return chosen === undefined
    ? { ok: false, code: 'RESUME_CHOICE_REQUIRED' }
    : { ok: true, resumeVersionId: chosen.resumeVersionId };
}

function refused(code: ResumeAttachmentRefusal): Refused {
  return Object.freeze({ kind: 'REFUSED' as const, code });
}

/**
 * 缀在诊断码后面的服务端码：缀之前再核一次闭集形状（客户端读的时候已经核过；这一道防的是哪天客户端改松了）。
 * 像主机名、带点或冒号的、小写的、超长的一律不缀（RULE-GLOBAL-DATA-L1；2026-10-04 体检 Data-L1 那一处）。
 */
function serverSuffix(serverCode: string | undefined): string {
  return serverCode !== undefined && /^[A-Z][A-Z0-9_]{0,63}$/u.test(serverCode) ? `_${serverCode}` : '';
}
