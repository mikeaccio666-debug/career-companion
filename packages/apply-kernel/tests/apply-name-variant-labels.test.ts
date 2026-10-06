/**
 * Legal / Preferred 前缀的姓名变体，以及队友那一栏。
 *
 * 标签逐字取自 352 个真实申请页上的必填字段：那 1304 个落在不透明 `question:*`
 * 的字段里，有 31 个就栽在这几种写法上。
 */

import { afterEach, describe, expect, it } from 'vitest';

import greenhouse from '../../apply-rules/rules/greenhouse.json';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { isOtherPersonField } from '../src/dict/guards';

function keyOf(labelText: string): string | null | undefined {
  document.body.innerHTML = `<form id="application-form">
    <label for="question_1">${labelText}</label>
    <input id="question_1" type="text">
  </form>`;
  const adapter = compileBundledAdapter(greenhouse);
  const root = adapter.resolveRoot(document);
  if (root === null) throw new Error('greenhouse root missing');
  return [...adapter.scan(root)].find((f) => f.label.includes(labelText.slice(0, 12)))?.key ?? null;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('Legal / Preferred 前缀的姓名变体', () => {
  it('Legal First Name → firstName', () => expect(keyOf('Legal First Name')).toBe('firstName'));
  it('Preferred Last Name → lastName', () => expect(keyOf('Preferred Last Name')).toBe('lastName'));
  it('Legal Last Name → lastName', () => expect(keyOf('Legal Last Name')).toBe('lastName'));

  // 既有那条 `preferred (first )?name` → preferredName 不能被新规则顶掉。
  it('Preferred Name 仍然是 preferredName', () => expect(keyOf('Preferred Name')).toBe('preferredName'));
  it('Preferred First Name 仍然是 preferredName', () =>
    expect(keyOf('Preferred First Name')).toBe('preferredName'));
});

describe('队友那一栏不是申请人自己的', () => {
  // 合投／团队申请表上的「Team member 2 …」此前一条守卫都不中，标签匹配会把
  // 申请人自己的姓名与邮箱写进队友那一栏。
  it('Team member 2 的栏位被认定为他人字段', () => {
    expect(isOtherPersonField('Team member 2 first and last name')).toBe(true);
    expect(isOtherPersonField('Team member 2 email address')).toBe(true);
    expect(isOtherPersonField('团队成员邮箱')).toBe(true);
  });

  it('普通姓名栏不受影响', () => {
    expect(isOtherPersonField('Legal First Name')).toBe(false);
    expect(isOtherPersonField('Email')).toBe(false);
  });
});

describe('currentCompany：后端一直在发，现在接得住了', () => {
  // argoland #469 起端点就在发 addressLine1 / addressRegion / currentCompany，
  // 插件停在十一个键，于是每次都发过来、每次都被丢掉。实测语料里这一项命中 39 次。
  const CAPTIONS = [
    'Current Employer', 'Most Recent Employer', 'Company name',
    'Current/Most Recent Company Name', 'Current or Most Recent Employer',
    'Current Company',
  ] as const;

  for (const caption of CAPTIONS) {
    it(`「${caption}」→ currentCompany`, () => expect(keyOf(caption)).toBe('currentCompany'));
  }

  it('整句话里出现 employer 不算：锚定到整条标签', () => {
    expect(keyOf('Are you subject to any employment agreements with your current employer?'))
      .toBeNull();
  });
});

describe('国家与现任职位：第二批下发的键', () => {
  it('Country / Country of Residence / What country are you based in → addressCountry', () => {
    for (const caption of ['Country', 'Country of Residence', 'What country are you based in?']) {
      expect(keyOf(caption)).toBe('addressCountry');
    }
  });

  it('带限定的职位栏 → currentJobTitle', () => {
    for (const caption of ['Current Job Title', 'Current/Most Recent Job Title', 'Current or Most Recent Title']) {
      expect(keyOf(caption)).toBe('currentJobTitle');
    }
  });

  // 光秃秃的 Title 多半是 Mr./Ms. 称谓栏，把职位填进去错得很显眼。
  it('单独一个 Title 不认成职位', () => expect(keyOf('Title')).not.toBe('currentJobTitle'));

  it('句子里出现 country 不认：签证题不是国家栏', () => {
    expect(keyOf('Are you currently legally authorized to work in the country in which this position is located?'))
      .toBeNull();
  });
});

describe('你从哪听说这个职位', () => {
  it('各种问法都认', () => {
    for (const caption of [
      'How did you hear about this job?', 'How did you hear about us?',
      'How did you hear about this opportunity?', 'How did you learn about this position?',
      'How did you hear about Decagon?',
    ]) {
      expect(keyOf(caption)).toBe('heardAboutSource');
    }
  });

  it('不是这个问法的不认', () => {
    expect(keyOf('What did you hear about our culture?')).not.toBe('heardAboutSource');
  });
});
