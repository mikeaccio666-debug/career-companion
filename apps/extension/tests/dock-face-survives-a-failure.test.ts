import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 连上之后，任何一次失败都不许把浮层整个抹掉。
 *
 * 报到 handler 算完那张脸才回消息；算的过程里有三次 await——取 token、装规则、
 * 问这一页属不属于某个 Mission。整段外面套着一个 `.catch(() => undefined)`，
 * 而 `undefined` 在内容脚本那边的意思是**不挂浮层**（`parseAutofillDockInstruction`
 * 认不出的面一律不挂，这条是对的：不可信边界上认不出的东西不能变成 UI）。
 *
 * 于是三次 await 里任何一次抛出，用户看到的不是一句解释，是**什么都没有**。
 *
 * 2026-09-18 实测到这个形状：同一个包，干净 profile 出浮层、**连接过的 profile
 * 不出**——两者唯一的差别就是有没有 authSession，而有 token 的那条路多走了
 * 取 token 与问 Mission 两步。用户的说法是「插件连不上」，其实是连上之后才没的。
 *
 * 浮层本来就有话可说：没登录说「登录将前往 Portal」，取不到规则说「暂时取不到
 * 填写规则」，不属于任何 Mission 说「这个职位还不在你的申请清单里」。任何一句都
 * 好过一片空白——空白让人以为插件坏了或者这一页不支持。
 *
 * 所以每一次 await 自己兜住自己：兜住之后那张脸照样算得出来，只是算出的是
 * 「没连上 / 没规则 / 不属于任何 Mission」——正是那次失败的真实含义。
 *
 * 与 `dock-face-awaits-rules` 同一个路数的源码形状闸：background 的接线没有别的
 * 办法在单测里摆出「token 过期 + 冷启动」这个时序，而它恰恰是出问题的那一刻。
 */

const background = readFileSync(
  resolve(__dirname, '..', 'entrypoints', 'background.ts'),
  'utf8',
);
const content = readFileSync(
  resolve(__dirname, '..', 'entrypoints', 'apply.content.ts'),
  'utf8',
);

/** 报到那个 handler 的正文：从 parseBridgeHello 到下一个 handler 之前。 */
function helloHandler(): string {
  const start = background.indexOf('const hello = parseBridgeHello(message);');
  expect(start, '找不到报到 handler；这条闸要跟着改').toBeGreaterThan(-1);
  const end = background.indexOf('parseDockAddJobIntent(message)', start);
  expect(end, '找不到下一个 handler 的边界').toBeGreaterThan(start);
  return background.slice(start, end);
}

describe('算那张脸时，每一次失败都要能兜住', () => {
  const handler = () => helloHandler();

  it('取 token 失败不掀桌子', () => {
    // 过期的 session 刷新不动时这里会抛。抛了就没有脸，用户看到一片空白。
    expect(handler()).toMatch(/getAccessToken\(\)[\s\S]{0,120}?\.catch\(/u);
  });

  it('装规则失败不掀桌子', () => {
    expect(handler()).toMatch(/rulesInstaller\.rules\(\)[\s\S]{0,80}?\.catch\(/u);
  });

  it('问 Mission 归属失败不掀桌子', () => {
    // 客户端自己承诺「不是明确的 yes 就是 no」，但那个承诺止于它的边界；
    // 这里再兜一次，任何一侧改坏了都不会变成「浮层消失」。
    expect(handler()).toMatch(/isBound\([\s\S]{0,40}?\)[\s\S]{0,80}?\.catch\(/u);
  });

  it('三次 await 全都在同一个 handler 里（这条闸不是空转的）', () => {
    const body = handler();
    expect(body).toContain('getAccessToken()');
    expect(body).toContain('rulesInstaller.rules()');
    expect(body).toContain('isBound(');
  });
});

/**
 * 「这是不是我们浮层里的真点击」必须在**点击当下**判完。
 *
 * `event.composedPath()` 在事件派发结束的那一刻就返回空数组，而无 mission 那条
 * 填写路在铸票之前全是 await：问后台要授权、要档案、解出运行时、扫这一页。
 * 判定但凡落在其中任何一个 await 之后，都必然判否——不是因为点击不成立，
 * 是因为那时已经问不出来了。2026-09-18 实测：整条链跑到最后一步，浮层说
 * 「这一次点击没能通过校验」，而那一次点击完全真实。
 *
 * 所以这条闸盯的是**顺序**：`captureTrustedShadowGesture` 要出现在
 * `runGestureFill` 之前，也就是那串 await 开始之前。
 */
describe('手势凭证在点击当下取', () => {
  const handler = (): string => {
    const start = content.indexOf('onAutofill: (event, shadowRoot) => {');
    expect(start, '找不到 Autofill 的点击入口；这条闸要跟着改').toBeGreaterThan(-1);
    // 2026-09-23 新浮层没有「生成申请卡片」：下一个入口是 onOpenPortal。
    const end = content.indexOf('onOpenPortal: openPortal,', start);
    expect(end, '找不到下一个入口的边界').toBeGreaterThan(start);
    return content.slice(start, end);
  };

  it('入口里取过凭证', () => {
    expect(handler()).toContain('captureTrustedShadowGesture(event, shadowRoot)');
  });

  it('而且取在 runGestureFill 之前——那之后全是 await', () => {
    const body = handler();
    expect(body.indexOf('captureTrustedShadowGesture'))
      .toBeLessThan(body.indexOf('runGestureFill('));
  });

  it('取不到就当场如实说，不往下走', () => {
    expect(handler()).toMatch(/proof === null[\s\S]{0,200}?GESTURE_UNTRUSTED/u);
  });
});

/**
 * 手势填写的每一次拒绝，都必须在浮层上看得见。
 *
 * `finishRun` 第一行是 `if (!sheetAllowed || !sheetExists) return;`——没有运行面板时
 * 它什么都不做。而这条路上的早期拒绝（要不到授权、要不到档案、解不出运行时、
 * 扫不出表单、手势没过校验）全都发生在任何面板出现之前，于是用户按下 Autofill，
 * 浮层一声不吭。那正是「点了没反应」。
 *
 * `reportBlocked` 是为这件事准备的：没有面板它自己 claim 一个，再把理由画上去。
 *
 * 2026-09-18 批测里抓到的形状：legacy `boards.greenhouse.io` 那一批全是「浮层还停在
 * 主界面」，25 个控件一个没填，而浮层从头到尾没说过一句话。
 */
describe('手势填写的拒绝要看得见', () => {
  const run = (): string => {
    // 2026-09-28 起参数叫 root（连填翻到的那几页交的是那一轮发给这一页的凭证，不是点击）：只认函数名。
    const start = content.indexOf('const runGestureFill = async (');
    expect(start, '找不到手势填写那一段；这条闸要跟着改').toBeGreaterThan(-1);
    const end = content.indexOf('const showFace = (reply: unknown)', start);
    expect(end, '找不到下一段的边界').toBeGreaterThan(start);
    return content.slice(start, end);
  };

  it('这一段里没有任何一条 finishRun({ started: false })', () => {
    expect(run()).not.toMatch(/finishRun\(\{\s*started:\s*false/u);
  });

  it('拒绝走的是 reportBlocked', () => {
    expect(run().match(/reportBlocked\(/gu)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it('成功那一条仍然走 finishRun——它那时已经有面板了', () => {
    // 2026-09-24 起收尾经 closeGestureRun（AI 代答还在起草时要等它的结局）：finishRun 在那里。
    expect(run()).toContain('closeGestureRun({');
    const close = readFileSync(resolve(__dirname, '..', 'lib', 'gestureRunClose.ts'), 'utf8');
    expect(close).toMatch(/finishRun\(\{\s*started:\s*true,\s*outcome:\s*'FILLED'\s*\}\)/u);
    expect(close, '拒绝照旧走 reportBlocked').not.toMatch(/finishRun\(\{\s*started:\s*false/u);
  });
});
