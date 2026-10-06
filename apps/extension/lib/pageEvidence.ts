import type { ApplyVendor } from '@edaix/apply-kernel/vendors';
import type { GenericFormEvidence } from './kernelScanner';

/**
 * 没认出厂商的页面上，「浮层为什么该露面」的证据（2026-09-24，商店包开全网）。
 *
 * 内容脚本注入到每一个 https 页面，但浮层只该挂在申请表上。主机表认得的厂商由后台按 URL 判；
 * 主机表答不出的页面，后台只凭内容脚本报来的这三件事判：
 *  · `vendorHint`：厂商自己的 DOM 产物（白标，`fingerprintVendorHint`）；
 *  · `genericForm`：恰好一张表里认得够多字段、且不是密码页（通用路，`genericApplyFormEvidence`）；
 *    `genericJobForm`：那张表里还有求职信号（2026-09-25：「联系销售」表也凑得够字段，不带这一位不挂）；
 *    其中表里有只有求职才问的栏（简历／CV、LinkedIn、工作授权、学历）的那一档只在本机用：它让公司自己做的表
 *    像厂商申请页一样自动打开（`hasJobOnlyFields`，负责人 2026-09-28），不另报给后台；
 *  · `jobPosting`：页面自己用 JobPosting 标准说它是一个岗位（只留一个标签，不自动打开）。
 *
 * 规矩：
 *  · **只增不减，换路径才清**。表单交完变成「谢谢」、单页应用重画一遍，证据都不撤——否则脸会从「能填」
 *    退回标签、把正在跑的那一轮连浮层一起换掉。换了路径就是另一页，从头看。
 *  · 通用表只在没有白标指纹时才探（与内容脚本的 `pageLane` 同一个互斥）；认出带只有求职才问的栏的表就不再探
 *    （只有较弱的求职信号时接着探：多步表单的简历栏可能在下一步才出来）。
 *  · 慢页面不再探：一次通用探测超过 `SLOW_PROBE_MS`，这一页（这条路径）就不再探通用表——
 *    注入到每个网站之后，绝不能因为我们让别人的页面卡一下。
 *
 * 读法由调用方注入（内容脚本里是真 DOM，测试里是桩），这里只管记账。
 */

export type HelloEvidence = Readonly<{ vendorHint?: ApplyVendor; genericForm?: true; genericJobForm?: true; jobPosting?: true }>;

export interface PageEvidenceReaders {
  readonly pathname: () => string;
  readonly vendorHint: () => ApplyVendor | null;
  readonly genericForm: () => GenericFormEvidence;
  readonly jobPosting: () => boolean;
  /** 毫秒时钟（测试注入）。 */
  readonly now?: () => number;
}

export interface PageEvidenceTracker {
  /** 再看一眼页面；这一页的证据比上一眼多了就返回 true（调用方随即重新报到）。 */
  readonly refresh: () => boolean;
  /** 报到时带上的那几项。 */
  readonly hello: () => HelloEvidence;
  /** 已经认出一张申请表（白标，或带求职信号的通用表）：点击之后不必再看。 */
  readonly hasJobForm: () => boolean;
  /**
   * 通用表里有只有求职才问的栏（简历／CV 上传、LinkedIn、工作授权、学历；负责人 2026-09-28）：公司自己做的表
   * 有了它才自动打开浮层（`lib/dockAutoOpen.ts`）。只在本机用，不报给后台。
   */
  readonly hasJobOnlyFields: () => boolean;
}

/** 一次通用探测超过这么久，这条路径上就不再探。真实申请页上一次探测在几毫秒量级。 */
export const SLOW_PROBE_MS = 50;

type Seen = { vendorHint: ApplyVendor | null; genericForm: GenericFormEvidence; jobPosting: boolean; probeGeneric: boolean };

const empty = (): Seen => ({ vendorHint: null, genericForm: 'NONE', jobPosting: false, probeGeneric: true });

/** 只升不降：NONE < FORM < JOB_FORM < APPLICATION_FORM。 */
const RANK: Readonly<Record<GenericFormEvidence, number>> = { NONE: 0, FORM: 1, JOB_FORM: 2, APPLICATION_FORM: 3 };
/** 带求职信号的两档：报到时都带 `genericJobForm`。 */
const jobForm = (evidence: GenericFormEvidence): boolean => RANK[evidence] >= RANK.JOB_FORM;
/** 报到带的那几项：只有这几项变了才要重新报到（表升到「有只有求职才问的栏」那一档不必，那一档只在本机用）。 */
const keyOf = (seen: Seen): string =>
  `${seen.vendorHint ?? ''}|${seen.genericForm === 'NONE' ? 0 : jobForm(seen.genericForm) ? 2 : 1}|${seen.jobPosting ? 1 : 0}`;


export function createPageEvidenceTracker(read: PageEvidenceReaders): PageEvidenceTracker {
  const now = read.now ?? (() => Date.now());
  let path = read.pathname();
  let seen = empty();
  const refresh = (): boolean => {
    const current = read.pathname();
    if (current !== path) {
      path = current;
      seen = empty();
    }
    const before = keyOf(seen);
    if (seen.vendorHint === null) seen.vendorHint = read.vendorHint();
    // 到顶（表里有只有求职才问的栏）才不再探：只有较弱的求职信号时，简历栏可能在多步表单的下一步才出来。
    if (seen.vendorHint === null && seen.genericForm !== 'APPLICATION_FORM' && seen.probeGeneric) {
      const started = now();
      const found = read.genericForm();
      if (RANK[found] > RANK[seen.genericForm]) seen.genericForm = found;
      if (seen.genericForm !== 'APPLICATION_FORM' && now() - started > SLOW_PROBE_MS) seen.probeGeneric = false;
    }
    if (!seen.jobPosting) seen.jobPosting = read.jobPosting();
    return keyOf(seen) !== before;
  };
  return Object.freeze({
    refresh,
    hello: (): HelloEvidence => Object.freeze({
      ...(seen.vendorHint === null ? {} : { vendorHint: seen.vendorHint }),
      ...(seen.genericForm === 'NONE' ? {} : { genericForm: true as const }),
      ...(jobForm(seen.genericForm) ? { genericJobForm: true as const } : {}),
      ...(seen.jobPosting ? { jobPosting: true as const } : {}),
    }),
    hasJobForm: () => seen.vendorHint !== null || jobForm(seen.genericForm),
    hasJobOnlyFields: () => seen.genericForm === 'APPLICATION_FORM',
  });
}
