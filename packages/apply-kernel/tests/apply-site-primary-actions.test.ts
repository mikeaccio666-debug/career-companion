import { afterEach, describe, expect, it } from 'vitest';

import { sitePrimaryActions } from '../src/wizardAdvance';

/**
 * 网站自己的主要操作按钮（2026-10-04，bench-1003「体验」：浮层自动打开时盖住了网站右侧的按钮——BambooHR 的「Apply for
 * This Job」、Greenhouse 的「Submit application」只露出左半截、Workday 第 2 页底部的「Save and Continue」）。
 *
 * 浮层自动打开之前问一次：这几颗在不在面板要占的那一条里。只读、只认通用的说法与结构（提交控件；名字整句是申请、提交、
 * 下一步的按钮），不认任何一家的 DOM（RULE-GLOBAL-DOM-RULE-BOUNDARY），也不点。
 */

afterEach(() => { document.body.innerHTML = ''; });

const visible = () => true;
const ids = (elements: readonly Element[]) => elements.map((element) => element.id);

describe('网站自己的主要操作按钮', () => {
  it('写明了的提交控件：button[type=submit]、input[type=submit]；表里没写 type 的 button 只按名字算（Ashby 的「Upload file」不算）', () => {
    document.body.innerHTML = `
      <form><button id="a" type="submit">Send it</button><button id="b">Upload file</button><button id="e">Submit Application</button>
      <input id="c" type="submit" value="OK"></form>
      <button id="d">Toggle menu</button>`;
    expect(ids(sitePrimaryActions({ document, isVisible: visible }))).toEqual(['a', 'e', 'c']);
  });

  it('名字整句是申请、提交、下一步的按钮（BambooHR 的「Apply for This Job」、Workday 的「Save and Continue」）', () => {
    document.body.innerHTML = `
      <button id="apply" type="button" data-bi-id="careers-site-apply-button">Apply for This Job</button>
      <div id="next" role="button">Save and Continue</div>
      <a id="link" href="/apply">Apply Now</a>
      <button id="share" type="button">Share this job</button>
      <button id="linkedin" type="button">Apply with LinkedIn</button>`;
    expect(ids(sitePrimaryActions({ document, isVisible: visible }))).toEqual(['apply', 'next', 'link']);
  });

  it('看不见的、停用的不算', () => {
    document.body.innerHTML = '<button id="a" type="button" hidden>Apply</button><button id="b" type="button" disabled>Submit application</button><button id="c" type="button">Submit Application</button>';
    expect(ids(sitePrimaryActions({ document, isVisible: (element) => !element.hasAttribute('hidden') }))).toEqual(['c']);
  });
});
