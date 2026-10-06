import { describe, expect, it } from 'vitest';

import { parseAutofillDockInstruction, parseDockFaceReply } from '../lib/autofillDock';
import type { AutofillAffordance } from '../product-panel/affordance';

/**
 * 后台算得出的每一张脸，内容脚本都必须认得。
 *
 * 这两侧之间隔着一次 `sendMessage`，而收的那一侧有一张白名单：
 * `parseAutofillDockInstruction` 只放行它认识的 `kind` 与 `reason`，认不出的一律
 * 返回 null——这条本身是对的（不可信边界上认不出的东西不该变成 UI）。
 *
 * 危险在于**只往发的那一侧加**。加一个 `reason` 不用动收的那一侧就能编译通过：
 * 那边是 `reason as 'PORTAL_UNLINKED' | 'NO_MISSION'` 手写窄化，类型检查看不见漂移。
 * 于是新那张脸在生产上永远返回 null，而 `showFace` 里 `dock === null` 的意思是
 * **一声不吭地不挂浮层**。用户看到的不是新文案，是插件凭空消失。
 *
 * 2026-09-18 就是这么丢的：`RULES_UNAVAILABLE` 在 2026-09-18 事故后加进决策层，
 * 配了 `dock-face-rules-unavailable` 盯着发的那一侧，收的那一侧没人动。
 * 结果取不到规则时——token 过期、worker 冷启动、后端 503——浮层整个不出现。
 * 那句精心写的「暂时取不到填写规则」，生产上一次都没显示过；而查的人顺着
 * 「插件连不上」又去查了一遍冷启动竞态和缓存，跟事故当天一模一样。
 *
 * 所以这条闸钉的是闭环，不是某一个值：**穷举**决策层能产出的每一种面，
 * 逐一过一遍解析器。下次再加 `reason`，下面那张覆盖表编译不过。
 */

/** 加了新 kind 而没在这里补，这张表编译不过。 */
const KIND_COVER: Record<AutofillAffordance['kind'], true> = {
  HIDDEN: true, DORMANT: true, READY: true, GUIDANCE: true, UNAVAILABLE: true,
};
type Reason = Extract<AutofillAffordance, { kind: 'UNAVAILABLE' }>['reason'];
/** 加了新 reason 而没在这里补，这张表编译不过。 */
const REASON_COVER: Record<Reason, true> = {
  PORTAL_UNLINKED: true, NO_MISSION: true, RULES_UNAVAILABLE: true, VENDOR_CLOSED: true,
};
type Guidance = Extract<AutofillAffordance, { kind: 'GUIDANCE' }>['guidance'];
/** 加了新 guidance 而没在这里补，这张表编译不过。 */
const GUIDANCE_COVER: Record<Guidance, true> = { SIGN_IN_FIRST: true, NO_FORM_FOUND: true };

const EVERY_FACE = [
  { kind: 'HIDDEN' },
  { kind: 'DORMANT' },
  { kind: 'READY' },
  ...(Object.keys(GUIDANCE_COVER) as readonly Guidance[]).map((guidance) => ({ kind: 'GUIDANCE', guidance })),
  ...(Object.keys(REASON_COVER) as readonly Reason[]).map((reason) => ({ kind: 'UNAVAILABLE', reason })),
] as readonly AutofillAffordance[];

describe('后台能产出的每一张脸，内容脚本都要认得', () => {
  it('覆盖表与类型对齐', () => {
    expect(Object.keys(KIND_COVER).sort())
      .toEqual(['DORMANT', 'GUIDANCE', 'HIDDEN', 'READY', 'UNAVAILABLE']);
  });

  // HIDDEN 例外且只此一个：它的意思本来就是「不挂浮层」，null 是对的答案。
  for (const face of EVERY_FACE.filter((f) => f.kind !== 'HIDDEN')) {
    it(`${face.kind}${'reason' in face ? `/${face.reason}` : ''}${'guidance' in face ? `/${face.guidance}` : ''} 过得了解析器`, () => {
      expect(
        parseAutofillDockInstruction({ dock: face }),
        '解析器返回 null = 浮层一声不吭地不出现',
      ).toEqual(face);
    });
  }
});

// 要不要重问看的是后台的回答本身（2026-10-03）：每一张脸，HIDDEN 也在内，都要原样过得了这一个解析器——
// 哪一张在这里变成 null，内容脚本就把它当成「没答上来」，在每一个普通网页上白白重问三次。
describe('后台的每一张脸都是回答，不是「没答上来」', () => {
  for (const face of EVERY_FACE) {
    it(`${face.kind}${'reason' in face ? `/${face.reason}` : ''}${'guidance' in face ? `/${face.guidance}` : ''} 原样过得了 parseDockFaceReply`, () => {
      expect(parseDockFaceReply({ dock: face })).toEqual(face);
    });
  }
});
