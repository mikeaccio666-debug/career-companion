import { careerRecordId, careerRecordObject, type AgentSpeakerKey } from '@companion/platform-contracts';
import { orgChoice, orgText, ROLE_FAMILIES } from '@companion/career-core';
import type { Database } from './database.ts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import { ApiError } from './errors.ts';
import { OrgKnowledge } from './org-knowledge.ts';
import type { CapabilityRegistryOptions } from './capabilities.ts';
import { parseSkillMethodRefs } from './skill-method-references.ts';

/** Authenticated internal port for the capability directory. This is not a task
 * lease or permission to call a model; the turn service still owns admission. */
export class CareerMethodReferences {
  constructor(private readonly db: Database, private readonly organization: OrgKnowledge) {}
  async open(session: FixedSessionContext, options: unknown, signal?: AbortSignal): Promise<NonNullable<CapabilityRegistryOptions['readMethodReferences']>> {
    const raw = careerRecordObject(session, ['userId', 'tokenHash']);
    if (typeof raw.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(raw.tokenHash)) throw new ApiError(401, 'AUTH_REQUIRED', '请重新登录。');
    const s = Object.freeze({ userId: careerRecordId(raw.userId), tokenHash: raw.tokenHash });
    const v = careerRecordObject(options, ['organizationId', 'turnId', 'speaker', 'roleFamily']);
    const orgId = careerRecordId(v.organizationId), turnId = orgText(v.turnId, 200);
    const speaker = orgChoice(v.speaker, ['companion', 'guide', 'applier', 'interviewer'] as const) as AgentSpeakerKey;
    const roleFamily = orgChoice(v.roleFamily, ROLE_FAMILIES);
    const denied = () => new ApiError(403, 'NOT_ENTITLED', '方法卡授权已变化，请重新准备。');
    const frozen = await this.db.withBoundedTransaction(async c => {
      const access = await this.organization.accessInTransaction(c, s, orgId, signal);
      if (!access.entitlementId) throw denied();
      await authorizeFixedSession(c, s, signal); return access;
    });
    let stale = false;
    return async (scope, references, request) => {
      if (scope.ownerId !== s.userId || scope.turnId !== turnId || scope.profile.speaker !== speaker)
        throw new ApiError(403, 'TOOL_NOT_ALLOWED', '方法卡读取必须属于原用户、轮次和发言者。');
      if (stale) throw denied();
      const refs = parseSkillMethodRefs(references);
      const abort = scope.signal;
      if (abort !== undefined && !(abort instanceof AbortSignal)) throw new ApiError(400, 'TOOL_ARGUMENTS_INVALID', 'Use an abortable method read.');
      abort?.throwIfAborted();
      return this.db.withBoundedTransaction(async c => {
        const access = await this.organization.accessInTransaction(c, s, orgId, abort);
        if (access.entitlementId !== frozen.entitlementId || access.entitlementRevision !== frozen.entitlementRevision ||
            JSON.stringify(access.audienceGrants) !== JSON.stringify(frozen.audienceGrants)) { stale = true; throw denied(); }
        const result = await this.organization.readSkillMethodsInTransaction(c, s, {
          organizationId: orgId, publishBatch: frozen.publishBatch, speaker, roleFamily,
          skillId: request.skillId, detail: request.detail, references: refs,
        }, abort);
        await authorizeFixedSession(c, s, abort); abort?.throwIfAborted(); return result;
      });
    };
  }
}
