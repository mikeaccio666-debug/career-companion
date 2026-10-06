import { VENDOR_CATALOG } from '../vendors';

/**
 * 顶层文档与内嵌 iframe 的仲裁。
 *
 * A2b 之前顶层文档根本不匹配注入范围，所以这个问题不存在。扩到全网之后顶层也会被
 * 注入，于是一个**既嵌了 ATS iframe、自己又有一张表单**的公司招聘页（最常见的形状
 * 是"人才库登记"：姓名 + 邮箱 + 简历上传）会让屏幕上同时出现两个浮层——两个都是
 * `position: fixed`，直接叠在一起。
 *
 * **刻意不用跨 frame 消息。** 让子帧向 `window.top` postMessage 声明所有权是最直觉的
 * 做法，但那会多出一条**页面可观测**的通道（targetOrigin 必须是 '*' 才能跨源到达，
 * 于是宿主页面也能收到），正是铁律 2/3 要避免的形状。
 *
 * 改用同帧同步判断：顶层文档如果看得见一个指向已知 ATS 主机的 iframe，就让位给它。
 * 这**不读那个 iframe 的内容**——跨源读不到，也不需要——只读它自己 DOM 上的 `src`
 * 属性字符串。
 *
 * 让位是安全方向：真正持有申请表的那一帧仍然会挂浮层（那正是今天 Greenhouse embed
 * 的实际形态，`tests/e2e/apply-overlay-frame.spec.ts` 锁着）；而顶层的"人才库登记"
 * 表本来也不是用户此刻要投的那份申请。
 */

const CANDIDATE_HOSTS: readonly string[] = Object.values(VENDOR_CATALOG).flatMap(
  (entry) => entry.candidateHosts,
);

/** 标签边界匹配：`jobs.lever.co.evil.com` 不算 `jobs.lever.co`。 */
function isCandidateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return CANDIDATE_HOSTS.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export interface FrameArbitrationInput {
  readonly doc: Document;
  /** `window.top === window.self`。让位规则**只对顶层生效**。 */
  readonly isTopFrame: boolean;
}

export function shouldYieldToEmbeddedFrame(input: FrameArbitrationInput): boolean {
  // iframe 自己永远不让位——否则 ATS 页面里再嵌一层时，真正持有表单的那一帧会把
  // 自己让掉，结果谁都不挂。
  if (!input.isTopFrame) return false;

  const base = input.doc.location?.href ?? 'https://x.invalid';
  for (const frame of Array.from(input.doc.querySelectorAll('iframe[src]'))) {
    const src = frame.getAttribute('src') ?? '';
    if (src === '') continue;
    try {
      if (isCandidateHost(new URL(src, base).hostname)) return true;
    } catch {
      // 畸形 src 忽略。不能因为一个坏属性就让整页哑掉。
    }
  }
  return false;
}
