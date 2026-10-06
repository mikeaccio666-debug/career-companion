import { afterEach, describe, expect, it } from 'vitest';

import { evaluatePageVeto } from '../src/gate/pageVeto';
import { resolveAuthorizedApplyGate } from '../src/gate/resolve';
import { createBundledApplyPolicy } from '../src/policy';
import type { HostVisibilityStyle } from '../src/contracts';

/**
 * 2026-09-28 gravityforms.com 的招聘表（WordPress + Gravity Forms）：反机器人的蜜罐栏标签是「Instagram」、
 * `type="text"`、`autocomplete="new-password"`，住在样式表 `display:none` 的容器
 * （`.gform_validation_container`）里。旧判据看到那个 autocomplete 就把整页当注册页否决，一张正常的
 * 申请表于是「认不出」。真正看得见的密码框照旧否决整页。
 *
 * 标记与结构照 Gravity Forms 的公开模板手写，没有页面数据。
 */
const APPLICATION_WITH_HONEYPOT = `
  <form id="gform_39">
    <div class="gform_fields">
      <fieldset class="gfield gfield--type-name">
        <legend class="gfield_label">Name</legend>
        <span class="name_first"><input type="text" name="input_1.3" id="input_39_1_3"><label for="input_39_1_3">First</label></span>
        <span class="name_last"><input type="text" name="input_1.6" id="input_39_1_6"><label for="input_39_1_6">Last</label></span>
      </fieldset>
      <div class="gfield"><label for="input_39_2">Email</label><input type="email" name="input_2" id="input_39_2"></div>
      <div class="gfield gfield--type-honeypot gform_validation_container" id="field_39_17">
        <label class="gfield_label" for="input_39_17">Instagram</label>
        <div class="ginput_container"><input name="input_17" id="input_39_17" type="text" value="" autocomplete="new-password"></div>
        <div class="gfield_description">This field is for validation purposes and should be left unchanged.</div>
      </div>
    </div>
  </form>`;

/** 与生产读法同形的可见性桩：样式表把蜜罐容器藏起来（happy-dom 不跑样式表，这里替它说）。 */
const readVisibility = (element: Element): HostVisibilityStyle =>
  element.classList.contains('gform_validation_container') ? { display: 'none', visibility: 'visible' } : { display: 'block', visibility: 'visible' };

afterEach(() => {
  document.body.innerHTML = '';
});

describe('页面否决：藏起来的「密码」蜜罐不把申请表变成注册页', () => {
  it('样式表藏起来的 autocomplete=new-password 普通栏：不否决', () => {
    document.body.innerHTML = APPLICATION_WITH_HONEYPOT;
    expect(evaluatePageVeto(document, { readVisibility }).vetoed).toBe(false);
  });

  it('门控把读法传给否决：通用路的这一页照常挂上', () => {
    document.body.innerHTML = APPLICATION_WITH_HONEYPOT;
    const verdict = resolveAuthorizedApplyGate({
      doc: document,
      hostname: 'www.example-careers.test',
      pathname: '/careers/software-engineer/',
      policy: createBundledApplyPolicy(),
      vendor: 'generic',
      isTopFrame: true,
      readVisibility,
    });
    expect(verdict.attach).toBe(true);
  });

  it('属性层藏起来的（hidden、行内 display:none）不给读法也认得', () => {
    document.body.innerHTML = `
      <form><label for="e">Email</label><input id="e" type="email">
        <div hidden><input autocomplete="new-password"></div>
        <input style="display: none" autocomplete="current-password">
      </form>`;
    expect(evaluatePageVeto(document).vetoed).toBe(false);
  });

  it('不给读法：样式表里的藏法读不到，照旧否决（保守一侧）', () => {
    document.body.innerHTML = APPLICATION_WITH_HONEYPOT;
    expect(evaluatePageVeto(document).vetoed).toBe(true);
  });

  it('看得见的 autocomplete=new-password 栏（注册页）照旧否决', () => {
    document.body.innerHTML = `<form><label for="p">Choose a passphrase</label><input id="p" autocomplete="new-password"></form>`;
    const verdict = evaluatePageVeto(document, { readVisibility });
    expect(verdict).toEqual({ vetoed: true, reason: 'CREDENTIAL_PAGE' });
  });

  it('只是移出 Tab 序、人仍看得见的，照旧否决', () => {
    document.body.innerHTML = `<form><input tabindex="-1" aria-hidden="true" autocomplete="current-password"></form>`;
    expect(evaluatePageVeto(document, { readVisibility }).vetoed).toBe(true);
  });

  it('真正的密码框：藏起来也照旧否决（type=password 是硬门）', () => {
    document.body.innerHTML = `
      <form><label for="e">Email</label><input id="e" type="email">
        <div class="gform_validation_container"><input type="password" name="pw"></div>
      </form>`;
    expect(evaluatePageVeto(document, { readVisibility })).toEqual({ vetoed: true, reason: 'CREDENTIAL_PAGE' });
  });
});
