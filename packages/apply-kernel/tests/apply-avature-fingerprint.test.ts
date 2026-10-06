// @vitest-environment-options { "settings": { "disableIframePageLoading": true } }
import { afterEach, describe, expect, it } from 'vitest';

import { fingerprintVendorHint } from '../src/gate/vendorFingerprint';

/**
 * Avature 的 DOM 指纹。
 *
 * 2026-08-21 在两个**真实租户**上只读实测：`apply.deloitte.com` 与
 * `us-talentcommunity.kpmg.com`。两家的 HTML 里都直接含 `avature` 字符串。
 *
 * ## 为什么 Avature 必须靠 DOM 指纹，而不是主机名
 *
 * Avature 跑在**客户自己的域名**上：`apply.deloitte.com`、
 * `us-talentcommunity.kpmg.com`。既没有共同注册域（不像 Workday 的
 * `myworkdayjobs.com`），也没法穷举（不像 Greenhouse 的四个精确主机）。
 * 主机名这条路在这家根本不存在。
 *
 * ## 指纹用什么
 *
 * 两个租户的**逐字段命名完全不同**——Deloitte 是 `550/551/552/944`，
 * KPMG 是 `1739/1740/1792/21614`：数字是逐租户的内部 ID，跨租户毫无意义。
 *
 * 但它们的**向导状态字段一模一样**：
 *   `currentStepIndex` / `entityData` / `visitedStepIds` /
 *   `committedStepIds` / `stepIndexesStack`
 *
 * 这五个是 Avature 自己的产物、跨租户不变，而且**不是"看起来像申请表"的通用
 * 特征**——租房申请、病历 intake 不会带 `visitedStepIds`。这正是
 * `vendorFingerprint` 头注要求的那种判据：厂商自己的东西。
 *
 * ⚠️ 要求**多个同时出现**，不是命中一个就算。单个 `currentStepIndex` 这种名字
 * 别的向导表单也可能用；五个一起出现才是 Avature。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

/** 真实实测的隐藏状态字段（两家逐字相同）。 */
const AVATURE_STATE = ['currentStepIndex', 'entityData', 'visitedStepIds', 'committedStepIds', 'stepIndexesStack'];

function mountAvature(names: readonly string[] = AVATURE_STATE, numericFields: readonly string[] = []): void {
  document.body.innerHTML = `<form>
    ${names.map((n) => `<input type="hidden" name="${n}" />`).join('')}
    ${numericFields.map((n) => `<input type="text" name="${n}" />`).join('')}
  </form>`;
}

const url = (href: string) => new URL(href);

describe('两个真实租户都认得出', () => {
  it('Deloitte（apply.deloitte.com，字段名 550/551/552）', () => {
    mountAvature(AVATURE_STATE, ['550', '551', '552', '944', 'countryField1']);
    expect(
      fingerprintVendorHint({ doc: document, url: url('https://apply.deloitte.com/en_US/careers/Register?jobId=358688') }),
      'Avature 的客户自建域名认不出——Deloitte/KPMG 这类大厂整片看不见',
    ).toBe('avature');
  });

  it('KPMG（us-talentcommunity.kpmg.com，字段名 1739/1740/1792）', () => {
    mountAvature(AVATURE_STATE, ['1739', '1740', '1792', '21614', 'countryField1']);
    expect(
      fingerprintVendorHint({ doc: document, url: url('https://us-talentcommunity.kpmg.com/apply/RegisterNew?jobId=134133') }),
      '同一套 Avature 结构换个租户就认不出了——那这个指纹没有跨租户价值',
    ).toBe('avature');
  });

  it('逐字段命名完全不同也照样认得出——指纹不靠数字 ID', () => {
    // 这一条是上面两条的本质：Deloitte 的 550 与 KPMG 的 1739 毫无共同点，
    // 认得出靠的是那五个向导状态字段。
    mountAvature(AVATURE_STATE, ['99999']);
    expect(fingerprintVendorHint({ doc: document, url: url('https://careers.some-other-tenant.test/apply') })).toBe(
      'avature',
    );
  });
});

describe('不许命中通用表单', () => {
  it('普通多步向导（只有一个同名字段）不算 Avature', () => {
    // `currentStepIndex` 这种名字别的向导也可能用。命中一个就算 = 误注入。
    mountAvature(['currentStepIndex']);
    expect(
      fingerprintVendorHint({ doc: document, url: url('https://apartments.example.test/rental-application') }),
      '一个字段就断定是 Avature——租房/病历 intake 会被误认',
    ).toBeNull();
  });

  it('两个也不够', () => {
    mountAvature(['currentStepIndex', 'entityData']);
    expect(fingerprintVendorHint({ doc: document, url: url('https://x.test/form') })).toBeNull();
  });

  it('看起来像申请表的通用页面不算', () => {
    document.body.innerHTML = `<form>
      <label for="n">Full name</label><input id="n" />
      <label for="e">Email</label><input id="e" type="email" />
      <input type="file" name="resume" />
      <button type="submit">Submit application</button>
    </form>`;
    expect(fingerprintVendorHint({ doc: document, url: url('https://apartments.example.test/apply') })).toBeNull();
  });
});

describe('不许抢已有四家', () => {
  it('Greenhouse 的 embed 产物仍然判 greenhouse，即使同页有向导状态字段', () => {
    document.body.innerHTML = `<div id="grnhse_app"></div><form>
      ${AVATURE_STATE.map((n) => `<input type="hidden" name="${n}" />`).join('')}
    </form>`;
    expect(
      fingerprintVendorHint({ doc: document, url: url('https://careers.acme.test/jobs/1') }),
      'Avature 指纹把 Greenhouse embed 抢走了——套错规则会把值写进错误字段',
    ).toBe('greenhouse');
  });

  it('反向探针：没有 Avature 状态字段时不受影响', () => {
    document.body.innerHTML = '<div data-ashby-app></div>';
    expect(fingerprintVendorHint({ doc: document, url: url('https://join.acme.test/apply') })).toBe('ashby');
  });
});
