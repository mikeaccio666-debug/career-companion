import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type {
  ExecutionIntentClaims,
  IssueExecutionIntentRequest,
} from '../src/executionIntent';

/**
 * §5.4 里同名不同物的两组字段，锁在契约这一侧。
 *
 * 起因（审查意见 PR #10 [高]，2026-08-16）：`missionStepId` 与 `missionRevision`
 * 在请求与 claims 里同名，但指的是两套对象——
 *
 * | 字段 | `IssueExecutionIntentRequest` | `ExecutionIntentClaims` |
 * |---|---|---|
 * | `missionStepId` | 用户批准的 **approval step** | 签发时新建的 **execution step** |
 * | `missionRevision` | 签发**前**的 R | 签发**后**的 R+1 |
 *
 * 本仓曾经拿这两个 `missionStepId` 做相等核对，于是每一次合法签发都被拒；
 * 2026-08-15 按源契约 e4191043 删掉。删是删了，但**语义只写在扩展实现的
 * 测试里**——只读正式镜像的人（尤其后端仓的人）看到两个同名字段，很容易
 * 重新写出同一个错误核对。
 *
 * 所以这条门禁在契约包里，而不是在扩展里：
 *  1. 类型层面证明两者是**不同的概念**（同名≠同物）；
 *  2. 源码层面要求那四处各自带着解释，注释掉了就红。
 *
 * 注释断言是刻意的：这个坑靠类型防不住（两边都是 `Uuid`），只能靠写清楚。
 * 把说明删掉的那次改动必须有人显式面对。
 */

const SOURCE = readFileSync(resolve(__dirname, '../src/executionIntent.ts'), 'utf8');

/** 取某个接口体内的源码片段，避免跨接口误命中同名字段。 */
function interfaceBody(name: string): string {
  const start = SOURCE.indexOf(`export interface ${name} {`);
  expect(start, `契约里找不到 ${name}`).toBeGreaterThan(-1);
  const end = SOURCE.indexOf('\n}', start);
  return SOURCE.slice(start, end);
}

describe('§5.4 approval step 与 execution step 是两回事', () => {
  it('两个 missionStepId 是不同概念，不许互相赋值当成同一个 step 用', () => {
    // 类型上都是 Uuid，编译器拦不住。这里用「结构上可互换」把事实摆明：
    // 正因为拦不住，语义才必须靠注释 + 下面那条源码断言守住。
    const approvalStep = '00000000-0000-4000-8000-000000000001' as IssueExecutionIntentRequest['missionStepId'];
    const executionStep = '00000000-0000-4000-8000-000000000002' as ExecutionIntentClaims['missionStepId'];
    expect(
      approvalStep,
      'approval step 与 execution step 相等，说明造数据的人也以为它们是同一个',
    ).not.toBe(executionStep);
  });

  it('claims 一侧的 missionStepId 必须写明它是 execution step，且必然不等于请求值', () => {
    const body = interfaceBody('ExecutionIntentClaims');
    expect(body, 'claims 的 missionStepId 没写明是 execution step').toContain('execution step');
    expect(
      /必然不相等/.test(body),
      'claims 的 missionStepId 没写明与请求值必然不等——只读镜像的人会重写那个错误核对',
    ).toBe(true);
    expect(
      body.includes('missionId'),
      'claims 没指出"要核对只能核 missionId"，等于只说了别做什么、没说该做什么',
    ).toBe(true);
  });

  it('请求一侧的 missionStepId 必须写明它是 approval step', () => {
    const body = interfaceBody('IssueExecutionIntentRequest');
    expect(body, '请求的 missionStepId 没写明是 approval step').toContain('approval step');
    expect(
      /必然不相等/.test(body),
      '请求侧没提示与 claims 侧必然不等',
    ).toBe(true);
  });

  it('两侧的 missionRevision 必须各自写明是 R 还是 R+1', () => {
    const claims = interfaceBody('ExecutionIntentClaims');
    const request = interfaceBody('IssueExecutionIntentRequest');
    expect(claims, 'claims 的 missionRevision 没写明是签发后的 R+1').toMatch(/R\s*\*?\*?加一|R\+1/);
    expect(request, '请求的 missionRevision 没写明是签发前的 R').toMatch(/签发前/);
  });
});
