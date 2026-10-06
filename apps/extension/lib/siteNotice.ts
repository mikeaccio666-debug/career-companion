/**
 * 「我认出这是 Greenhouse，但这一页上没有申请表」——疑似支持时的一句解释
 * （CAP-AF-014 的可见面）。
 *
 * 用户点了 Fill，然后什么都没发生。今天他得到的信息量是零，于是形成
 * 「这插件时灵时不灵」的印象（卡片 impact 逐字）。这条 UI 就是把那一刻的
 * 沉默换成一句话。
 *
 * 纪律与 `auditPanel.ts` 同源：只新增我方一个 closed shadow 容器、不碰宿主任何
 * 节点与样式（铁律 3）、单实例、pagehide 自拆、零文档级监听。
 *
 * Data-L1：只显示厂商名与固定文案。不显示 URL、不显示页面文本、不显示任何
 * 字段标签——「认不出这一页」这件事本身不需要引用这一页的内容来说明。
 */

import type { ApplyVendor } from '@edaix/apply-kernel/contracts';
import type { SiteGuidance } from './siteSupport';

const HOST_ID = 'edaix-site-notice';

let dismissCurrent: (() => void) | null = null;

/** 厂商展示名。用固定表而不是把 vendor 串直接印出来——那是内部标识。 */
const VENDOR_LABEL: Readonly<Record<ApplyVendor, string>> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workable: 'Workable',
  workday: 'Workday',
  avature: 'Avature',
  smartrecruiters: 'SmartRecruiters',
  icims: 'iCIMS',
  rippling: 'Rippling',
  dover: 'Dover',
  bamboohr: 'BambooHR',
  jobvite: 'Jobvite',
  // 不绑厂商的那条路没有厂商名可印——对用户它就是「这一页」。
  generic: '这一页',
};

export interface SiteNoticeHandle {
  readonly dismiss: () => void;
  readonly shadowRoot: ShadowRoot | null;
}

const NOOP: SiteNoticeHandle = { dismiss: () => {}, shadowRoot: null };

/** Removes the currently mounted notice, if any. */
export function dismissSiteNotice(): void {
  dismissCurrent?.();
}

/**
 * 疑似支持时说明为什么没动。`vendor` 为 null 时不显示——那是 UNSUPPORTED，
 * 在任意网页上弹东西正是竞品被差评卸载的形状（见 siteSupport.ts 头注）。
 */
export function showSiteNotice(
  vendor: ApplyVendor | null,
  guidance: SiteGuidance = 'NO_FORM_FOUND',
  doc: Document = document,
): SiteNoticeHandle {
  if (vendor === null) return NOOP;

  dismissSiteNotice();

  const host = doc.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = doc.createElement('style');
  style.textContent = `
:host { all: initial; }
.bar {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  max-width: 320px; background: #1a1a2e; color: #fff; border-radius: 10px;
  padding: 12px 14px; box-shadow: 0 6px 24px rgba(0,0,0,.35);
  font: 13px/1.55 system-ui, -apple-system, "PingFang SC", sans-serif;
  display: flex; gap: 10px; align-items: flex-start;
}
p { margin: 0; flex: 1; }
.dim { color: #b9b9cc; display: block; margin-top: 2px; font-size: 12px; }
button {
  flex: none; background: #33334d; color: #fff; border: 0; border-radius: 6px;
  padding: 4px 10px; cursor: pointer; font: 12px system-ui, sans-serif;
}
button:hover { background: #45456a; }
button:focus-visible { outline: 2px solid #8ab4ff; outline-offset: 1px; }`;

  const bar = doc.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'status');

  const text = doc.createElement('p');
  const hint = doc.createElement('span');
  hint.className = 'dim';
  if (guidance === 'SIGN_IN_FIRST') {
    // 账号墙 ATS 的第 1 步。密码只能他本人输——所以这条 UI 里**没有任何输入框**，
    // 而且明说"在本页自己输入"：形状上与钓鱼相反。
    text.textContent = `${VENDOR_LABEL[vendor]} 需要先有账号。请在本页自己登录或注册。`;
    hint.textContent = '密码请你本人输入，我们不看也不存。登录完成后回到申请表，我接着帮你填。';
  } else {
    text.textContent = `认出这是 ${VENDOR_LABEL[vendor]}，但这一页上没找到申请表。`;
    // 绝大多数情况是用户还停在岗位描述页，点进申请页就好了。
    hint.textContent = '如果你已经在申请页上，可能是这家改版了——这一栏我们暂时填不了。';
  }
  text.append(hint);

  const dismiss = () => {
    host.remove();
    doc.defaultView?.removeEventListener('pagehide', dismiss);
    if (dismissCurrent === dismiss) dismissCurrent = null;
  };
  const close = doc.createElement('button');
  close.type = 'button';
  close.textContent = '知道了';
  close.addEventListener('click', dismiss);

  bar.append(text, close);
  shadow.append(style, bar);
  doc.defaultView?.addEventListener('pagehide', dismiss);
  doc.documentElement.append(host);
  dismissCurrent = dismiss;
  return { dismiss, shadowRoot: shadow };
}
