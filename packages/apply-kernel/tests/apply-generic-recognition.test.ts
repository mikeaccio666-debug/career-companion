import { afterEach, describe, expect, it } from 'vitest';

import generic from '@edaix/apply-rules/generic.json';
import { compileBundledAdapter } from '../src/rules/interpreter';
import type { ApplyFieldDescriptor } from '../src/contracts';
import { isCoverLetterField, isCoverLetterFileField, isNonResumeFileField, isResumeFileField } from '../src/dict/guards';

/**
 * 通用路（公司自建的申请表）认表与认栏，2026-09-28 在十张真实在招申请页上量出来的缺口。
 *
 * 那一轮只认出 5 张：Shopify、Valve 认得的字段不到 4 个（一个光秃秃的「Name」没认、简历上传栏不算数）；
 * Hetzner 是德文（23 栏认得 1 栏）；Gravity Forms 的姓名是「Name」标题下的「First」「Last」两个小标签。
 * 下面每张表都是照那几页的**结构**手写的骨架，题面照原文，没有任何页面上的用户数据。
 */

type Options = { readonly locale?: string };

const adapter = () => compileBundledAdapter(generic as never);

function scanPage(html: string, options: Options = {}): readonly ApplyFieldDescriptor[] | null {
  document.body.innerHTML = html;
  const scanOptions = { generic: true, ...(options.locale === undefined ? {} : { locale: options.locale }) } as never;
  const compiled = adapter();
  const root = compiled.resolveRoot(document, scanOptions);
  return root === null ? null : [...compiled.scan(root, scanOptions)];
}

function keyOf(fields: readonly ApplyFieldDescriptor[] | null, label: string): string | null | undefined {
  const field = fields?.find((candidate) => candidate.label === label);
  return field === undefined ? undefined : field.key;
}

/** 一栏：显式 label + 控件。 */
const row = (id: string, label: string, control = `<input id="${id}" type="text">`) =>
  `<div class="field"><label for="${id}">${label}</label>${control}</div>`;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('认表：认得的字段不到 4 个的两种常见形状', () => {
  /** Shopify 的申请表（2026-09-28）：Ashby 的表挂在公司自己的域名上，姓名只有一栏「Name」。 */
  const SHOPIFY_SHAPE = `
    <form>
      ${row('n', 'Name*', '<input id="n" name="_systemfield_name" type="text" required>')}
      ${row('e', 'Email*', '<input id="e" type="email" required>')}
      ${row('r', 'Resume*', '<input id="r" type="file" name="_systemfield_resume" required>')}
      ${row('l', 'Linkedin Profile*')}
      ${row('t', 'Which track are you interested in pursuing with Shopify?', '<select id="t"><option>Individual Contributor</option><option>People Manager</option></select>')}
    </form>`;

  it('光秃秃的「Name」认成全名，简历上传栏算进门槛：这张表认得出', () => {
    const fields = scanPage(SHOPIFY_SHAPE);
    expect(fields, '认得的只有邮箱与 LinkedIn 两栏时，这张表认不出').not.toBeNull();
    expect(keyOf(fields, 'Name')).toBe('fullName');
  });

  it('简历上传栏单独算一栏：三栏认得 + 一个简历 = 达标', () => {
    const fields = scanPage(`
      <form>
        ${row('e', 'Email')}${row('l', 'LinkedIn')}${row('g', 'GitHub')}
        ${row('r', 'Resume/CV', '<input id="r" type="file">')}
      </form>`);
    expect(fields).not.toBeNull();
  });

  it('求职信上传栏不算简历：三栏认得 + 一个求职信 = 不达标', () => {
    expect(scanPage(`
      <form>
        ${row('e', 'Email')}${row('l', 'LinkedIn')}${row('g', 'GitHub')}
        ${row('c', 'Cover letter', '<input id="c" type="file">')}
      </form>`)).toBeNull();
  });

  /**
   * Valve 的申请表（2026-09-28）：全是可选栏；`<label>` 与控件是兄弟、没有 for（标签靠「只含一个控件的最近祖先」
   * 推断）；下拉的第一项是占位「Please select one」；简历栏只有 `name="resume[]"` 与旁边一句说明。
   */
  const sibling = (label: string, control: string) => `<div class="col_6"><label>${label}</label>${control}</div>`;
  const VALVE_SHAPE = `
    <form data-form-type="job-apply">
      ${sibling('Name', '<input id="applicant_name" name="name" type="text">')}
      ${sibling('Email address', '<input id="applicant_email" name="email" type="text">')}
      ${sibling('How did you discover this opportunity at Valve?', '<select id="applicant_discovery" name="discovery"><option value="" hidden disabled selected>Please select one</option><option value="linkedin">LinkedIn</option></select>')}
      ${sibling('Thanks for letting us know! Which website was it?', '<input id="discovery_otherwebsite" name="discovery_otherwebsite" type="text">')}
      <div class="field"><p>Attach your documents. Please include a resume.</p><input type="file" name="resume[]" multiple></div>
    </form>`;

  it('「How did you discover this opportunity」认成从哪听说；「Which website was it?」不是作品集', () => {
    const fields = scanPage(VALVE_SHAPE);
    expect(fields).not.toBeNull();
    expect(keyOf(fields, 'How did you discover this opportunity at Valve?')).toBe('heardAboutSource');
    expect(keyOf(fields, 'Thanks for letting us know! Which website was it?')).toBeNull();
  });
});

describe('页面自己说「要从下拉里选」的文本框：交还本人，不整串写进去', () => {
  it('Shopify 的 Location（Start typing and select a location from the dropdown.）：认得是所在地，但标成部件托管', () => {
    const fields = scanPage(`
      <form>
        ${row('e', 'Email')}${row('l', 'LinkedIn')}${row('g', 'GitHub')}${row('p', 'Phone')}
        <div><label><span>Location*</span><div class="text-xs">Start typing and select a location from the dropdown.</div>
          <div class="relative"><input placeholder="Ottawa, ON, Canada" type="text" name="_systemfield_location_label">
          <input type="hidden" name="_systemfield_location_location_value" value=""></div></label></div>
      </form>`);
    const location = fields!.find((field) => field.element.getAttribute('name') === '_systemfield_location_label');
    expect(location).toMatchObject({ kind: 'unsupported', unsupportedReason: 'WIDGET', key: 'location' });
  });

  it('普通的所在地文本框照旧是文本框', () => {
    const fields = scanPage(`<form>${row('e', 'Email')}${row('l', 'LinkedIn')}${row('g', 'GitHub')}${row('x', 'Current location')}</form>`);
    expect(fields!.find((field) => field.label === 'Current location')).toMatchObject({ kind: 'text', key: 'location' });
  });
});

describe('「Name」标题下的「First」「Last」小标签（Gravity Forms）', () => {
  const GRAVITY_SHAPE = `
    <form id="gform_39">
      <div class="gfield"><select name="input_3" id="input_39_3"><option value="">Select Position</option><option>Software Engineer</option></select></div>
      <fieldset class="gfield gfield--type-name">
        <legend class="gfield_label">Name<span class="gfield_required">*</span></legend>
        <span class="name_first"><input type="text" name="input_1.3" id="input_39_1_3" aria-required="true"><label for="input_39_1_3">First</label></span>
        <span class="name_last"><input type="text" name="input_1.6" id="input_39_1_6" aria-required="true"><label for="input_39_1_6">Last</label></span>
      </fieldset>
      ${row('input_39_2', 'Email', '<input type="email" name="input_2" id="input_39_2">')}
      ${row('input_39_13', 'Where are you located?')}
      ${row('input_39_14', 'What salary range are you seeking for this role?')}
      ${row('input_39_5', 'Resume or CV', '<input type="file" name="input_5" id="input_39_5">')}
    </form>`;

  it('名、姓各认各的键，标签带上标题', () => {
    const fields = scanPage(GRAVITY_SHAPE);
    expect(fields).not.toBeNull();
    const first = fields!.find((field) => field.element.id === 'input_39_1_3');
    const last = fields!.find((field) => field.element.id === 'input_39_1_6');
    expect(first?.key).toBe('firstName');
    expect(last?.key).toBe('lastName');
  });

  it('「Where are you located?」是所在地；只有占位项的下拉用占位项当标签', () => {
    const fields = scanPage(GRAVITY_SHAPE);
    expect(keyOf(fields, 'Where are you located?')).toBe('location');
    expect(keyOf(fields, 'What salary range are you seeking for this role?')).toBe('expectedSalaryAmount');
    const position = fields!.find((field) => field.element.id === 'input_39_3');
    expect(position?.label).toBe('Select Position');
    expect(position?.key).toBeNull();
  });

  it('标题不是姓名的那一组，小标签照旧不认', () => {
    const fields = scanPage(`
      <form>
        ${row('e', 'Email')}${row('p', 'Phone')}${row('l', 'LinkedIn')}${row('g', 'GitHub')}
        <fieldset><legend>Emergency contact</legend>
          <input id="ec1" type="text"><label for="ec1">First</label>
          <input id="ec2" type="text"><label for="ec2">Last</label>
        </fieldset>
      </form>`);
    expect(fields).not.toBeNull();
    expect(fields!.find((field) => field.element.id === 'ec1')?.key ?? null).toBeNull();
  });
});

describe('德文、法文、西班牙文的常见栏', () => {
  /** Hetzner 的申请表（2026-09-28，德文）：`bewerbung_form`。 */
  const HETZNER_SHAPE = `
    <form name="bewerbung_form">
      ${row('cv', 'CV-Upload', '<input id="cv" type="file" class="upload-field">')}
      ${row('sa', 'Staatsangehörigkeit')}
      ${row('vn', 'Vorname')}
      ${row('nn', 'Nachname')}
      ${row('st', 'Straße')}
      ${row('plz', 'PLZ')}
      ${row('ort', 'Ort')}
      ${row('land', 'Land', '<select id="land"><option value="">---</option><option>Deutschland</option></select>')}
      ${row('geb', 'Geburtsdatum (TT.MM.JJJJ)')}
      ${row('mail', 'E-Mail')}
      ${row('tel', 'Telefon')}
      ${row('mob', 'Mobil')}
      ${row('kf', 'Kündigungsfrist', '<select id="kf"><option value="">---</option><option>4 Wochen zum Monatsende</option></select>')}
      ${row('wie', 'Wie hast du uns gefunden?', '<select id="wie"><option value="">---</option><option>LinkedIn</option></select>')}
      ${row('ll', 'Lebenslauf', '<input id="ll" type="file" name="lebenslauf">')}
      ${row('as', 'Anschreiben', '<input id="as" type="file" name="anschreiben">')}
    </form>`;

  it('德文页（lang=de）：姓名、地址、联系方式、从哪听说都认得', () => {
    const fields = scanPage(HETZNER_SHAPE, { locale: 'de' });
    expect(fields, '德文页 23 栏只认得 1 栏时这张表认不出').not.toBeNull();
    expect(Object.fromEntries(fields!.filter((field) => field.key !== null).map((field) => [field.label, field.key]))).toEqual({
      Vorname: 'firstName',
      Nachname: 'lastName',
      Straße: 'addressLine1',
      PLZ: 'addressPostalCode',
      Ort: 'city',
      Land: 'addressCountry',
      'E-Mail': 'email',
      Telefon: 'phone',
      Mobil: 'phone',
      'Wie hast du uns gefunden?': 'heardAboutSource',
    });
  });

  it('德文规则只在德文页上说话：英文页上「Vorname」不认', () => {
    const fields = scanPage(`<form>${row('e', 'Email')}${row('p', 'Phone')}${row('l', 'LinkedIn')}${row('g', 'GitHub')}${row('v', 'Vorname')}</form>`, { locale: 'en' });
    expect(keyOf(fields, 'Vorname')).toBeNull();
  });

  it('法文页：Prénom / Nom / Adresse e-mail / Téléphone / Code postal / Ville / Pays', () => {
    const fields = scanPage(`
      <form>${row('a', 'Prénom')}${row('b', 'Nom')}${row('c', 'Adresse e-mail')}${row('d', 'Téléphone')}
        ${row('e', 'Code postal')}${row('f', 'Ville')}${row('g', 'Pays')}</form>`, { locale: 'fr' });
    expect(fields).not.toBeNull();
    expect(fields!.map((field) => field.key)).toEqual([
      'firstName', 'fullName', 'email', 'phone', 'addressPostalCode', 'city', 'addressCountry',
    ]);
  });

  it('西班牙文页：Nombre / Apellidos / Correo electrónico / Teléfono / Ciudad / País', () => {
    const fields = scanPage(`
      <form>${row('a', 'Nombre')}${row('b', 'Apellidos')}${row('c', 'Correo electrónico')}${row('d', 'Teléfono')}
        ${row('e', 'Ciudad')}${row('f', 'País')}</form>`, { locale: 'es' });
    expect(fields).not.toBeNull();
    expect(fields!.map((field) => field.key)).toEqual(['fullName', 'lastName', 'email', 'phone', 'city', 'addressCountry']);
  });
});

describe('常见题面：认得出，也不认错', () => {
  const BASE = `${row('e', 'Email')}${row('p', 'Phone')}${row('l', 'LinkedIn')}${row('g', 'GitHub')}`;
  const keyFor = (label: string, control?: string) => keyOf(scanPage(`<form>${BASE}${row('x', label, control)}</form>`), label);

  it.each([
    ['Email confirmation', 'email'],
    ['Confirm email address', 'email'],
    ['Where are you located?', 'location'],
    ['Where are you based?', 'location'],
    ['Current location', 'location'],
    ['Location Start typing and select a location from the dropdown.', 'location'],
    ['In which country do you currently work?', 'addressCountry'],
    ['Which country do you live in?', 'addressCountry'],
    ['Job Title', 'currentJobTitle'],
    ['Current Job Title', 'currentJobTitle'],
    ['Please enter your earliest possible starting date.', 'earliestStartDate'],
    ['Earliest start date', 'earliestStartDate'],
    ['Please tell us your salary expectations (annual gross salary, number format without special characters)', 'expectedSalaryAmount'],
    ['Portfolio/Personal website', 'portfolioUrl'],
    ['Website', 'portfolioUrl'],
    ['First and last name', 'fullName'],
  ])('%s → %s', (label, key) => {
    expect(keyFor(label)).toBe(key);
  });

  it.each([
    'Do you require sponsorship to work in your desired location?',
    "Will you require the firm's sponsorship to obtain, maintain, or extend your employment authorization in the location for which you are applying?",
    'Location preference',
    'Thanks for letting us know! Which website was it?',
    'Company website',
    'Start Date',
    'Minimum base salary expected',
    'Please indicate your nationality',
    'Name of award/accomplishment',
    'Middle Name/Initial',
  ])('%s → 不认', (label) => {
    expect(keyFor(label) ?? null).toBeNull();
  });
});

describe('上传栏与求职信的外语写法（dict/guards.ts）', () => {
  it.each(['Lebenslauf', 'CV-Upload', 'Lebenslauf hochladen', 'Currículum', 'Curriculum', 'Hoja de vida', 'CV'])('%s 是简历', (label) => {
    expect(isResumeFileField(label)).toBe(true);
    expect(isNonResumeFileField(label)).toBe(false);
  });

  it.each(['Anschreiben', 'Motivationsschreiben', 'Lettre de motivation', 'Carta de presentación'])('%s 是求职信、不是简历', (label) => {
    expect(isCoverLetterFileField(label)).toBe(true);
    expect(isCoverLetterField(label)).toBe(true);
    expect(isNonResumeFileField(label)).toBe(true);
  });

  it.each(['letztes Schulzeugnis', 'Praktikazeugnisse', 'Foto', 'Relevé de notes', 'Certificado de estudios'])('%s 不是简历', (label) => {
    expect(isNonResumeFileField(label)).toBe(true);
    expect(isCoverLetterFileField(label)).toBe(false);
  });

  it('「Lebenslauf und Zeugnisse」一栏两样：不当简历（挂错比不挂糟）', () => {
    expect(isNonResumeFileField('Lebenslauf und Zeugnisse')).toBe(true);
  });
});
