import { afterEach, describe, expect, it } from 'vitest';

import releaseManifest from '@edaix/apply-rules/release-manifest.json';
import ashby from '@edaix/apply-rules/ashby.json';
import bamboohr from '@edaix/apply-rules/bamboohr.json';
import dover from '@edaix/apply-rules/dover.json';
import generic from '@edaix/apply-rules/generic.json';
import greenhouse from '@edaix/apply-rules/greenhouse.json';
import icims from '@edaix/apply-rules/icims.json';
import jobvite from '@edaix/apply-rules/jobvite.json';
import lever from '@edaix/apply-rules/lever.json';
import rippling from '@edaix/apply-rules/rippling.json';
import smartrecruiters from '@edaix/apply-rules/smartrecruiters.json';
import workable from '@edaix/apply-rules/workable.json';
import workday from '@edaix/apply-rules/workday.json';
import {
  buildApplyRulesRelease,
  createRuntimeApplyRegistry,
  readRuntimeApplyFormResult,
  resolveRuntimeApplyAdapter,
} from '../src/runtimeRegistry';

/**
 * 厂商路上、整页都是雇主自定义题的那一步（2026-09-22 nvidia.wd5 实测）。
 *
 * Workday 第 3 步 Application Questions 只有两道题——「是否有权在岗位所在国工作」「是否需要雇主支持
 * 才能取得或维持工作授权」——字段 id 是随机 GUID，一个键都没有。从前内核在这里判 NO_KEYED_FIELD、
 * 整页交不出去，浮层说「这一页没有我们认得的表单」；而专门处理这类题的逻辑（工作授权按岗位国家预填、
 * 居住地、答案记忆、AI 起草）都在计划期，一次都跑不到。
 *
 * 厂商路（主机在这一家的表里、路径命中、页锚命中）上，页锚本身就证明了这是申请流程里的一步：
 * 扫出了字段就交出去，哪怕一个键都没有。一个字段都没有照旧拒。白标与通用路在找根那一步就已经要求
 * 带键的钩子（白标 ≥ minHooks 个本家字段 id、通用 ≥ minKeyedFields 个带键字段），这里构造不出
 * 「根找到了、键一个都没有」的页，所以不另测。
 */

const SOURCES = {
  ashby, bamboohr, dover, generic, greenhouse, icims, jobvite, lever, rippling, smartrecruiters, workable, workday,
} as never;

const APPLY_PATH = '/en-US/NVIDIAExternalCareerSite/job/US-CA-Remote/X_JR2024816/apply';

/** 2026-09-22 nvidia.wd5 第 3 步的结构骨架：题干在 legend 里，控件是按钮下拉 + 0×0 镜像输入框。 */
const question = (guid: string, text: string) => `
  <div data-automation-id="formField-${guid}" data-fkit-id="primaryQuestionnaire--${guid}">
    <fieldset>
      <legend><div data-automation-id="richText"><p>${text}</p></div></legend>
      <div><div><div><button id="primaryQuestionnaire--${guid}" type="button" aria-haspopup="listbox">Select One</button><input type="text" /><span></span></div></div></div>
    </fieldset>
  </div>`;

const QUESTIONS_PAGE = `
  <div data-automation-id="applyFlowPrimaryQuestionsPage">
    <div data-fkit-id="primaryQuestionnaire--null">
      ${question('2f2764b3a829100642af25b88deb0000', 'Are you legally authorized to work in the country where this position is located')}
      ${question('2f2764b3a829100642af26ec534f0000', 'Will you require employer support to obtain or maintain authorization to work in the country where this position is located?')}
    </div>
  </div>`;

async function workdayAdapter() {
  const built = await buildApplyRulesRelease(releaseManifest as never, SOURCES);
  if (!built.ok) throw new Error(built.code);
  const registry = await createRuntimeApplyRegistry(built.value);
  if (!registry.ok) throw new Error(registry.code);
  const resolved = resolveRuntimeApplyAdapter(registry.value, { atsProvider: 'WORKDAY', pathRuleId: 'workday-application-v1' });
  if (!resolved.ok) throw new Error(resolved.code);
  return resolved.value;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('厂商路上整页都是自定义题', () => {
  it('Workday Application Questions：一个键都没有，照样交出这两道题（题干取自 legend）', async () => {
    const resolved = await workdayAdapter();
    document.body.innerHTML = QUESTIONS_PAGE;
    const result = readRuntimeApplyFormResult(resolved, APPLY_PATH, document);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.descriptor.fields.map((field) => field.key)).toEqual([null, null]);
    expect(result.descriptor.fields.map((field) => field.label)).toEqual([
      'Are you legally authorized to work in the country where this position is located',
      'Will you require employer support to obtain or maintain authorization to work in the country where this position is located?',
    ]);
  });

  it('页锚命中但一个字段都没有 → 照旧拒', async () => {
    const resolved = await workdayAdapter();
    document.body.innerHTML = '<div data-automation-id="applyFlowPrimaryQuestionsPage"><p>Nothing to answer.</p></div>';
    expect(readRuntimeApplyFormResult(resolved, APPLY_PATH, document))
      .toEqual({ ok: false, stop: 'NO_KEYED_FIELD' });
  });
});
