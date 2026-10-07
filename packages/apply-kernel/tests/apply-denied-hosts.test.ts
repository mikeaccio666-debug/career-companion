import { describe, expect, it } from 'vitest';

import { createBundledApplyPolicy, isHostDenied, LOCAL_AUTOMATION_DENIED_HOST_SUFFIXES, tighten } from '../src/policy';

/**
 * 主机名粒度的止血通道。
 *
 * **为什么它必须先于全网注入落地**：在它之前，远程策略只能做两件事——整体 kill，
 * 或按四家 vendor 之一 kill。一旦线上出现误注入（评审列出的候选：租房申请、
 * 贷款预审、病历 intake、研究生院申请、伦理举报热线、各国社保门户），唯一的止血
 * 手段是**关掉整个 autofill**。装灭火器要在点火之前。
 *
 * 这个文件锁死三件事，每一件都对应一种会让通道失效的写法：
 *   1. 新字段**不能**让线上已缓存的旧策略 blob 解析失败（`exactBooleanRecord` 的教训）
 *   2. 合并必须是**并集**——远程只能增加否决，不能取消
 *   3. 匹配按**标签边界**，`nav.no` 不得命中 `notnav.no`
 */

function remoteBlob(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 'remote-v1',
    minExtensionVersion: '0.0.0',
    enabled: true,
    vendors: { greenhouse: true, lever: true, ashby: true, workable: true },
    capabilities: { 'set-text': true, 'set-select': true, 'set-combobox': true },
    minConfidence: 0.7,
    inferredRequiresConfirm: true,
    notAfter: Date.now() + 86_400_000,
    ...extra,
  };
}

describe('主机否决表', () => {
  it('包内保留 LinkedIn/Indeed 自动操作限制，远程仍能增加止血后缀', () => {
    expect(createBundledApplyPolicy().deniedHostSuffixes).toEqual(['linkedin.com', 'indeed.com']);
    expect(Object.isFrozen(LOCAL_AUTOMATION_DENIED_HOST_SUFFIXES)).toBe(true);
  });

  /**
   * 最要紧的一条。往策略里加**必填**字段会让所有已在线上的旧 blob 解析失败 →
   * fail-closed → 四家 vendor 一起黑掉，而且完全静默。这正是
   * `exactBooleanRecord(policy.vendors, APPLY_VENDORS)` 的形状。
   */
  it('旧 blob（没有这个字段）仍然解析成功，且四家不受影响', () => {
    const merged = tighten(createBundledApplyPolicy(), remoteBlob());
    expect(merged.source, '旧 blob 被拒了 —— 这次发版会静默关掉所有人的 autofill').toBe(
      'remote',
    );
    expect(merged.enabled).toBe(true);
    expect(merged.vendors.greenhouse).toBe(true);
    expect(merged.deniedHostSuffixes).toEqual(LOCAL_AUTOMATION_DENIED_HOST_SUFFIXES);
  });

  it('远程下发的否决表会生效', () => {
    const merged = tighten(
      createBundledApplyPolicy(),
      remoteBlob({ deniedHostSuffixes: ['nav.no', 'ethicspoint.com'] }),
    );
    expect(merged.deniedHostSuffixes).toEqual([...LOCAL_AUTOMATION_DENIED_HOST_SUFFIXES, 'nav.no', 'ethicspoint.com']);
    expect(isHostDenied(merged, 'www.nav.no')).toBe(true);
    expect(isHostDenied(merged, 'secure.ethicspoint.com')).toBe(true);
    expect(isHostDenied(merged, 'jobs.lever.co')).toBe(false);
  });

  /**
   * 合并是并集：远程只能**增加**否决。任何"远程可以取消一条否决"的写法都会让
   * 止血通道反过来变成开洞通道，也会破坏 tighten 名字承诺的单调性。
   */
  it('合并是并集，远程取消不掉包内已有的否决', () => {
    const bundled = { ...createBundledApplyPolicy(), deniedHostSuffixes: ['bad.example'] };
    const merged = tighten(bundled, remoteBlob({ deniedHostSuffixes: ['worse.example'] }));
    expect(new Set(merged.deniedHostSuffixes)).toEqual(new Set([...LOCAL_AUTOMATION_DENIED_HOST_SUFFIXES, 'bad.example', 'worse.example']));

    // 远程给空表也不能把已有的否决抹掉。
    const emptied = tighten(bundled, remoteBlob({ deniedHostSuffixes: [] }));
    expect(emptied.deniedHostSuffixes, '远程用空表取消了包内的否决').toContain('bad.example');
  });

  it('按标签边界匹配，不是纯字符串后缀', () => {
    const policy = { ...createBundledApplyPolicy(), deniedHostSuffixes: ['nav.no'] };
    expect(isHostDenied(policy, 'nav.no')).toBe(true);
    expect(isHostDenied(policy, 'www.nav.no')).toBe(true);
    expect(isHostDenied(policy, 'a.b.nav.no')).toBe(true);
    expect(
      isHostDenied(policy, 'notnav.no'),
      '纯 endsWith 会让一条否决扩散到无关域名 —— 误伤范围必须可预测',
    ).toBe(false);
    expect(isHostDenied(policy, 'nav.no.evil.com')).toBe(false);
  });

  it('大小写与尾点不影响判定', () => {
    const policy = { ...createBundledApplyPolicy(), deniedHostSuffixes: ['NAV.NO'] };
    expect(isHostDenied(policy, 'WWW.Nav.No.')).toBe(true);
  });

  /** 形状不合法按"没提供"处理，不整包拒绝——手滑的运维配置不该关掉所有人。 */
  it.each([
    ['不是数组', 'nav.no'],
    ['是对象', { 'nav.no': true }],
    ['是 null', null],
  ])('deniedHostSuffixes %s 时按空表处理，其余策略照常生效', (_name, bad) => {
    const merged = tighten(createBundledApplyPolicy(), remoteBlob({ deniedHostSuffixes: bad }));
    expect(merged.source, '一个形状错误的否决表把整份策略拒了').toBe('remote');
    expect(merged.deniedHostSuffixes).toEqual(LOCAL_AUTOMATION_DENIED_HOST_SUFFIXES);
  });

  /**
   * 单标签后缀会一次性否掉半个互联网。这条不是洁癖：否决表是运维在事故中手写的，
   * 一个漏打的域名前缀就是一次全量停服。
   */
  it('拒绝单标签后缀与非法字符，保留合法项', () => {
    const merged = tighten(
      createBundledApplyPolicy(),
      remoteBlob({
        deniedHostSuffixes: ['com', 'org', '', '  ', 'a b.com', 'https://x.com', 'ok.example'],
      }),
    );
    expect(merged.deniedHostSuffixes, '单标签或非法项被放行了').toEqual([...LOCAL_AUTOMATION_DENIED_HOST_SUFFIXES, 'ok.example']);
  });

  it('条目数有上限', () => {
    const many = Array.from({ length: 900 }, (_, i) => `h${i}.example`);
    const merged = tighten(createBundledApplyPolicy(), remoteBlob({ deniedHostSuffixes: many }));
    expect(merged.deniedHostSuffixes.length).toBe(512 + LOCAL_AUTOMATION_DENIED_HOST_SUFFIXES.length);
    expect(merged.deniedHostSuffixes).toContain('h511.example');
    expect(merged.deniedHostSuffixes).not.toContain('h512.example');
  });

  /** 反向探针：空表时不能什么都否决，否则以上断言全是空转。 */
  it('本地限制不会把普通 ATS 或无关主机全部否决', () => {
    const policy = createBundledApplyPolicy();
    for (const host of ['jobs.lever.co', 'nav.no', 'example.com', '']) {
      expect(isHostDenied(policy, host), `本地限制误拒了 ${host}`).toBe(false);
    }
  });

  it.each(['linkedin.com', 'www.linkedin.com', 'www.indeed.com', 'apply.indeed.com', 'smartapply.indeed.com'])('远程空表或手工空投影不能解除 %s 的本地操作限制', (hostname) => {
    const merged = tighten(createBundledApplyPolicy(), remoteBlob({ deniedHostSuffixes: [] }));
    expect(isHostDenied(merged, hostname)).toBe(true);
    expect(isHostDenied({ deniedHostSuffixes: [] }, hostname)).toBe(true);
  });

  it.each(['notlinkedin.com', 'linkedin.com.example.test', 'notindeed.com', 'indeed.com.example.test'])('本地后缀同样按标签边界，不误拒 %s', (hostname) => {
    expect(isHostDenied({ deniedHostSuffixes: [] }, hostname)).toBe(false);
  });
});
