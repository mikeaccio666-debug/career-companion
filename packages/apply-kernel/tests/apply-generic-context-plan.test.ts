import { afterEach, describe, expect, it } from 'vitest';

import generic from '@edaix/apply-rules/generic.json';
import type { ApplyFormDescriptor, ApplyPlan } from '../src/contracts';
import { buildApplyPlan, MIN_APPLY_CONFIDENCE, type BuildPlanOptions } from '../src/engine';
import { parseApplyProfileCollections } from '../src/profileCollections';
import type { ApplyProfileDraft } from '../src/profileDraft';
import { compileBundledAdapter } from '../src/rules/interpreter';

/**
 * 通用路的计划期：几栏要看同一节里还有什么才知道问的是什么（2026-09-28 十张公司自建申请页）。
 *
 *  · 光秃秃的「Name」：一节里只有它就是全名；与「Vorname」同节（德文）是姓，与「Apellidos」同节（西文）是名；
 *  · 光秃秃的「Job Title」：与现任公司那一栏同节（D. E. Shaw 的经历段）才是现任职位，单独一栏可能在问申请的岗位；
 *  · 现任公司、现任职位：扁平档案没有时，按工作经历里标着「现在」的那一段；
 *  · 电话区号下拉（Zalando「Country Code」，选项「Germany (+49)」一类）：按号码的区号与居住国挑恰好一项；
 *  · 「I identify as」（Zalando，必填）：题面没说是哪一档，选项全是性别——按性别那一档答。
 *
 * 表单是照那几页的结构手写的骨架，资料全是合成的。
 */

type Options = { readonly locale?: string };

const PROFILE: ApplyProfileDraft = {
  firstName: 'Taylor',
  lastName: 'Example',
  fullName: 'Taylor Example',
  email: 'taylor@example.com',
  phone: '+1 415 555 0142',
  addressCountry: 'US',
  eeoGender: 'FEMALE',
};

function planFor(html: string, profile: ApplyProfileDraft = PROFILE, options: BuildPlanOptions = {}, scan: Options = {}): ApplyPlan {
  document.body.innerHTML = html;
  const adapter = compileBundledAdapter(generic as never);
  const scanOptions = { generic: true, ...(scan.locale === undefined ? {} : { locale: scan.locale }) } as never;
  const root = adapter.resolveRoot(document, scanOptions);
  if (root === null) throw new Error('generic root not found');
  const form: ApplyFormDescriptor = { vendor: 'generic', root, fields: [...adapter.scan(root, scanOptions)], finalSubmitControl: null };
  return buildApplyPlan(form, profile, options);
}

const planned = (plan: ApplyPlan) => Object.fromEntries(plan.entries.map((entry) => [entry.label, [entry.key, entry.value]]));
const skippedReason = (plan: ApplyPlan, label: string) => plan.skipped.find((skip) => skip.label === label)?.reason;

const row = (id: string, label: string, control = `<input id="${id}" type="text">`) =>
  `<div class="field"><label for="${id}">${label}</label>${control}</div>`;
const ANCHORS = `${row('mail', 'Email')}${row('li', 'LinkedIn')}${row('gh', 'GitHub')}`;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('光秃秃的「Name」按同一节里的名、姓改认', () => {
  it('一节里只有它：全名', () => {
    expect(planned(planFor(`<form>${row('n', 'Name')}${ANCHORS}</form>`))['Name']).toEqual(['fullName', 'Taylor Example']);
  });

  it('德文「Vorname」+「Name」：Name 是姓', () => {
    const plan = planFor(`<form>${row('v', 'Vorname')}${row('n', 'Name')}${ANCHORS}</form>`, PROFILE, {}, { locale: 'de' });
    expect(planned(plan)['Vorname']).toEqual(['firstName', 'Taylor']);
    expect(planned(plan)['Name']).toEqual(['lastName', 'Example']);
  });

  it('西文「Nombre」+「Apellidos」：Nombre 是名', () => {
    const plan = planFor(`<form>${row('n', 'Nombre')}${row('a', 'Apellidos')}${ANCHORS}</form>`, PROFILE, {}, { locale: 'es' });
    expect(planned(plan)['Nombre']).toEqual(['firstName', 'Taylor']);
    expect(planned(plan)['Apellidos']).toEqual(['lastName', 'Example']);
  });

  /**
   * 光秃秃的「Name」在别人或某个机构的那一节里是那个人／那个机构的名字（厂商共用那条「Full name」规则的注释早就写过：
   * 公司名、学校名、推荐人姓名上同样叫 Name，认错一个写进去的就是别人的资料）。节标题（fieldset 的 legend、role=group
   * 的可读名、前面最近的标题）说到推荐人、证明人、紧急联系人、学校、雇主这一类时不认。
   */
  it.each([
    ['References', undefined],
    ['Emergency contact', undefined],
    ['Referee 1', undefined],
    ['School', undefined],
    ['Current employer', undefined],
    ['Notfallkontakt', 'de'],
    ['Référence professionnelle', 'fr'],
    ['Contacto de emergencia', 'es'],
  ])('「%s」那一节里的「Name」：不认（不把申请人的名字写成别人的）', (caption, locale) => {
    const plan = planFor(
      `<form>${row('f', 'First name')}${row('l', 'Last name')}${ANCHORS}<fieldset><legend>${caption}</legend>${row('n', 'Name')}${row('p', 'Phone number')}</fieldset></form>`,
      PROFILE, {}, locale === undefined ? {} : { locale },
    );
    expect(planned(plan)['Name']).toBeUndefined();
    expect(planned(plan)['First name']).toEqual(['firstName', 'Taylor']);
  });

  it('节标题只是申请表自己的（Personal information）：照旧是全名', () => {
    const plan = planFor(`<form><fieldset><legend>Personal information</legend>${row('n', 'Name')}${ANCHORS}</fieldset></form>`);
    expect(planned(plan)['Name']).toEqual(['fullName', 'Taylor Example']);
  });

  it('名、姓都在：「Name」不再写（与从前的全名仲裁一致）', () => {
    const plan = planFor(`<form>${row('n', 'Name')}${row('f', 'First name')}${row('l', 'Last name')}${ANCHORS}</form>`);
    expect(planned(plan)['Name']).toBeUndefined();
    expect(skippedReason(plan, 'Name')).toBe('DUPLICATE_FIELD');
  });
});

describe('光秃秃的「Job Title」要有现任公司那一栏作伴', () => {
  const profile = { ...PROFILE, currentCompany: 'Example Corp', currentJobTitle: 'Senior Software Engineer' };

  it('与「Employer Name」同节：现任职位', () => {
    const plan = planFor(`<form>${ANCHORS}<fieldset><legend>Employment</legend>${row('c', 'Employer Name')}${row('t', 'Job Title')}</fieldset></form>`, profile);
    expect(planned(plan)['Job Title']).toEqual(['currentJobTitle', 'Senior Software Engineer']);
  });

  it('单独一栏：不填（可能在问申请的岗位）', () => {
    const plan = planFor(`<form>${row('t', 'Job Title')}${ANCHORS}${row('p', 'Phone')}</form>`, profile);
    expect(planned(plan)['Job Title']).toBeUndefined();
    expect(skippedReason(plan, 'Job Title')).toBe('LOW_CONFIDENCE');
  });

  it('「Current Job Title」照旧直接填', () => {
    expect(planned(planFor(`<form>${row('t', 'Current Job Title')}${ANCHORS}</form>`, profile))['Current Job Title'])
      .toEqual(['currentJobTitle', 'Senior Software Engineer']);
  });
});

/**
 * 已经装在用户那里的内核不看同一节（上面两组是这一版内核才有的改认）。规则由后端下发、不跟插件版本走：同一份
 * generic.json 也会发到旧内核上。旧内核读到「光秃秃的 Name 就是全名」会把全名写进德文「Vorname / Name」、法文
 * 「Prénom / Nom」的姓那一栏、西文「Nombre / Apellidos」的名那一栏（2026-09-28 用 #134 的内核实测）；读到「Job Title
 * 就是现任职位」会把现任职位写进可能在问申请岗位的那一栏。
 *
 * 所以规则把这几种题面放在低于填写门槛的那一步：旧内核认得出（照旧算进认表的门槛）、按 LOW_CONFIDENCE 不填；
 * 这一版内核看过同一节才抬到能填的那一档。说得清楚的写法（「First and last name」「Nom complet」……）照旧直接填。
 */
describe('这份规则发到旧内核上也不写错：要看同一节的题面低于填写门槛', () => {
  function scanned(html: string, locale?: string) {
    document.body.innerHTML = html;
    const adapter = compileBundledAdapter(generic as never);
    const scanOptions = { generic: true, ...(locale === undefined ? {} : { locale }) } as never;
    const root = adapter.resolveRoot(document, scanOptions);
    if (root === null) throw new Error('generic root not found');
    return Object.fromEntries(adapter.scan(root, scanOptions).map((field) => [field.label, field]));
  }

  it.each([
    ['Name', 'en', 'fullName'],
    ['Your name', 'en', 'fullName'],
    ['Ihr Name', 'de', 'fullName'],
    ['Nom', 'fr', 'fullName'],
    ['Votre nom', 'fr', 'fullName'],
    ['Nombre', 'es', 'fullName'],
    ['Job Title', 'en', 'currentJobTitle'],
  ])('「%s」（%s）：认得出，但低于填写门槛', (label, locale, key) => {
    const field = scanned(`<form>${row('x', label)}${ANCHORS}</form>`, locale)[label];
    expect(field?.key).toBe(key);
    expect(field!.confidence).toBeLessThan(MIN_APPLY_CONFIDENCE);
  });

  it.each([
    ['First and last name', 'en', 'fullName'],
    ['Applicant name', 'en', 'fullName'],
    ['Vor- und Nachname', 'de', 'fullName'],
    ['Nom complet', 'fr', 'fullName'],
    ['Nombre completo', 'es', 'fullName'],
    ['Current Job Title', 'en', 'currentJobTitle'],
  ])('「%s」（%s）说得清楚：照旧能填', (label, locale, key) => {
    const field = scanned(`<form>${row('x', label)}${ANCHORS}</form>`, locale)[label];
    expect(field?.key).toBe(key);
    expect(field!.confidence).toBeGreaterThanOrEqual(MIN_APPLY_CONFIDENCE);
  });

  it('这一版内核看过同一节才填：单独的 Name 是全名、与现任公司同节的 Job Title 是现任职位', () => {
    const profile = { ...PROFILE, currentCompany: 'Example Corp', currentJobTitle: 'Senior Software Engineer' };
    const plan = planFor(`<form>${row('n', 'Name')}${ANCHORS}<fieldset><legend>Employment</legend>${row('c', 'Employer Name')}${row('t', 'Job Title')}</fieldset></form>`, profile);
    expect(planned(plan)['Name']).toEqual(['fullName', 'Taylor Example']);
    expect(planned(plan)['Job Title']).toEqual(['currentJobTitle', 'Senior Software Engineer']);
  });
});

describe('现任公司、现任职位：扁平档案没有时按标着「现在」的那一段经历', () => {
  const FORM = `<form>${ANCHORS}${row('c', 'Current company')}${row('t', 'Current job title')}</form>`;

  it('恰好一段是现在的：用它', () => {
    const collections = parseApplyProfileCollections({
      experiences: [
        { company: 'Sample Labs', title: 'Software Engineer', startDate: { year: 2018, month: 7 }, endDate: { year: 2021, month: 2 }, isCurrent: false },
        { company: 'Example Corp', title: 'Senior Software Engineer', startDate: { year: 2021, month: 3 }, isCurrent: true },
      ],
    });
    const plan = planFor(FORM, PROFILE, { collections });
    expect(planned(plan)['Current company']).toEqual(['currentCompany', 'Example Corp']);
    expect(planned(plan)['Current job title']).toEqual(['currentJobTitle', 'Senior Software Engineer']);
  });

  it('没有一段是现在的：不拿以前的公司充当现任', () => {
    const collections = parseApplyProfileCollections({
      experiences: [{ company: 'Sample Labs', title: 'Software Engineer', endDate: { year: 2021, month: 2 }, isCurrent: false }],
    });
    const plan = planFor(FORM, PROFILE, { collections });
    expect(planned(plan)['Current company']).toBeUndefined();
    expect(skippedReason(plan, 'Current company')).toBe('NO_VALUE');
  });

  it('扁平档案里有值：以档案为准', () => {
    const collections = parseApplyProfileCollections({ experiences: [{ company: 'Example Corp', title: 'Engineer', isCurrent: true }] });
    const plan = planFor(FORM, { ...PROFILE, currentCompany: 'Portal Value Inc' }, { collections });
    expect(planned(plan)['Current company']).toEqual(['currentCompany', 'Portal Value Inc']);
  });

  it('用户关掉了现任公司：不从经历里推回来', () => {
    const collections = parseApplyProfileCollections({ experiences: [{ company: 'Example Corp', title: 'Engineer', isCurrent: true }] });
    const plan = planFor(FORM, PROFILE, { collections, suppressedKeys: new Set(['currentCompany']) });
    expect(planned(plan)['Current company']).toBeUndefined();
  });
});

describe('电话区号下拉（Zalando「Country Code」）', () => {
  const codes = (list: readonly string[]) =>
    `<select id="cc" name="phoneCountryCode"><option value=""></option>${list.map((text, index) => `<option value="${index}">${text}</option>`).join('')}</select>`;
  const ZALANDO = (options: readonly string[]) => `<form>
      ${row('f', 'First Name')}${row('l', 'Last Name')}${row('e', 'Email')}
      ${row('cc', 'Country Code', codes(options))}
      ${row('p', 'Phone Number')}
    </form>`;

  it('号码是 +1、住在美国：挑「United States (+1)」，号码栏只写国内号段', () => {
    const plan = planFor(ZALANDO(['Germany (+49)', '---', 'American Samoa (+1)', 'Canada (+1)', 'United States (+1)']));
    expect(planned(plan)['Country Code']).toEqual(['phone', 'United States (+1)']);
    expect(planned(plan)['Phone Number']).toEqual(['phone', '4155550142']);
  });

  it('只有一个国家用这个区号：直接挑它', () => {
    const plan = planFor(ZALANDO(['Germany (+49)', 'France (+33)']), { ...PROFILE, phone: '+49 30 1234567', addressCountry: 'DE' });
    expect(planned(plan)['Country Code']).toEqual(['phone', 'Germany (+49)']);
  });

  it('区号对得上好几项、居住国又对不上其中恰好一项：不挑', () => {
    const plan = planFor(ZALANDO(['American Samoa (+1)', 'Canada (+1)']));
    expect(planned(plan)['Country Code']).toBeUndefined();
  });

  it('号码没写区号：不挑，号码原样', () => {
    const plan = planFor(ZALANDO(['Germany (+49)', 'United States (+1)']), { ...PROFILE, phone: '415 555 0142' });
    expect(planned(plan)['Country Code']).toBeUndefined();
    expect(planned(plan)['Phone Number']).toEqual(['phone', '415 555 0142']);
  });

  it('选项不像区号的「Country Code」（问的是 ISO 国家码）：不当区号控件', () => {
    const plan = planFor(ZALANDO(['US', 'DE']));
    expect(planned(plan)['Country Code']).toBeUndefined();
    expect(planned(plan)['Phone Number']).toEqual(['phone', '+1 415 555 0142']);
  });
});

describe('「I identify as」：选项全是性别就按性别那一档答（Zalando，必填）', () => {
  const FORM = (options: readonly string[]) => `<form>${ANCHORS}${row('p', 'Phone')}
      ${row('g', 'I identify as', `<select id="g"><option value=""></option>${options.map((text) => `<option>${text}</option>`).join('')}</select>`)}
    </form>`;
  const capabilities = { 'set-self-identification': true } as BuildPlanOptions['capabilities'];

  it('Man / Woman / Non-binary / Prefer not to say → 档案里的性别', () => {
    const plan = planFor(FORM(['Man', 'Woman', 'Non-binary', 'Prefer not to say']), PROFILE, { capabilities });
    expect(planned(plan)['I identify as']).toEqual(['eeoGender', 'Woman']);
  });

  it('能力位关着：照旧交还本人', () => {
    const plan = planFor(FORM(['Man', 'Woman', 'Non-binary', 'Prefer not to say']));
    expect(planned(plan)['I identify as']).toBeUndefined();
    expect(skippedReason(plan, 'I identify as')).toBe('MANUAL_ONLY');
  });

  it('选项掺着别的（族裔）：不认成性别题', () => {
    const plan = planFor(FORM(['Asian', 'White', 'Woman']), PROFILE, { capabilities });
    expect(planned(plan)['I identify as']).toBeUndefined();
  });
});

describe('国家下拉按「国家 - 州」列出（Canonical「In which country do you currently work?」）', () => {
  it('档案里有州：挑「United States of America - California」', () => {
    const options = ['Afghanistan', 'United States of America - Alabama', 'United States of America - California', 'United States Minor Outlying Islands'];
    const plan = planFor(`<form>${ANCHORS}${row('c', 'In which country do you currently work?', `<select id="c"><option value="" disabled selected>Select an option</option>${options.map((text, index) => `<option value="${index}">${text}</option>`).join('')}</select>`)}</form>`,
      { ...PROFILE, addressRegion: 'CA' });
    expect(planned(plan)['In which country do you currently work?']).toEqual(['addressCountry', 'United States of America - California']);
  });

  it('档案里没有州：几十项都以这个国名开头，不挑', () => {
    const options = ['United States of America - Alabama', 'United States of America - California'];
    const plan = planFor(`<form>${ANCHORS}${row('c', 'In which country do you currently work?', `<select id="c"><option value="" disabled selected>Select an option</option>${options.map((text, index) => `<option value="${index}">${text}</option>`).join('')}</select>`)}</form>`);
    expect(planned(plan)['In which country do you currently work?']).toBeUndefined();
  });
});

describe('国家下拉写的是页面语言的国名', () => {
  it('德文页的「Land」：住在美国 → 「Vereinigte Staaten」', () => {
    const plan = planFor(`<form>${ANCHORS}${row('land', 'Land', '<select id="land"><option value="">---</option><option>Deutschland</option><option>Vereinigte Staaten</option></select>')}</form>`, PROFILE, {}, { locale: 'de' });
    expect(planned(plan)['Land']).toEqual(['addressCountry', 'Vereinigte Staaten']);
  });
});

describe('学历、工作经历的第一段（只在「学历」「工作经历」那一节里认）', () => {
  const collections = parseApplyProfileCollections({
    educations: [{ school: 'University of California, Berkeley', degreeLevel: 'BACHELOR', fieldOfStudy: 'Computer Science', gpa: '3.8/4.0', gpaScale: '4.0', startDate: { year: 2014, month: 9 }, endDate: { year: 2018, month: 6 } }],
    experiences: [
      { company: 'Example Corp', title: 'Senior Software Engineer', startDate: { year: 2021, month: 3 }, isCurrent: true },
      { company: 'Sample Labs', title: 'Software Engineer', startDate: { year: 2018, month: 7 }, endDate: { year: 2021, month: 2 } },
    ],
  });
  const months = `<option value="">Month</option>${['January', 'February', 'March', 'April'].map((month) => `<option>${month}</option>`).join('')}`;
  const years = `<option value="">Year</option>${[2018, 2019, 2020, 2021, 2022].map((year) => `<option>${year}</option>`).join('')}`;
  /** D. E. Shaw 的两节（2026-09-28）：学历一节是 role=group「Educational Background Record 1」，经历一节在「Employment History」标题下。 */
  const DESHAW = `<form>${ANCHORS}
      <section><h2>Education</h2>
        <div role="group" aria-label="Educational Background Record 1">
          ${row('uni', 'University ?')}
          ${row('fos', 'Field of Study (Max 2) ?')}
          ${row('gpa', 'GPA/Grade (Cumulative) Achieved', '<input id="gpa" type="number" step="any">')}
          ${row('gpat', 'GPA/Grade (Cumulative) Total', '<input id="gpat" type="number" step="any">')}
          ${row('mgpa', 'GPA/Grade (Major) Achieved', '<input id="mgpa" type="number" step="any">')}
        </div>
      </section>
      <section><h2>Employment History</h2>
        <div role="group" aria-label="Employment History 1">
          ${row('emp', 'Employer Name')}${row('title', 'Job Title')}
          ${row('fm', 'Employed From Month', `<select id="fm">${months}</select>`)}
          ${row('fy', 'Employed From Year', `<select id="fy">${years}</select>`)}
        </div>
      </section>
    </form>`;

  it('学校、专业、GPA（数字框只写数字）、经历起始年月都按第一段填', () => {
    const plan = planFor(DESHAW, PROFILE, { collections });
    const values = planned(plan);
    // 标签尾巴上的「?」是提示图标（D. E. Shaw 每一栏都有），不是题面的一部分。
    expect(values['University ?']).toEqual(['education.school', 'University of California, Berkeley']);
    expect(values['Field of Study (Max 2) ?']).toEqual(['education.fieldOfStudy', 'Computer Science']);
    expect(values['GPA/Grade (Cumulative) Achieved']).toEqual(['education.gpa', '3.8']);
    expect(values['GPA/Grade (Cumulative) Total']).toEqual(['education.gpaScale', '4.0']);
    expect(values['GPA/Grade (Major) Achieved']).toBeUndefined();
    expect(values['Employer Name']).toEqual(['currentCompany', 'Example Corp']);
    expect(values['Job Title']).toEqual(['currentJobTitle', 'Senior Software Engineer']);
    expect(values['Employed From Month']?.[0]).toBe('experience.startMonth');
    expect(values['Employed From Year']).toEqual(['experience.startYear', '2021']);
  });

  it('不在学历那一节里的「University」「Major」不认（可能在问别的）', () => {
    const plan = planFor(`<form>${ANCHORS}${row('uni', 'University')}${row('fos', 'Major')}</form>`, PROFILE, { collections });
    expect(planned(plan)['University']).toBeUndefined();
    expect(skippedReason(plan, 'University')).toBe('LOW_CONFIDENCE');
    expect(planned(plan)['Major']).toBeUndefined();
  });

  it('同一节里渲染了两段学历：第二段不拿第一段的值（同节同键只填一个）', () => {
    const plan = planFor(`<form>${ANCHORS}
      <section><h2>Education</h2>
        <div role="group" aria-label="Educational Background Record 1">${row('u1', 'University')}</div>
        <div role="group" aria-label="Educational Background Record 2">${row('u2', 'University')}</div>
      </section></form>`, PROFILE, { collections });
    expect(plan.entries.filter((entry) => entry.key === 'education.school')).toHaveLength(1);
  });
});
