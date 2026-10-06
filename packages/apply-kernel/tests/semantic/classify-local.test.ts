/**
 * 本地 UA-2 生产者：没有站点规则、没有网络往返，也要答得出「这个控件是什么」。
 *
 * 这里只钉三件在真实页面上会回归的事：与已部署后端一致、后端表达不出来的三个
 * 链接字段、以及蜜罐绝不能被判成可填字段。
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { PilotUa1VisibleControl } from '@edaix/contracts/draft';
import { classifyControlsLocally } from '../../src/semantic/classifyLocal.ts';
import type { Digest } from '../../src/semantic/grouping.ts';

const sha256: Digest = (...parts) => createHash('sha256').update(parts.join(' '), 'utf8').digest('hex');

let seq = 0;
function control(patch: Partial<PilotUa1VisibleControl>): PilotUa1VisibleControl {
  seq += 1;
  return {
    identityDigest: sha256('control', String(seq)),
    role: null,
    inputType: 'text',
    autocomplete: [],
    required: false,
    accessibleName: null,
    label: null,
    legend: null,
    options: [],
    fileAccept: null,
    ...patch,
  };
}

function classifyOne(patch: Partial<PilotUa1VisibleControl>) {
  const one = control(patch);
  return classifyControlsLocally([one], sha256).get(one.identityDigest);
}

describe('本地 UA-2：与已部署后端一致的那部分', () => {
  it('autocomplete 命中即 HIGH，来源记为 AUTOCOMPLETE', () => {
    expect(classifyOne({ autocomplete: ['email'], inputType: 'email' })).toMatchObject({
      kind: 'CANONICAL_FIELD',
      canonicalField: 'EMAIL',
      confidence: 'HIGH',
      reasonCode: 'CANONICAL_AUTOCOMPLETE_MATCH',
    });
  });

  it('只有 label 时退到语义匹配，置信度降为 MEDIUM', () => {
    expect(classifyOne({ label: 'First Name' })).toMatchObject({
      kind: 'CANONICAL_FIELD',
      canonicalField: 'NAME_GIVEN',
      confidence: 'MEDIUM',
      reasonCode: 'CANONICAL_SEMANTIC_MATCH',
    });
  });

  it('密码永远交还给人', () => {
    expect(classifyOne({ inputType: 'password', label: 'Password' })).toMatchObject({
      kind: 'HUMAN_ACTION_REQUIRED',
      canonicalField: null,
      reasonCode: 'HUMAN_PASSWORD_CONTROL',
    });
  });

  it('下拉、日期、文件、长文本各归其类', () => {
    expect(classifyOne({ inputType: 'select-one', label: 'Country' })?.kind).toBe('STRUCTURED_CHOICE');
    expect(classifyOne({ inputType: 'date', label: 'Start date' })?.kind).toBe('STRUCTURED_DATE');
    expect(classifyOne({ inputType: 'file', label: 'Resume' })?.kind).toBe('STRUCTURED_FILE');
    expect(classifyOne({ inputType: 'textarea', label: 'Why us?' })?.kind).toBe('OPEN_QUESTION');
  });
});

describe('本地 UA-2：后端表达不出来的三个链接字段', () => {
  // 档案里 linkedinUrl / githubUrl / portfolioUrl 是三个独立字段，T3 也发布
  // LINKEDIN / GITHUB / PORTFOLIO 三种链接类型；后端 UA-2 把它们全塌成 URL
  // 甚至判不出来，档案供得出的东西就填不进去。
  it('LinkedIn 单独成一个字段，不塌成 URL', () => {
    expect(classifyOne({ label: 'LinkedIn Profile' })).toMatchObject({
      kind: 'CANONICAL_FIELD',
      canonicalField: 'LINKEDIN_URL',
    });
  });

  it('GitHub 单独成一个字段', () => {
    expect(classifyOne({ label: 'GitHub URL' })?.canonicalField).toBe('GITHUB_URL');
  });

  it('作品集优先于笼统的 URL', () => {
    expect(classifyOne({ label: 'Portfolio' })?.canonicalField).toBe('PORTFOLIO_URL');
  });

  it('笼统的网址仍然是 URL', () => {
    expect(classifyOne({ label: 'Website' })?.canonicalField).toBe('URL');
  });

  // 松匹配 /\blinkedin\b/ 会把这句判成领英网址栏，于是用户的领英主页被填进
  // 一个「你从哪听说我们」的来源问题里。只认完整问法才挡得住。
  it('片段里提到 LinkedIn 不算领英网址栏', () => {
    expect(classifyOne({ label: 'How did you hear about us? (LinkedIn, Indeed, referral)' })
      ?.canonicalField).not.toBe('LINKEDIN_URL');
  });

  it('三处 caption 互相矛盾时不猜', () => {
    expect(classifyOne({ label: 'LinkedIn', accessibleName: 'GitHub' })?.canonicalField).toBeNull();
  });

  it('岗位相关的链接问题交还给人', () => {
    expect(classifyOne({ label: 'Portfolio', legend: 'Why do you want this role?' })
      ?.canonicalField).not.toBe('PORTFOLIO_URL');
  });
});

describe('本地 UA-2：蜜罐绝不能成为可填字段', () => {
  // Workday 的 beecatcher：label 里带 "website"，正好命中我们自己的 URL 同义词。
  // 已部署的后端会把它判成 CANONICAL_FIELD/URL，通用填写会把用户真实网址送进去，
  // 整份申请被静默当成 bot 流量丢弃。
  it('Workday beecatcher 判成 UNRESOLVED，而不是 URL', () => {
    const result = classifyOne({
      label: "Enter website. This input is for robots only, do not enter if you're human.",
      inputType: 'text',
    });
    expect(result?.kind).toBe('UNRESOLVED');
    expect(result?.canonicalField).toBeNull();
  });

  it('「请将此栏留空」同样不可填', () => {
    expect(classifyOne({ label: '请将此栏留空' })?.canonicalField).toBeNull();
  });

  it('蜜罐文案压过 autocomplete 的高置信', () => {
    const result = classifyOne({
      autocomplete: ['email'],
      inputType: 'email',
      label: 'Email — leave this field blank',
    });
    expect(result?.canonicalField).toBeNull();
  });
});

describe('本地 UA-2：问句不是字段标签', () => {
  // 以下标签逐字取自 jobs.channable.com（Recruitee）的真实申请页——一个我们没有
  // 任何规则的厂商，而且挂在公司自有域名上。
  it('「our company values」不该把现任公司名写进问答题', () => {
    expect(classifyOne({
      accessibleName: 'Which one of our company values resonates the most with you and why?\u00a0*',
    })?.canonicalField).toBeNull();
  });

  it('同一页上「Where do you live? (City)」照样成立', () => {
    expect(classifyOne({ accessibleName: 'Where do you live? (City)\u00a0*' })?.canonicalField)
      .toBe('CITY');
  });

  it('开放问答一律交还给用户', () => {
    for (const caption of [
      'How did you find out about Channable?\u00a0*',
      'How many hours per week are you available to work?\u00a0*',
    ]) {
      expect(classifyOne({ accessibleName: caption })?.canonicalField).toBeNull();
    }
  });

  it('不是问句的普通标签仍走宽匹配', () => {
    expect(classifyOne({ label: 'Current company' })?.canonicalField).toBe('ORGANIZATION');
  });
});

describe('本地 UA-2：标签是短名词短语，不是一句话', () => {
  // 以下标签逐字取自 352 个真实申请页上 1314 条必填自定义问题——那些规则没映射上、
  // 被当成不透明 question:* 扔掉的字段。阈值就是在这批语料上量出来的。
  it('整句话不命名字段，哪怕里面有关键词', () => {
    for (const caption of [
      'Are you currently legally authorized to work in the country in which this position is located?',
      'Will you now or will you in the future require employment visa sponsorship?',
      'Do you currently, or have you previously, worked at Capital One or a company acquired by Capital One?',
      'Tell us about how you uniquely raise the security bar of an organization.',
      'Please choose the country in which you are located.',
      'Describe the last piece of code, config, or IaC you personally wrote.',
      // 别人的名字：7 个词，也不该被当成姓氏栏。
      'Team member 2 first and last name',
    ]) {
      expect(classifyOne({ accessibleName: caption })?.canonicalField).toBeNull();
    }
  });

  it('短名词短语照常命名', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['Country', 'COUNTRY'],
      ['Company name', 'ORGANIZATION'],
      ['Current or Most Recent Employer', 'ORGANIZATION'],
      ['Current/Most Recent Job Title', 'JOB_TITLE'],
      ['Legal First Name', 'NAME_GIVEN'],
      ['Preferred Last Name', 'NAME_FAMILY'],
    ];
    for (const [caption, field] of cases) {
      expect(classifyOne({ accessibleName: caption })?.canonicalField).toBe(field);
    }
  });
});
