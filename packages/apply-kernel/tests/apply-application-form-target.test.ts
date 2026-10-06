import { afterEach, describe, expect, it } from 'vitest';

import { applicationFormTarget } from '../src/gate/applicationFormTarget';

/**
 * 白标 C（P2-12）：指纹认出厂商但页面上没有申请表时，从厂商自己的产物里读出「申请表在哪」。
 * 拼不出唯一 URL 就 null——两个 board、两个岗位 id、坏 token，一律不猜。
 */

afterEach(() => {
  document.documentElement.innerHTML = '<head></head><body></body>';
});

const target = (href: string) => applicationFormTarget({ doc: document, url: new URL(href) });

describe('applicationFormTarget · Greenhouse', () => {
  it('预载的 boards-api 给 board token，?gh_jid= 给岗位 id → 两样齐了才有目标', () => {
    document.head.innerHTML = '<link as="fetch" rel="preload" href="https://boards-api.greenhouse.io/v1/boards/duolingo/departments">';
    expect(target('https://careers.duolingo.com/jobs/8653419002?gh_jid=8653419002'))
      .toEqual({ vendor: 'greenhouse', boardToken: 'duolingo', jobId: '8653419002' });
    // 少一样就没有：没有 gh_jid 只知道是哪个 board，不知道是哪个岗位。
    expect(target('https://careers.duolingo.com/jobs/8653419002')).toBeNull();
    document.head.innerHTML = '';
    expect(target('https://careers.duolingo.com/jobs/8653419002?gh_jid=8653419002')).toBeNull();
  });

  it('官方 embed 的 iframe src 自带两样（for=<board>&token=<job>）', () => {
    document.body.innerHTML = '<div id="grnhse_app"><iframe id="grnhse_iframe" src="https://boards.greenhouse.io/embed/job_app?for=brex&token=8686667002"></iframe></div>';
    expect(target('https://www.brex.com/careers/8686667002'))
      .toEqual({ vendor: 'greenhouse', boardToken: 'brex', jobId: '8686667002' });
  });

  it('两个 board 或两个岗位 id → 不猜；别家主机的预载不算', () => {
    document.head.innerHTML = `
      <link rel="preload" href="https://boards-api.greenhouse.io/v1/boards/duolingo/departments">
      <link rel="preload" href="https://boards-api.greenhouse.io/v1/boards/other/jobs">`;
    expect(target('https://careers.example.com/jobs/1?gh_jid=1')).toBeNull();
    document.head.innerHTML = '<link rel="preload" href="https://boards-api.greenhouse.io/v1/boards/duolingo/departments">';
    document.body.innerHTML = '<iframe id="grnhse_iframe" src="https://boards.greenhouse.io/embed/job_app?for=duolingo&token=2"></iframe>';
    expect(target('https://careers.example.com/jobs/1?gh_jid=1')).toBeNull();
    document.body.innerHTML = '';
    document.head.innerHTML = '<link rel="preload" href="https://boards-api.greenhouse.io.evil.example/v1/boards/duolingo/departments">';
    expect(target('https://careers.example.com/jobs/1?gh_jid=1')).toBeNull();
  });

  it('token 与 id 按闭集正则校验：页面文本一个字进不了 URL', () => {
    document.head.innerHTML = '<link rel="preload" href="https://boards-api.greenhouse.io/v1/boards/duo%2F..%2Fadmin/departments">';
    expect(target('https://careers.example.com/jobs/1?gh_jid=1')).toBeNull();
    document.head.innerHTML = '<link rel="preload" href="https://boards-api.greenhouse.io/v1/boards/duolingo/departments">';
    expect(target('https://careers.example.com/jobs/1?gh_jid=12abc')).toBeNull();
  });
});
