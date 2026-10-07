import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 连填（2026-09-28「按一下自动填写，一页一页填到检查页」）在内容脚本里接对了没有（源码形状闸）。
 *
 * 内核的边界、连填的判断、浮层各自有行为测试；这一条钉接线——它们错了，各自的测试照样全绿，而产品上的症状是
 * 「连填从不开」「停止之后还在翻页」「用点击凭证之外的东西写了一页」或「Assistant 构建里多出 22 KB」。
 */
const content = readFileSync(resolve(__dirname, '..', 'entrypoints', 'apply.content.ts'), 'utf8');
const driver = readFileSync(resolve(__dirname, '..', 'lib', 'fillToReview.ts'), 'utf8');

function between(start: string, end: string): string {
  const from = content.indexOf(start);
  expect(from, start).toBeGreaterThan(0);
  const to = content.indexOf(end, from);
  expect(to, end).toBeGreaterThan(from);
  return content.slice(from, to);
}

describe('连填的接线', () => {
  const gestureFill = between('const runGestureFill = async (', 'const showFace = ');

  it('一次真实点击开新的一轮：上一轮连填在第一个 await 之前就作废（连填翻到的页接着那一轮）', () => {
    const end = gestureFill.indexOf('if (chainDriver.pageOf(root) === null) chainDriver.end();');
    expect(end).toBeGreaterThan(0);
    expect(end).toBeLessThan(gestureFill.indexOf('await '));
  });

  it('扫出表之后才开（或接着）一轮，交的是后端下发的写策略、这一页的翻页按钮与网站说的这一步；不能用就一个字不写', () => {
    const begin = gestureFill.indexOf('const chain = chainDriver.begin({');
    expect(begin).toBeGreaterThan(gestureFill.indexOf('if (outcome.scan === null) {'));
    const call = gestureFill.slice(begin, begin + 700);
    expect(call).toContain('root,');
    expect(call).toContain('policy: runtime.fillPolicy,');
    expect(call).toContain('next: () => nextControlState({ document, descriptor: scanned.descriptor, isVisible: isRenderedControl }),');
    expect(call).toContain('site: () => readWizardProgress({ document, isVisible: isRenderedControl }),');
    const refused = gestureFill.indexOf("if (chain.kind === 'REFUSED') {");
    expect(refused).toBeGreaterThan(begin);
    expect(gestureFill.slice(refused, refused + 400)).toContain('return;');
    expect(refused).toBeLessThan(gestureFill.indexOf('fillFromGesture({'));
  });

  it('这一页用哪张凭证写，由连填说：填写、AI 代答、晚到的求职信、整轮之后的重填，用的都是同一张', () => {
    const proof = gestureFill.indexOf('const proof: GestureRoot = chain.proof;');
    expect(proof).toBeGreaterThan(0);
    for (const use of ['createAiAnswersSession({\n        gesture: proof,', 'proof,\n        scan: outcome.scan,', 'attach(proof, letter.material)', 'audit.repairReverted(proof)']) {
      const at = gestureFill.indexOf(use);
      expect(at, use).toBeGreaterThan(proof);
    }
  });

  it('这一页有了结局才问往不往下翻：经 closeGestureRun 的 next，交的是这一页此刻的单子、最终提交在不在、翻页按钮的情况', () => {
    const continuation = gestureFill.indexOf("const continueChain = chain.kind !== 'CHAIN' ? undefined : (written: number) => chainDriver.afterPage(chain.page, {");
    expect(continuation).toBeGreaterThan(0);
    const facts = gestureFill.slice(continuation, continuation + 1300);
    expect(facts).toContain('current: stillThisRun,');
    expect(facts).toContain('stopped: () => stopper.signal.aborted,');
    // 单子里的必填，加上页面上还空着、浮层没认出的（2026-10-04 Jobvite：浮层只数自己认得的行，替他按了「Next」）；
    // 网站此刻标着的错另算。
    expect(facts).toContain('requiredNeeds: () => requiredNeedsIn(pageView) + pageGapsFor(pageView).unplanned.length,');
    expect(facts).toContain('siteErrors: () => { const gaps = pageGapsFor(pageView); return gaps.invalid + gaps.alerts; },');
    expect(facts).toContain('finalSubmit: () => finalSubmitOnPage(scanned.descriptor),');
    expect(facts).toContain('next: () => wizardAdvance.nextState(),');
    const close = gestureFill.indexOf('closeGestureRun({');
    expect(close).toBeGreaterThan(continuation);
    expect(gestureFill.slice(close, close + 800)).toContain('...(continueChain === undefined ? {} : { next: continueChain }),');
    // AI 写上、求职信附上、复查改判：单子一换，连填看到的那一份也跟着换。
    expect(gestureFill.match(/pageView = /gu)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it('翻过去之后新一页扫不出表：连填翻到的页照实说是检查页、关卡、还是认不出的一页', () => {
    const noForm = gestureFill.indexOf('chainDriver.noForm(root, { origin: location.origin, pathname: location.pathname, next: nextControlWithoutForm() })');
    expect(noForm).toBeGreaterThan(0);
    expect(gestureFill.slice(noForm, noForm + 700)).toContain('dockHandle?.reportBlocked(`CHAIN_${ended.stop}`);');
    expect(gestureFill.slice(noForm, noForm + 900)).toContain("dockHandle?.setChain(chainDockState(ended.page, 'REVIEW'));");
  });

  it('连填翻页只凭那一轮的这一步、按的是控制器认出的那一颗；翻过去用新一页的凭证接着填；重读的是同一份写策略', () => {
    const deps = between('const fillToReview = (): FillToReview => {', '    };');
    expect(deps).toContain('resolvePolicy: resolveGesturePolicy,');
    expect(deps).toContain('advance: (step) => wizardAdvance.advanceInRun(step),');
    expect(deps).toContain('checkpoint: () => detectHumanCheckpoint({ document, isVisible: isRenderedControl }),');
    expect(deps).toContain("fillNextPage: (page) => { void runGestureFill(page, driver, 'AFTER_ADVANCE'); },");
    // 离开这一页（整页跳走、进往返缓存）：连填那一轮随之作废。挂在建它的那一刻，与它同生同死。
    expect(deps).toContain("window.addEventListener('pagehide', () => { driver.end(); });");
  });

  it('「停止」、自己翻页、浮层被拆（换脸、让给助手、让给顶层帧）：连填那一轮一并作废', () => {
    expect(content).toContain('onStop: () => { fillToReviewNow?.end(); gestureStop?.abort(); }');
    // 账号墙那一套（2026-09-28）同生同死：等着他回来接着登录的那一下也一并收掉。
    expect(content).toContain('onDismissed: () => { fillToReviewNow?.end(); gestureStop?.abort(); account?.dispose(); codePage?.dispose(); submitCodeHook.read = () => null; },');
    const arm = gestureFill.indexOf('wizardAdvance.arm({');
    expect(gestureFill.slice(arm, arm + 500)).toContain('chainDriver.end();');
    // 原有四处仍保持相邻 disarm；登录态失效额外先清用户资料，再由同步 dismiss 收掉那一轮。
    expect(content.match(/wizardAdvance\.disarm\(\);\s*submitter\.disarm\(\);\s*dockHandle\?\.dismiss\(\);/gu)?.length).toBe(4);
    const invalidation = between('if (!isDockSessionChanged(raw)', '// 资料或代填授权在插件里');
    expect(invalidation).toContain('gestureStop?.abort();');
    expect(invalidation).toContain('wizardAdvance.disarm(); submitter.disarm();');
    expect(invalidation.indexOf('dockHandle?.dismiss();')).toBeLessThan(invalidation.indexOf('void hello();'));
    const dock = readFileSync(resolve(__dirname, '..', 'lib', 'dock', 'dock.ts'), 'utf8');
    const dismiss = dock.slice(dock.indexOf('const dismiss = (): void => {'));
    expect(dismiss.slice(0, 400)).toContain('handlers.onDismissed?.();');
  });

  it('runGestureFill 不回头叫取用函数：连填由调用方交进去（两者互相引用，打包器就删不掉这一对）', () => {
    const code = gestureFill.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
    expect(code).toContain('const runGestureFill = async (root: GestureRoot, chainDriver: FillToReview, mode?: \'AFTER_ADVANCE\')');
    expect(code.match(/fillToReview\(\)|fillToReviewNow/gu) ?? []).toHaveLength(0);
    expect(content).toContain('void runGestureFill(proof, fillToReview());');
  });

  it('用到时才建：外层活代码一处都不碰它，runGestureFill 不被拉进 Assistant 构建', () => {
    // 手势填写（runGestureFill）与浮层（showFace）之外的活代码：不调 fillToReview()，连 fillToReviewNow 这个变量都不读——
    // 读了，打包器会留下对它的每一次赋值与所在的函数，一路把整条手势填写链拉回 Assistant 的 apply.js（2026-09-28 实测 +68 KB）。
    const start = content.indexOf('let fillToReviewNow: FillToReview | null = null;');
    const accessorEnd = content.indexOf('      return driver;\n    };', start);
    expect(accessorEnd).toBeGreaterThan(start);
    // 手势填写与浮层（runGestureFill 起、showFace 止）在 Assistant 构建里整段是死代码，不算外层。
    const showFaceEnd = content.indexOf('if (justSubmitted) missionSession.confirmArrival(document);');
    expect(showFaceEnd).toBeGreaterThan(content.indexOf('const showFace = '));
    const outside = content.slice(0, start) +
      content.slice(accessorEnd, content.indexOf('const runGestureFill = async (')) +
      content.slice(showFaceEnd);
    // 注释里提到它不算（头注正是在说这件事）。
    const code = outside.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
    expect(code.match(/fillToReview\(\)/gu) ?? [], '外层调了 fillToReview()').toHaveLength(0);
    expect(code.match(/fillToReviewNow/gu) ?? [], '外层读了 fillToReviewNow').toHaveLength(0);
  });
});

describe('连填从不碰最终提交', () => {
  it('编排里没有任何一次点击、没有提交控制器，也不认最终提交之外的任何控件', () => {
    expect(driver).not.toMatch(/\.click\(/u);
    expect(driver).not.toMatch(/submitter|submission|requestSubmit|\.submit\(/u);
  });

  it('控制器替连填翻页时：这一页上有规则声明的最终提交就不翻', () => {
    const controller = readFileSync(resolve(__dirname, '..', 'lib', 'wizardAdvanceController.ts'), 'utf8');
    const inRun = controller.slice(controller.indexOf('advanceInRun(step: AdvanceRunStep): Promise<DockAdvanceOutcome> {'));
    expect(inRun.slice(0, 900)).toContain('!finalSubmitOnPage(page.descriptor)');
    expect(inRun.slice(0, 900)).toContain('isAdvanceRunStepCurrent(step, now())');
  });
});

describe('页面上还空着、浮层没认出的必填（2026-10-04）', () => {
  const gestureFill = content.slice(content.indexOf('const runGestureFill = async ('), content.indexOf('const showFace = '));

  it('每一份终局单子都加上页面上还空着的必填：读法在内核、用扫描认出的那张表，可见性与翻页同一把尺', () => {
    expect(gestureFill).toContain('const pageGapsFor = (view: AuditView | null): PageGaps => {');
    // 判成蜜罐、不进单子的那几栏（Jobvite 自己画的单选被判成了蜜罐），与单子里当选填列着、网站却标了必填的，不算「认出来了」。
    expect(gestureFill).toContain('const unshown = new Set(audits[0]?.unshown ?? []);');
    expect(gestureFill).toContain('const optional = new Set((view?.rows ?? []).filter((row) => !row.required).map((row) => row.element));');
    // 加行之后重扫过：按这一轮最后一次扫描认出的那几栏算（Workday 新加的教育行只在那一次里）。
    expect(gestureFill).toContain('const scannedFields = audits[0]?.scanFields?.() ?? scanned.descriptor.fields;');
    // 规则声明的题干随描述符带过去：读不出题目的那几道（Rippling 自定义题的「Select」）用它当题目。
    expect(gestureFill).toContain('const questionText = scanned.descriptor.questionText;');
    expect(gestureFill).toContain('form: { root: scanned.descriptor.root, fields, ...(questionText === undefined ? {} : { questionText }) },');
    expect(gestureFill).toContain('isVisible: isRenderedControl,');
    expect(gestureFill).toContain('const settledProgress = (view: AuditView) => withPageGaps(dockProgressFromAudit(runId, view, dockLocale()), pageGapsFor(view), dockCopy(dockLocale()).unnamedRequired);');
    // 收尾之后交给浮层的单子一律经它（填写途中的那一份照旧不加：那时还没轮到）。
    expect(gestureFill.match(/dockProgressFromAudit\(/gu)?.length).toBe(1);
    expect(gestureFill.match(/settledProgress\(/gu)?.length ?? 0).toBeGreaterThanOrEqual(7);
  });
});
