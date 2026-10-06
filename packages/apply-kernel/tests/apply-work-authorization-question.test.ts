/**
 * 标签逐字取自 352 个真实申请页上的必填题。
 *
 * 这一类的失效代价与别的字段不同：答错不是少填一栏，是在正式申请里向雇主做了一个
 * 不实的事实陈述。所以「不答」的用例比「答对」的更重要。
 */

import { describe, expect, it } from 'vitest';

import {
  namedWorkRegion,
  refersToResidence,
  workAuthorizationQuestionKind,
} from '../src/dict/workAuthorization';

/** 用户手上有美国与加拿大两条记录。 */
const REGIONS = ['US', 'CA'] as const;

describe('这是哪一类题', () => {
  it('工作授权', () => {
    for (const text of [
      'Are you legally authorized to work in the United States for our Company?',
      'Are you authorized to work in the United States?',
      'Are you legally entitled to work in Canada?',
      'Do you have permanent work authorization to work in the U.S?',
      'Do you have the unrestricted right to work in the country where this role is located?',
    ]) {
      expect(workAuthorizationQuestionKind(text)).toBe('AUTHORIZED_TO_WORK');
    }
  });

  it('担保', () => {
    for (const text of [
      'Will you now or in the future require immigration sponsorship to work for Instacart?',
      'Do you require visa sponsorship?',
      'Will you now or in the future require an employer to sponsor you for a visa to work in Japan?',
    ]) {
      expect(workAuthorizationQuestionKind(text)).toBe('REQUIRES_SPONSORSHIP');
    }
  });

  it('两类词同时出现时按担保判', () => {
    // 这句同时含 sponsorship 与 work authorization，但它问的是担保。
    expect(workAuthorizationQuestionKind(
      'Will you now or in the future require sponsorship to extend your current work authorization status?',
    )).toBe('REQUIRES_SPONSORSHIP');
  });

  it('不是这两类的不认', () => {
    expect(workAuthorizationQuestionKind('What is your current job title?')).toBeNull();
    expect(workAuthorizationQuestionKind('How did you hear about us?')).toBeNull();
  });
});

/**
 * 2026-09-22 把实验台语料里 161 道工作授权题逐条过了一遍现有判据，抓到三种**判反方向**的：
 * 答出来的不是「少填一栏」，是一句与用户档案正好相反的陈述。
 */
describe('判反方向的三种措辞', () => {
  it('不带 sponsor 字样的担保题：「需要雇主支持才能取得或维持工作授权」是担保，不是「有权工作」', () => {
    // nvidia.wd5 Workday 第 3 步 Application Questions 的原题。含 authorization to work，
    // 从前被判成 AUTHORIZED_TO_WORK——美国岗上会按「有权工作 = Yes」预填，等于替用户说
    // 「我需要雇主担保」。
    for (const text of [
      'Will you require employer support to obtain or maintain authorization to work in the country where this position is located?',
      'Do you need company assistance to obtain a work visa for this role?',
      'Will you now or in the future need immigration support to maintain your right to work in the UK?',
    ]) {
      expect(workAuthorizationQuestionKind(text), text).toBe('REQUIRES_SPONSORSHIP');
    }
  });

  it('「不需要担保就有权工作吗」问的是有权工作，极性与担保题相反', () => {
    // 从前含 sponsorship 就判成担保、按「需要担保 = No」答 No——等于替一个有权工作的人说「我没有权利」。
    for (const text of [
      'Are you legally authorised to work in the country you wish to work in without the need for visa sponsorship?',
      'Are you legally authorized to work in the United States without requiring employer sponsorship?',
      'Are you eligible to work in Canada without sponsorship?',
    ]) {
      expect(workAuthorizationQuestionKind(text), text).toBe('AUTHORIZED_WITHOUT_SPONSORSHIP');
    }
  });

  it('英式拼写 authorised 也是工作授权题', () => {
    for (const text of [
      'Are you legally authorised to work in the United Kingdom?',
      'Are you legally authorised to work full-time in the country where this job is based?',
      // 括号里那句「Fin sponsors immigration」是说明，不是在问担保。
      'Are you authorised to work in the country in which this role is located? (Fin sponsors immigration for some roles so we ask)',
    ]) {
      expect(workAuthorizationQuestionKind(text), text).toBe('AUTHORIZED_TO_WORK');
    }
  });

  it('把两件事用 or 捆在一起的不答：档案里没有「现在是否持签证」这一项', () => {
    // 持 TN、不需要担保的人答 No 就是不实陈述——他确实「currently on a visa」。
    expect(workAuthorizationQuestionKind('Are you currently on a Visa or require sponsorship to live and work in the US?'))
      .toBeNull();
  });
});

describe('题目问的是「你现在住的国家」，不是岗位所在国', () => {
  it('这些说的是住处——不能拿岗位地点去推', () => {
    for (const text of [
      "Are you authorized to work in the country you're currently living in?",
      'Are you legally authorized to work in your country of residence?',
      'Are you legally authorized to work in the country that you are located?',
      'Will you now or in the future require sponsorship for a visa to remain in your current location?',
      'Your authorization to work in the country where you live.',
    ]) {
      expect(refersToResidence(text), text).toBe(true);
    }
  });

  it('这些说的是岗位——照旧可以按岗位地点推', () => {
    for (const text of [
      'Are you currently legally authorized to work in the country in which this job is based?',
      'Are you authorized to work in the country for which you applied?',
      'Are you legally authorized to work in the country where you are applying?',
      'Do you currently have ongoing authorization to work in the location in which you have applied?',
      'Will you require employer support to obtain or maintain authorization to work in the country where this position is located?',
    ]) {
      expect(refersToResidence(text), text).toBe(false);
    }
  });
});

describe('题目点名了哪个国家', () => {
  it('全名', () => {
    expect(namedWorkRegion('Are you authorized to work in the United States?', REGIONS)).toBe('US');
    expect(namedWorkRegion('Are you legally entitled to work in Canada?', REGIONS)).toBe('CA');
  });

  it('大写裸码与带点写法', () => {
    expect(namedWorkRegion('Are you legally work authorized to work in the US?', REGIONS)).toBe('US');
    expect(namedWorkRegion('Do you have permanent work authorization to work in the U.S?', REGIONS)).toBe('US');
    expect(namedWorkRegion('...require visa sponsorship in order to work in the U.S.A.?', REGIONS)).toBe('US');
  });

  it('小写的 us 不算国家', () => {
    // 「How did you hear about us」里的 us 到处都是。
    expect(namedWorkRegion('Are you authorized to work with us?', REGIONS)).toBeNull();
  });

  it('没点名国家的一律不答', () => {
    for (const text of [
      'Are you currently legally authorized to work in the country in which this job is based?',
      'Are you authorized to work in the country for which you applied?',
      'Are you authorized to work in the stated location of this role?',
      'Are you authorized to work lawfully in the country to which you are applying for Mozilla?',
      'Are you legally authorized to work in the location where this role is based?',
      'Will you now or in the future require immigration sponsorship to work for Instacart?',
      'Do you now or will you in the future require immigration sponsorship to work at Cloudflare?',
      'Will you now or in the future require sponsorship for a visa to remain in your current location?',
      'Do you require visa sponsorship?',
    ]) {
      expect(namedWorkRegion(text, REGIONS)).toBeNull();
    }
  });

  it('点到两个国家时不猜', () => {
    // 两条记录可以给出相反的答案，没有依据说该用哪一条。
    expect(namedWorkRegion('Are you authorized to work in the United States or Canada?', REGIONS)).toBeNull();
  });

  /**
   * 美国的州（2026-09-24 协调方跟进：州名、州码一律不许落到同码的国家记录上）。从前 `regionNames('CA')` 把加州与
   * 加拿大放在一起，于是「California」按加拿大那条记录答、「Delaware」按德国、「Indiana」按印度；题面上的裸码 CA、DE、
   * IN 也一样。工作授权是联邦的——有权在美国工作就有权在加州工作——所以州名按美国认；两字母州码与三十来个国家码同形
   * （CA 加拿大、DE 德国、IN 印度、GA 加蓬……），ID、OR、ME 又是常用词，裸码谁都不认；Georgia 既是州又是国家，
   * 说不清就不答。
   */
  describe('美国的州', () => {
    const q = (place: string) => `Are you legally authorized to work in ${place}?`;

    it('California／CA：州名按美国认，从不落到加拿大那条；裸码 CA 谁都不认', () => {
      expect(namedWorkRegion(q('California'), ['US', 'CA'])).toBe('US');
      expect(namedWorkRegion(q('California'), ['CA'])).toBeNull();
      expect(namedWorkRegion(q('CA'), ['US', 'CA'])).toBeNull();
      expect(namedWorkRegion(q('CA'), ['CA'])).toBeNull();
      expect(namedWorkRegion(q('Canada'), ['US', 'CA'])).toBe('CA');
    });

    it('Delaware／DE：不落到德国那条', () => {
      expect(namedWorkRegion(q('Delaware'), ['US', 'DE'])).toBe('US');
      expect(namedWorkRegion(q('Delaware'), ['DE'])).toBeNull();
      expect(namedWorkRegion(q('DE'), ['DE'])).toBeNull();
      expect(namedWorkRegion(q('Germany'), ['US', 'DE'])).toBe('DE');
    });

    it('Indiana／IN：不落到印度那条；India 照旧是印度', () => {
      expect(namedWorkRegion(q('Indiana'), ['US', 'IN'])).toBe('US');
      expect(namedWorkRegion(q('Indiana'), ['IN'])).toBeNull();
      expect(namedWorkRegion(q('IN'), ['IN'])).toBeNull();
      expect(namedWorkRegion(q('India'), ['US', 'IN'])).toBe('IN');
    });

    it('Georgia 既是州又是国家：说不清，谁的记录都不认', () => {
      for (const regions of [['GE'], ['US'], ['US', 'GE']]) {
        expect(namedWorkRegion(q('Georgia'), regions), regions.join()).toBeNull();
      }
    });

    it('州名里带着国名（New Mexico、New Jersey）：是那个州，不是墨西哥、泽西', () => {
      expect(namedWorkRegion(q('New Mexico'), ['US', 'MX'])).toBe('US');
      expect(namedWorkRegion(q('New Mexico'), ['MX'])).toBeNull();
      expect(namedWorkRegion(q('New Jersey'), ['JE'])).toBeNull();
      expect(namedWorkRegion(q('Mexico'), ['US', 'MX'])).toBe('MX');
    });

    it('州与另一国一起点到：两国，不猜', () => {
      expect(namedWorkRegion('Are you authorized to work in California or Canada?', ['US', 'CA'])).toBeNull();
    });
  });

  it('用户没有那个国家的记录就答不了', () => {
    expect(namedWorkRegion(
      'Will you now or in the future require an employer to sponsor you for a visa to work in Japan?',
      REGIONS,
    )).toBeNull();
    expect(namedWorkRegion(
      'Will you now or in the future require an employer to sponsor you for a visa to work in Japan?',
      ['JP'],
    )).toBe('JP');
  });
});
