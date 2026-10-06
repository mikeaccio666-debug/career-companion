import { describe, expect, it } from 'vitest';
import { senderTabForPage, senderTabForPageOrFrame } from '../lib/senderPage';
import { recordFrameForm } from '../lib/frameFormRegistry';

/**
 * dock 消息的发信人核对。重点是最后一条：申请页常常带着 `?gh_src=…` 打开，
 * 整条 URL 比对会把真用户拒在门外；而 origin + pathname 的比对一个字都不放松。
 */

const EXT = 'boibiooejloflbbfiofnaaddckegpkhk';
const PAGE = { origin: 'https://job-boards.greenhouse.io', pathname: '/airtable/jobs/8586863002' };
const sender = (over: Record<string, unknown> = {}) => ({
  id: EXT, frameId: 0, tab: { id: 7 }, url: `${PAGE.origin}${PAGE.pathname}`, ...over,
});

describe('发信人核对', () => {
  it('我们自己的顶层帧、页面对得上 → 交回标签页 id', () => {
    expect(senderTabForPage(sender(), EXT, PAGE)).toBe(7);
  });

  it('带查询串或片段的同一页照样认——用户从职位站点点过来就是这个样子', () => {
    expect(senderTabForPage(sender({ url: `${PAGE.origin}${PAGE.pathname}?gh_src=abc123` }), EXT, PAGE)).toBe(7);
    expect(senderTabForPage(sender({ url: `${PAGE.origin}${PAGE.pathname}#app` }), EXT, PAGE)).toBe(7);
  });

  it.each([
    ['别的扩展', { id: 'x'.repeat(32) }],
    ['子帧', { frameId: 1 }],
    ['没有标签页', { tab: undefined }],
    ['标签页 id 不是整数', { tab: { id: 1.5 } }],
    ['没有 url', { url: undefined }],
    ['url 不成形', { url: 'not a url' }],
    ['别的站', { url: `https://evil.example${PAGE.pathname}` }],
    ['同站别的页', { url: `${PAGE.origin}/other/jobs/1` }],
    ['路径只差一个字', { url: `${PAGE.origin}${PAGE.pathname}2` }],
  ])('%s → 拒', (_why, over) => {
    expect(senderTabForPage(sender(over), EXT, PAGE)).toBeNull();
  });
});

/**
 * 单页应用在加载之后用 pushState 改了地址（2026-09-22 nvidia.wd5 实测：草稿建立后申请页一加载就从
 * …/apply/applyManually 改成 …/apply）。Chrome 交给 worker 的 `sender.url` 停在文档加载时的那一个，
 * 内容脚本读到的却是改过的——两者逐字比，每一条消息都被默默丢掉，浮层只说「没能取得填写授权」。
 *
 * 消息于是多带一项 `documentPathname`（文档加载时的路径）：它必须与 `sender.url` 逐字相等，
 * 当前路径 `pathname` 只能在同一个 origin 里。
 */
describe('单页应用改过地址', () => {
  const WORKDAY = 'https://nvidia.wd5.myworkdayjobs.com';
  const LOADED = '/en-US/NVIDIAExternalCareerSite/job/US-CA-Remote/X_JR2024816/apply/applyManually';
  const NOW = '/en-US/NVIDIAExternalCareerSite/job/US-CA-Remote/X_JR2024816/apply';
  const spaSender = sender({ url: `${WORKDAY}${LOADED}` });

  it('带着加载时的路径、它与发信人地址逐字相等 → 认（当前路径用来判这是不是申请页）', () => {
    expect(senderTabForPage(spaSender, EXT, { origin: WORKDAY, pathname: NOW, documentPathname: LOADED })).toBe(7);
    expect(senderTabForPageOrFrame(spaSender, EXT, { origin: WORKDAY, pathname: NOW, documentPathname: LOADED }, {})).toBe(7);
  });

  it('没带加载时的路径 → 照旧逐字比，对不上就拒', () => {
    expect(senderTabForPage(spaSender, EXT, { origin: WORKDAY, pathname: NOW })).toBeNull();
  });

  it('带的加载路径与发信人地址对不上 → 拒（这一条一点不放松）', () => {
    expect(senderTabForPage(spaSender, EXT, { origin: WORKDAY, pathname: NOW, documentPathname: `${LOADED}x` })).toBeNull();
  });

  it('origin 对不上 → 拒，不管路径怎么说', () => {
    expect(senderTabForPage(spaSender, EXT, { origin: 'https://evil.example', pathname: NOW, documentPathname: LOADED })).toBeNull();
  });
});

describe('子帧持表时的放宽（P2-10）', () => {
  const FRAME = { origin: 'https://boards.greenhouse.io', pathname: '/embed/job_app' };
  const forms = recordFrameForm({}, { tabId: 7, frameId: 3, canonicalOrigin: FRAME.origin, pathname: FRAME.pathname, at: 1 }).registry;
  const frameSender = (over: Record<string, unknown> = {}) => sender({
    frameId: 3, url: `${FRAME.origin}${FRAME.pathname}?for=acme&token=1`, ...over,
  });

  it('登记过的那一帧、报的页面与登记一致 → 交回标签页 id', () => {
    expect(senderTabForPageOrFrame(frameSender(), EXT, FRAME, forms)).toBe(7);
  });

  it('顶层帧照旧走原来那四条', () => {
    expect(senderTabForPageOrFrame(sender(), EXT, PAGE, forms)).toBe(7);
    expect(senderTabForPageOrFrame(sender(), EXT, FRAME, forms)).toBeNull();
  });

  it.each([
    ['没登记的帧', { frameId: 4 }],
    ['别的扩展', { id: 'x'.repeat(32) }],
    ['换了页', { url: `${FRAME.origin}/embed/job_board` }],
    ['报的页面与登记不符', { url: `${FRAME.origin}${FRAME.pathname}` }, { origin: FRAME.origin, pathname: '/acme/jobs/1' }],
    ['没有标签页', { tab: undefined }],
  ])('%s → 拒', (_why, over, page = FRAME) => {
    expect(senderTabForPageOrFrame(frameSender(over), EXT, page, forms)).toBeNull();
  });

  it('表里没有这个标签页 → 拒（与「换页了」同一个答案）', () => {
    expect(senderTabForPageOrFrame(frameSender(), EXT, FRAME, {})).toBeNull();
  });
});
