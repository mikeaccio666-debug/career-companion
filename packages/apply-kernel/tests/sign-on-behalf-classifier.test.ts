import { describe, expect, it } from 'vitest';

import {
  isAffirmativeAnswer,
  signOnBehalfAnswer,
  signOnBehalfCheckboxKind,
  signatureFieldKind,
} from '../src/dict/signOnBehalf';

/**
 * 代填条款、声明与签名（2026-09-23；负责人 2026-09-22 夜的决定）：哪些框、哪些栏可以以用户的名义填。
 *
 * 判据是整段文字的正向语法。掺了营销、短信、背景调查、仲裁、授权、核实、联系雇主、以后的职位、
 * 第三方、at-will 的，交还本人；否定句不是同意；点击策略里注定被绝对拒绝的（以 Submit 起头、
 * sign in、verify…）也不排进计划。
 */
describe('勾选框：同意本次申请的条款／隐私政策', () => {
  it.each([
    'By selecting the checkbox, you agree to our Terms and Conditions and Applicant Privacy Policy.',
    'I have read and agree to the Terms of Use and Privacy Policy',
    'I acknowledge that I have read and understand the Applicant Privacy Notice.',
    'I consent to the processing of my personal data for the purpose of evaluating my application.',
    'I agree to the Privacy Policy *',
    'I accept the Terms & Conditions',
  ])('%s → TERMS_CONSENT', (label) => {
    expect(signOnBehalfCheckboxKind(label)).toBe('TERMS_CONSENT');
  });
});

describe('勾选框：保证所填属实', () => {
  it.each([
    'I certify that the information provided in this application is true and complete to the best of my knowledge.',
    'I certify that all information I have provided is true, complete and correct. I understand that any false or misleading information may result in my disqualification or termination.',
    'I confirm that the information I have provided is accurate.',
    'The information I have provided is true and complete.',
    'I hereby declare that the details furnished above are true and correct.',
  ])('%s → TRUTH_ATTESTATION', (label) => {
    expect(signOnBehalfCheckboxKind(label)).toBe('TRUTH_ATTESTATION');
  });
});

describe('勾选框：交还本人', () => {
  it.each([
    ['营销与短信', 'I agree to receive marketing emails and text messages'],
    ['隐私政策里混进短信', 'I agree to the Privacy Policy and consent to receive SMS updates'],
    ['背景调查', 'I authorize Acme to conduct a background check'],
    ['属实声明里混进授权核实', 'I certify that the information is true and authorize verification of all statements'],
    ['仲裁', 'I agree to resolve disputes through binding arbitration'],
    ['以后的职位', 'I consent to Acme retaining my data for future job opportunities'],
    ['人才库', 'Join our talent community and agree to the privacy policy'],
    ['第三方', 'I consent to Acme sharing my information with third parties in accordance with the Privacy Policy'],
    ['at-will', 'I understand and agree that employment with Acme is at-will'],
    ['联系现任雇主', 'I agree that Acme may contact my current employer'],
    ['不是同意', 'Would you like to follow us on LinkedIn?'],
    ['没有政策也没有属实', 'I agree'],
    ['空', ''],
  ])('%s → null', (_why, label) => {
    expect(signOnBehalfCheckboxKind(label)).toBeNull();
  });

  it('太长的整段条款（> 600 字）→ null：那不是一句同意，是一份文件', () => {
    expect(signOnBehalfCheckboxKind(`I agree to the Terms and Conditions. ${'Lorem ipsum dolor sit amet. '.repeat(30)}`)).toBeNull();
  });
});

describe('签名栏', () => {
  it.each([
    'Signature',
    'Electronic Signature *',
    'Applicant Signature',
    "Applicant's Signature",
    'Type your full name as your electronic signature',
    'Please type your full legal name to sign',
  ])('%s → SIGNATURE_NAME', (label) => {
    expect(signatureFieldKind(label)).toBe('SIGNATURE_NAME');
  });

  it.each(['Signature Date', 'Date Signed', "Today's Date", 'Date of Signature', 'Todays Date *'])(
    '%s → SIGNATURE_DATE',
    (label) => {
      expect(signatureFieldKind(label)).toBe('SIGNATURE_DATE');
    },
  );

  it.each(['Name', 'Full Name', 'Date', 'Start Date', 'Date Available', 'Signature authorizing a background check', ''])(
    '%s → null（裸的 Name／Date 不是签名栏）',
    (label) => {
      expect(signatureFieldKind(label)).toBeNull();
    },
  );
});

/**
 * 第二刀（2026-09-23）：以「By submitting / By signing …,」起头的声明。
 * 勾选框结构上提交不了表单；整句判据认得出的，才让点击策略把「submit／signing」只当动作名（开头）来判。
 */
describe('以「By submitting / By signing」起头的声明', () => {
  it.each([
    'By submitting this application, I certify that the information provided is true and complete.',
    'By signing below, I confirm that all information I have provided is accurate.',
  ])('%s → TRUTH_ATTESTATION', (label) => {
    expect(signOnBehalfCheckboxKind(label)).toBe('TRUTH_ATTESTATION');
  });

  it('By submitting 起头的条款同意 → TERMS_CONSENT', () => {
    expect(signOnBehalfCheckboxKind('By submitting this form, you agree to our Terms of Use and Privacy Policy.')).toBe('TERMS_CONSENT');
  });

  it.each([
    'Submit my application and agree to the Terms and Conditions',
    'Sign in to agree to the Privacy Policy',
    'By submitting this application, I authorize a background check',
  ])('动作名起头、或者掺了别的授权 → null：%s', (label) => {
    expect(signOnBehalfCheckboxKind(label)).toBeNull();
  });
});

describe('否定句不是同意', () => {
  it.each([
    'I do not consent to the processing of my personal data for the purpose of evaluating my application.',
    "I don't agree to the Terms and Conditions",
    'I do not accept the Privacy Policy',
    'I have not read the Privacy Notice',
    'I do not certify that the information provided is true and complete.',
  ])('%s → null', (label) => {
    expect(signOnBehalfCheckboxKind(label)).toBeNull();
  });

  it('「true and not misleading」是属实声明的一种说法，不算否定', () => {
    expect(signOnBehalfCheckboxKind('I confirm that the information I have provided is true and not misleading.')).toBe('TRUTH_ATTESTATION');
  });

  it('后果那一句里的 not 不算否定', () => {
    expect(
      signOnBehalfCheckboxKind(
        'I certify that the information provided is true and complete. I understand that false statements may result in my application not being considered.',
      ),
    ).toBe('TRUTH_ATTESTATION');
  });
});

/**
 * 2026-09-23 从本机 ats-lab 批量结果里挑出的 Greenhouse 真实题面（公开职位接口取的全文，公司名换成 Acme）。
 * 这几道都是必填的单选下拉，选项是 Yes/No、Consent、I agree、Acknowledge/Confirm。
 */
describe('真实题面（Greenhouse，2026-09-23）', () => {
  it.each([
    [
      'TRUTH_ATTESTATION',
      'I certify that the information provided in this application is true and correct to the best of my knowledge. I understand that any false statements or omissions may result in disqualification from employment consideration or, if employed, in termination.',
    ],
    ['TERMS_CONSENT', "I understand my application will be processed in accordance with Acme’s Candidate Privacy Policy."],
    [
      'TERMS_CONSENT',
      "Do you consent to Acme processing your personal information for the purpose of assessing your candidacy for this position in accordance with Acme’s Applicant Privacy Policy?",
    ],
    [
      'TERMS_CONSENT',
      'By selecting "I agree," I understand that the information I have provided as part of this job application will be processed in accordance with Acme\'s Candidate Privacy Policy.',
    ],
    [
      'TERMS_CONSENT',
      'By submitting my application, I acknowledge that I have read and understand Acme’s Job Applicant Privacy Notice - https://acme.example/legal/job-applicant-privacy-notice',
    ],
    ['TERMS_CONSENT', 'By clicking the "Acknowledge" button, you acknowledge that Acme processes data in accordance with the Acme Applicant Privacy Policy.'],
    ['TRUTH_ATTESTATION', 'I certify that the facts set forth in this Application for Employment are true and complete to the best of my knowledge.'],
    ['TRUTH_ATTESTATION', 'Do you certify that all information you have provided is true and complete?'],
    ['TRUTH_ATTESTATION', 'Please confirm that the information you have provided is accurate.'],
    // 2026-09-24 改：从前交还本人。负责人的规矩是 Jobright 勾的我们也勾（Twilio 实测它勾了），
    // 处理的只是这份申请里那几道问卷的回答；要分享、转出去的照旧交还（见文件末尾那一组）。
    ['TERMS_CONSENT', 'By checking this box, I consent to Acme collecting, storing, and processing my responses to the demographic data survey above.'],
  ])('%s ← %s', (kind, label) => {
    expect(signOnBehalfCheckboxKind(label)).toBe(kind);
  });

  it.each([
    [
      '混进仲裁',
      'By agreeing here: (1) I certify that the information I provided to Acme in connection with my application for employment is accurate and truthful; and (2) I acknowledge and agree that I have carefully read the mutual Applicant Arbitration Agreement set out below and agree to be bound by it',
    ],
    [
      '混进授权调查与免责',
      'I certify that the facts set forth in this Application for Employment are true and complete to the best of my knowledge. I understand that if I am employed, false statements, omissions or misrepresentations may result in my dismissal. I authorize the Employer to make an investigation of any of the facts set forth in this application and release the Employer from any liability.',
    ],
    ['岗位要求，不是条款', 'This role requires in-office work three days per week (Mon, Wed, Thurs). Do you acknowledge and agree to this requirement?'],
    ['岗位要求，不是条款', 'Do you acknowledge that this is a hybrid role based in San Francisco and you will be required to come into the office?'],
    ['只有标题', 'Applicant Privacy Notice'],
    ['第三方', 'By submitting your application, you consent to Acme and its third-party service providers collecting and processing your personal data.'],
  ])('%s → null', (_why, label) => {
    expect(signOnBehalfCheckboxKind(label)).toBeNull();
  });
});

describe('肯定回答（闭集，逐字）', () => {
  it.each(['Yes', 'I Agree', 'Consent', 'Acknowledge/Confirm', 'Yes, I acknowledge.', 'I certify'])('%s → 是', (option) => {
    expect(isAffirmativeAnswer(option)).toBe(true);
  });

  it.each(['No', 'Yes, I’m currently located here', 'I agree to receive marketing emails', 'Yes, and add me to your talent community', ''])(
    '%s → 不是',
    (option) => {
      expect(isAffirmativeAnswer(option)).toBe(false);
    },
  );
});

describe('选择题该选哪一项', () => {
  const ATTEST = 'I certify that the information provided in this application is true and correct to the best of my knowledge.';
  const PRIVACY = "Do you consent to Acme processing your personal information for the purpose of assessing your candidacy in accordance with Acme's Applicant Privacy Policy?";

  it('题面是属实声明、选项 Yes/No → Yes', () => {
    expect(signOnBehalfAnswer(ATTEST, ['Yes', 'No'])).toEqual({ kind: 'TRUTH_ATTESTATION', index: 0 });
  });

  it.each([[['Consent']], [['I agree']], [['Acknowledge/Confirm']], [['No', 'I agree']]])('题面是隐私同意、选项 %j → 那一项肯定回答', (options) => {
    expect(signOnBehalfAnswer(PRIVACY, options)).toEqual({ kind: 'TERMS_CONSENT', index: options.length - 1 });
  });

  it('题面判不出，选项本身是整句同意（其余是否定回答）→ 那一项', () => {
    const statement = 'I acknowledge that I have read and understood the terms of the Acme Candidate Privacy Notice.';
    expect(signOnBehalfAnswer('Please review the linked document:', [statement])).toEqual({ kind: 'TERMS_CONSENT', index: 0 });
    expect(signOnBehalfAnswer('Terms and Conditions', ['I agree to the Terms and Conditions', 'I do not agree to the Terms and Conditions'])).toEqual({
      kind: 'TERMS_CONSENT',
      index: 0,
    });
  });

  it.each([
    ['两项都是肯定回答', ATTEST, ['Yes', 'Yes, I agree']],
    ['没有逐字的肯定回答', PRIVACY, ['Yes, and add me to your talent community', 'No']],
    ['题面是背景调查', 'Do you agree to a background check?', ['Yes', 'No']],
    ['题面是岗位要求', 'This role requires in-office work three days per week. Do you acknowledge and agree to this requirement?', ['Yes', 'No']],
    ['题面混进营销', 'Do you agree to the Privacy Policy and to receive marketing emails?', ['Yes', 'No']],
    ['题面判不出、另一项不是否定回答', 'Please select one', ['I agree to the Terms and Conditions', 'I am a current employee']],
    ['题面是否定句', 'If you do not agree, select below', ['I agree to the Terms and Conditions']],
  ])('%s → null', (_why, question, options) => {
    expect(signOnBehalfAnswer(question, options)).toBeNull();
  });
});

/**
 * 真实题面（Greenhouse Twilio，2026-09-24）：Jobright 三个都勾了，我们一个也没认出来（隐私那一句认得，
 * 但只是因为说了 Privacy Policy）。三种说法都还在原来两类里——申请者／候选人自己的政策（读过并理解）、
 * 保证交的是本人的作品、同意处理本申请里问卷的回答——掺了背景调查、药检、分享给别人的，照旧交还本人。
 */
describe('真实题面（Greenhouse Twilio，2026-09-24）：候选人政策、本人作品、问卷回答的处理', () => {
  const AI_POLICY =
    'By checking this box, I confirm I have read, reviewed and understood the guidelines outlined in the Candidate AI Responsible Use Policy. I affirm that all the information and materials I submit throughout my application and candidacy will reflect my own work and experience.';
  const SURVEY_PROCESSING =
    'By checking this box, I consent to Twilio collecting, storing, and processing my responses to the demographic data surveys above.';

  it.each([
    [AI_POLICY, 'TERMS_CONSENT'],
    ['By clicking the "Acknowledge" button, you acknowledge that Twilio processes data in accordance with the Twilio Applicant Privacy Policy.', 'TERMS_CONSENT'],
    [SURVEY_PROCESSING, 'TERMS_CONSENT'],
    ['I have read and understood the Applicant AI Use Guidelines.', 'TERMS_CONSENT'],
    ['I affirm that all the information and materials I submit will reflect my own work and experience.', 'TRUTH_ATTESTATION'],
    ['I certify that the answers I give are my own work.', 'TRUTH_ATTESTATION'],
  ])('%s → %s', (label, kind) => {
    expect(signOnBehalfCheckboxKind(label)).toBe(kind);
  });

  it.each([
    ['候选人政策里是背景调查', 'I have read and agree to the Candidate Background Check Policy'],
    ['申请者政策里是药检', 'I acknowledge the Applicant Drug Testing Policy'],
    ['不是申请者的政策', 'I have read and agree to the Remote Work Policy'],
    ['问卷回答要分享出去', 'I consent to Twilio collecting and sharing my responses to the demographic data surveys above with its partners.'],
    ['问卷回答要转给别处', 'I consent to Twilio processing and transferring my responses to the diversity survey to the United States.'],
    ['不同意', 'I do not consent to Twilio processing my responses to the demographic data surveys above.'],
    ['不是这份申请的问卷', 'I consent to Twilio collecting my responses to customer satisfaction surveys.'],
  ])('%s → null', (_why, label) => {
    expect(signOnBehalfCheckboxKind(label)).toBeNull();
  });

  it('题面是候选人 AI 使用政策、唯一选项 Acknowledge → 选它', () => {
    expect(signOnBehalfAnswer(AI_POLICY, ['Acknowledge'])).toEqual({ kind: 'TERMS_CONSENT', index: 0 });
  });
});
