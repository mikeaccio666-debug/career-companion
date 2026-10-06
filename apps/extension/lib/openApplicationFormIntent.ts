import {
  GREENHOUSE_BOARD_TOKEN_PATTERN,
  GREENHOUSE_JOB_ID_PATTERN,
  type ApplicationFormTarget,
} from '@edaix/apply-kernel/gate';

/**
 * 白标 C（P2-12）：用户在没有申请表的落地页上，从我们的浮层里点了「打开申请表」。
 *
 * 内容脚本**不交 URL**：它只交两个按闭集正则校验过的 token（board 与岗位 id），worker 按固定模板
 * 拼出厂商自己域名上的地址再开新标签。页面就算接管了内容脚本，也只能让我们打开该厂商站点上
 * 某一个岗位的申请表，开不到别处。只导航，不写。
 */
export interface DockOpenApplicationFormIntent {
  readonly kind: 'dock/open-application-form';
  readonly vendor: 'greenhouse';
  readonly boardToken: string;
  readonly jobId: string;
}

const KEYS = ['kind', 'vendor', 'boardToken', 'jobId'] as const;

export function parseDockOpenApplicationFormIntent(value: unknown): DockOpenApplicationFormIntent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  // 精确键集：多一个字段就是一种我们没约定过的形状，而这条消息会替用户开一个标签页。
  if (keys.length !== KEYS.length || !KEYS.every((key) => keys.includes(key))) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== 'dock/open-application-form' ||
    candidate.vendor !== 'greenhouse' ||
    typeof candidate.boardToken !== 'string' || !GREENHOUSE_BOARD_TOKEN_PATTERN.test(candidate.boardToken) ||
    typeof candidate.jobId !== 'string' || !GREENHOUSE_JOB_ID_PATTERN.test(candidate.jobId)
  ) return null;
  return Object.freeze({
    kind: 'dock/open-application-form',
    vendor: 'greenhouse',
    boardToken: candidate.boardToken,
    jobId: candidate.jobId,
  });
}

export function createDockOpenApplicationFormIntent(
  target: ApplicationFormTarget,
): DockOpenApplicationFormIntent | null {
  return parseDockOpenApplicationFormIntent({
    kind: 'dock/open-application-form',
    vendor: target.vendor,
    boardToken: target.boardToken,
    jobId: target.jobId,
  });
}

/** 固定模板：厂商自己域名上的岗位申请页。token 已过闭集正则，直接拼。 */
export function applicationFormUrl(intent: DockOpenApplicationFormIntent): string {
  return `https://job-boards.greenhouse.io/${intent.boardToken}/jobs/${intent.jobId}`;
}
