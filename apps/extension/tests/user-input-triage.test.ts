// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { triageNeedsUserInput } from '../lib/userInputTriage';
import { APPLY_ERROR_CODES } from '@edaix/apply-kernel/contracts';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();


/**
 * NEEDS_USER_INPUT 的三分语义（T10 验收 ⑤）。
 *
 * T10 卡片逐字：「契约与转发层齐、收口分流真被锁，但**唯一的真实生产者只产出
 * 一种**：`kernelFiller.ts` 只发 `IN_PAGE_ACTION`；`CHAT_ANSWER` /
 * `SENSITIVE_CONFIRM` 全仓只出现在契约常量、coordinator 透传分支、mock filler
 * 测试里。」
 *
 * 后果：一道「期望薪资多少」的题，今天被告知"去页面上自己填"——而它本该在
 * chat 里问一次、答案按作用域记住、下次直接代填
 * （PD-2026-08-18-PROFILE-QUESTION-MODEL 的 AnswerScopeRef）。
 * 每一次都推回页面，等于把这条产品能力整个关掉。
 *
 * ## 为什么分错档比不分档更危险
 *
 * 契约头注逐字：`CHAT_ANSWER` / `SENSITIVE_CONFIRM` **必收口**——发出去，本轮
 * run 立刻停在 `USER_ACTION_REQUIRED`，不再进 DONE、不出回执。所以把一个本该
 * 「你去页面上勾一下」的东西误判成 CHAT_ANSWER，会让整轮在**还没填任何字段之前**
 * 就停掉。`IN_PAGE_ACTION` 不收口，run 照常跑完。
 *
 * 三档的判据是**这个问题该在哪儿被回答**：
 *   · CHAT_ANSWER —— 答案是一句话，且能存下来复用（岗位相关题、档案缺项）
 *   · SENSITIVE_CONFIRM —— 我们有值、但每次写入前必须用户逐条放行（铁律 5 乙档）
 *   · IN_PAGE_ACTION —— 只能在那张表上完成（控件我们填不了、宿主没确认、只能本人操作）
 */

describe('该在 chat 里问的', () => {
  it.each(['JOB_DEPENDENT', 'NO_VALUE'] as const)(
    '%s → CHAT_ANSWER，并带上 canonical key',
    (reason) => {
      const verdict = triageNeedsUserInput({ reason, key: 'phone', chatAnswerEnabled: true });
      expect(verdict.kind, `${reason} 被推回页面了——它本该在 chat 问一次、记住、下次代填`).toBe(
        'CHAT_ANSWER',
      );
      expect(verdict.fieldKey, 'CHAT_ANSWER 不带 key，chat 侧不知道在问哪一栏').toBe('phone');
    },
  );

  it('没有 canonical key 就问不出去——降回页面动作', () => {
    // 「Current company」这类今天 key 为 null（11 键档案装不下）。
    // 没有键就没法把答案存回档案，chat 里问了也接不住。
    const verdict = triageNeedsUserInput({ reason: 'NO_VALUE', key: null, chatAnswerEnabled: true });
    expect(verdict.kind).toBe('IN_PAGE_ACTION');
    expect(verdict.fieldKey, 'IN_PAGE_ACTION 不得携带任何定位信息（契约逐字）').toBeUndefined();
  });
});

describe('只能在页面上完成的', () => {
  it.each([
    'UNSUPPORTED_CONTROL',
    'CHOICE_NO_DATA',
    'HOST_UNCONFIRMED',
    'NO_OPTION_MATCH',
    'AMBIGUOUS_OPTION',
    'LOW_CONFIDENCE',
  ] as const)('%s → IN_PAGE_ACTION', (reason) => {
    const verdict = triageNeedsUserInput({ reason, key: 'phone', chatAnswerEnabled: true });
    expect(verdict.kind).toBe('IN_PAGE_ACTION');
    expect(verdict.fieldKey, 'IN_PAGE_ACTION 不得携带任何定位信息').toBeUndefined();
  });

  it('MANUAL_ONLY 今天也走页面——乙档代填未解闸，不许承诺做不到的事', () => {
    // 铁律 5 乙档（EEO / 工作授权 / 信息属实）语义上属于 SENSITIVE_CONFIRM，
    // 但它三道闸（法律责任 T21 / 阻塞确认条 runtime / 写入授权链）一道都没解，
    // 且 MANUAL_ONLY 今天同时承载 pending proposal 候选（密码）、始终人工项（验证码）与乙档，wire 上
    // 分不出来。发 SENSITIVE_CONFIRM 等于承诺"我有值、你点一下我就写"——
    // 而我们既没有值也没有写入路径。fail closed 回页面动作。
    const verdict = triageNeedsUserInput({ reason: 'MANUAL_ONLY', key: null, chatAnswerEnabled: true });
    expect(verdict.kind).toBe('IN_PAGE_ACTION');
  });
});

describe('绝不打扰用户的', () => {
  it.each(['HONEYPOT', 'OTHER_PERSON', 'SENSITIVE_OPT_OUT', 'DUPLICATE_FIELD', 'NOT_EMPTY'] as const)(
    '%s → 不发任何提示',
    (reason) => {
      expect(triageNeedsUserInput({ reason, key: 'phone', chatAnswerEnabled: true }).kind).toBeNull();
    },
  );

  it('蜜罐永远不提示——提示等于把陷阱指给用户', () => {
    expect(triageNeedsUserInput({ reason: 'HONEYPOT', key: null, chatAnswerEnabled: true }).kind).toBeNull();
  });
});

describe('闭集穷举', () => {
  it('38 条原因码每一条都有明确归属，没有落到猜测里', () => {
    const unhandled: string[] = [];
    for (const reason of APPLY_ERROR_CODES) {
      const verdict = triageNeedsUserInput({ reason, key: 'phone', chatAnswerEnabled: true });
      if (verdict.kind === undefined) unhandled.push(reason);
    }
    expect(unhandled, `这些原因码没有归属：${unhandled.join(', ')}`).toEqual([]);
  });

  it('CHAT_ANSWER 是**收口**的，所以名单必须短且明确', () => {
    const chat = APPLY_ERROR_CODES.filter(
      (reason) => triageNeedsUserInput({ reason, key: 'phone', chatAnswerEnabled: true }).kind === 'CHAT_ANSWER',
    );
    // 名单一长，就会有本该"页面上弄一下"的东西把整轮 run 提前收掉。
    expect(chat).toEqual(['JOB_DEPENDENT', 'NO_VALUE']);
  });
});

describe('默认关：闭环没接通之前不许收口', () => {
  /**
   * `CHAT_ANSWER` 必收口。chat 侧的「问答 → 存回档案 → 新一轮填上」闭环
   * （T2 + T3）没接通之前发它，用户得到的是一个停下来、而且没人问他任何
   * 问题的 run——比今天「跑完 + 告诉你去页面上填」更糟。真机彩排实测抓到过。
   */
  it.each(['JOB_DEPENDENT', 'NO_VALUE'] as const)('不开闸时 %s 退回 IN_PAGE_ACTION', (reason) => {
    const verdict = triageNeedsUserInput({ reason, key: 'phone' });
    expect(verdict.kind, '闭环没接通就发了收口帧——run 停下来且没人问用户任何问题').toBe(
      'IN_PAGE_ACTION',
    );
    expect(verdict.fieldKey).toBeUndefined();
  });

  it('开闸与不开闸的差别只在这两个码上，别的一律不变', () => {
    for (const reason of APPLY_ERROR_CODES) {
      const off = triageNeedsUserInput({ reason, key: 'phone' });
      const on = triageNeedsUserInput({ reason, key: 'phone', chatAnswerEnabled: true });
      if (reason === 'JOB_DEPENDENT' || reason === 'NO_VALUE') continue;
      expect(on.kind, `开闸把 ${reason} 的归属也改了`).toBe(off.kind);
    }
  });
});
