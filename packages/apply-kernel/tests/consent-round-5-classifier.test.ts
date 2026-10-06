import { describe, expect, it } from 'vitest';

import {
  ALL_SIGN_ON_BEHALF_KINDS,
  consentOnBehalfKind,
  employerContactAnswer,
  employerContactCheckboxKind,
  employerContactKinds,
  employerContactSubject,
  isConsentKind,
  isEmployerContactKind,
  isSignOnBehalfChoiceKind,
  privacyNoticeTitle,
  SIGNING_CONSENT_KINDS,
  signOnBehalfAnswerFor,
  signOnBehalfAnswers,
  signOnBehalfAsks,
  signOnBehalfCheckboxKind,
  signOnBehalfChoiceAnswer,
  signOnBehalfChoiceKind,
  signOnBehalfStates,
  widenedConsentKind,
  widenedTopicTitle,
  type SignOnBehalfKind,
  type WidenedConsentKind,
} from '../src/dict/signOnBehalf';
import { SIGN_ON_BEHALF_ENTRY_KEY } from '../src/engine';

/**
 * 代填第五刀（2026-09-28；负责人当天的决定）：再放宽一轮。
 *
 * 新放行的类别只由 2026-09-28 那一版文案覆盖：前三刀的判据一字不动（它们认不出的，才轮到第五刀），
 * 所以 2026-09-24 那一版的同意覆盖的范围逐字不变。仍交还本人：出售资料或为营销分享、生物特征、
 * 与仲裁协议无关的免责／不追责／赔偿、竞业／不招揽／保密协议、医疗健康与残障信息；否定句不是同意。
 * 能不能联系现在的雇主改成资料里的一问：答了就照答，没答交还本人；以前的雇主与推荐人只在题目
 * 只问他们时照同一个回答答。
 *
 * 题面全是合成的（公司名一律 Acme），不含任何真实 posting 的原文与个人信息。
 */

const WIDENED: readonly (readonly [WidenedConsentKind, string])[] = [
  // 招聘用途的资料处理与分享（服务商、招聘系统、关联或集团公司）
  ['RECRUITING_DATA_SHARING', 'I consent to Acme sharing my application data with its recruiting service providers for recruiting purposes.'],
  ['RECRUITING_DATA_SHARING', "I agree that my personal information may be processed by Acme's applicant tracking system provider to manage my application."],
  ['RECRUITING_DATA_SHARING', "I consent to the transfer of my application data to Acme's affiliates outside my country for recruitment purposes."],
  ['RECRUITING_DATA_SHARING', 'Do you consent to Acme and its group companies processing your application for hiring purposes?'],
  ['RECRUITING_DATA_SHARING', 'I consent to Acme sharing my information with third-party vendors that help it manage the hiring process.'],
  // 核实所填信息（学历、工作经历、身份、E-Verify）
  ['INFORMATION_VERIFICATION', 'I authorize Acme to verify my education and employment history.'],
  ['INFORMATION_VERIFICATION', 'I authorize Acme to verify the information I have provided in this application, including contacting my former employers and schools.'],
  ['INFORMATION_VERIFICATION', 'Acme participates in E-Verify. I acknowledge that I have read the E-Verify notice.'],
  ['INFORMATION_VERIFICATION', 'Do you authorize Acme to verify your identity?'],
  ['INFORMATION_VERIFICATION', 'I authorize the release of my academic records to Acme for verification of my degree.'],
  // 背景调查的其余几种（这一次录用）：信用、药检、驾驶记录、社交媒体、定期复查
  ['SCREENING_CONSENT', 'I authorize Acme to obtain a credit report as part of my application.'],
  ['SCREENING_CONSENT', 'I agree to submit to a pre-employment drug test.'],
  ['SCREENING_CONSENT', 'I authorize Acme to review my motor vehicle record.'],
  ['SCREENING_CONSENT', 'I consent to a social media screening as part of the hiring process.'],
  ['SCREENING_CONSENT', 'I authorize a background check, including a credit check.'],
  ['SCREENING_CONSENT', 'I authorize Acme to conduct background checks at any time during my employment.'],
  ['SCREENING_CONSENT', 'Do you consent to a background check and drug screening?'],
  ['SCREENING_CONSENT', 'I authorize Acme to obtain consumer reports about me for employment purposes.'],
  // at-will 的确认
  ['AT_WILL_ACKNOWLEDGEMENT', 'I understand and agree that employment with Acme is at-will.'],
  [
    'AT_WILL_ACKNOWLEDGEMENT',
    'I acknowledge that if hired, my employment will be at will and may be terminated by either party at any time, with or without cause.',
  ],
  ['AT_WILL_ACKNOWLEDGEMENT', 'I understand that my employment will be at-will and that this application is not a contract of employment.'],
  // 仲裁协议里的集体诉讼与陪审团弃权
  ['ARBITRATION_WAIVER', 'I agree to the Arbitration Agreement, including its class and collective action waiver.'],
  [
    'ARBITRATION_WAIVER',
    'I have read and agree to the Mutual Arbitration Agreement. I understand that I am giving up my right to participate in a class action.',
  ],
  // AI 分析或评估面试录音
  ['AI_INTERVIEW_ANALYSIS', 'I consent to Acme recording my interview and using AI to evaluate my answers.'],
  ['AI_INTERVIEW_ANALYSIS', 'Do you consent to AI analysis of your recorded video interview?'],
  // 与申请相关的电话与 WhatsApp 通知
  ['CALL_NOTIFICATION_CONSENT', 'I agree to receive text messages and phone calls about my application.'],
  ['CALL_NOTIFICATION_CONSENT', 'I agree to receive WhatsApp messages from Acme about my application.'],
  ['CALL_NOTIFICATION_CONSENT', 'May we call you about interview scheduling?'],
  // 集团公司日后联系
  ['GROUP_FUTURE_CONTACT', 'I agree that Acme and its affiliates may contact me about future job opportunities.'],
  ['GROUP_FUTURE_CONTACT', 'I would like to be considered for other roles within the Acme group of companies.'],
  // 只由放行类别组成的混合（从前一律交还本人）
  ['COMBINED_CONSENT', 'I agree to receive marketing emails and text messages'],
  ['COMBINED_CONSENT', 'I agree to the Privacy Policy and consent to receive SMS updates'],
  ['COMBINED_CONSENT', 'I consent to a background check and agree to binding arbitration.'],
  ['COMBINED_CONSENT', 'I certify that the information I provided is true and agree to the Arbitration Agreement.'],
  ['COMBINED_CONSENT', 'Can we text you about future opportunities?'],
  ['COMBINED_CONSENT', 'I consent to the recording of my interviews and to a background check.'],
  ['COMBINED_CONSENT', 'I certify that the information is true and authorize verification of all statements'],
  ['COMBINED_CONSENT', 'Join our talent community and agree to the privacy policy'],
  ['COMBINED_CONSENT', 'I consent to a background check conducted by a third-party provider.'],
];

describe('新放行的类别，各认得出来', () => {
  it.each(WIDENED)('%s ← %s', (kind, label) => {
    expect(widenedConsentKind(label)).toBe(kind);
    expect(signOnBehalfChoiceKind(label)).toBe(kind);
  });

  it('每一个新类别都至少有一句（只剩「只有标题的隐私声明」走它自己的判据）', () => {
    const covered = new Set<string>(WIDENED.map(([kind]) => kind));
    const thirdCut = new Set<string>(['AI_RECORDING_CONSENT', 'SMS_CONSENT', 'FUTURE_CONTACT_CONSENT', 'MARKETING_CONSENT', 'BACKGROUND_CHECK_CONSENT', 'ARBITRATION_AGREEMENT']);
    const widened = ALL_SIGN_ON_BEHALF_KINDS.filter((kind) => isConsentKind(kind) && !thirdCut.has(kind));
    expect(widened.filter((kind) => !covered.has(kind))).toEqual(['PRIVACY_NOTICE_TITLE']);
  });
});

describe('前三刀的判据一字不动：新类别的每一句，旧判据都认不出（09-24 的同意覆盖不到它们）', () => {
  it.each(WIDENED)('%s：%s', (_kind, label) => {
    expect(signOnBehalfCheckboxKind(label)).toBeNull();
    expect(consentOnBehalfKind(label)).toBeNull();
  });

  it('旧类别照旧由旧判据认，不落到第五刀', () => {
    for (const [kind, label] of [
      ['TERMS_CONSENT', 'I have read and agree to the Terms of Use and Privacy Policy'],
      ['TRUTH_ATTESTATION', 'I certify that the information provided in this application is true and complete.'],
      ['BACKGROUND_CHECK_CONSENT', 'I authorize Acme to conduct a background check'],
      ['ARBITRATION_AGREEMENT', 'I acknowledge and agree to the Arbitration Agreement, including the waiver of my right to a jury trial.'],
      ['SMS_CONSENT', 'I agree to receive text messages from Acme about my application.'],
    ] as const) {
      expect(signOnBehalfChoiceKind(label)).toBe(kind);
      expect(widenedConsentKind(label)).toBeNull();
    }
  });
});

describe('仍交还本人（负责人 2026-09-28 列明的几类，以及没有列明的授权）', () => {
  it.each([
    ['出售资料', 'I consent to Acme selling my personal information.'],
    ['出售资料', 'I agree that Acme may sell my data to its recruiting partners.'],
    ['为营销分享', 'I consent to Acme sharing my information with its partners for marketing purposes.'],
    ['为营销分享', 'I agree to receive marketing emails from Acme and its partners.'],
    ['为营销分享', 'I consent to Acme sharing my data with third parties for advertising.'],
    ['生物特征', 'I consent to the collection of my fingerprints for a background check.'],
    ['生物特征', 'I consent to Acme using facial recognition during video interviews.'],
    ['生物特征', 'I consent to the use of my voiceprint during my interview recording.'],
    ['生物特征', 'I consent to the collection of biometric data during my interview recording.'],
    ['一般免责', 'I authorize a background check and release Acme from any liability.'],
    ['不追责', 'I agree to hold Acme harmless from any claims arising from the background check.'],
    ['赔偿', 'I agree to indemnify Acme against any losses arising from my application.'],
    ['一般免责', 'I agree to the Arbitration Agreement and grant Acme a general release of all claims.'],
    ['竞业', 'I agree to the Arbitration Agreement and to the non-compete terms.'],
    ['不招揽', 'I agree to the non-solicitation agreement.'],
    ['保密协议', 'I agree to sign a confidentiality agreement if hired.'],
    ['保密协议', 'I agree to the NDA.'],
    ['医疗', 'I consent to a medical examination before starting employment.'],
    ['健康', 'I consent to Acme processing my health information for my application.'],
    ['残障', 'I consent to Acme using my disability information to evaluate my application.'],
    ['调查式消费者报告（走访他人，没有列明）', 'I authorize Acme to obtain investigative consumer reports about me.'],
    ['联系现任雇主掺在同意里', 'I authorize Acme to verify my employment history, including contacting my current employer.'],
    ['推荐人掺在同意里', 'I authorize Acme to contact the references I listed as part of a background check.'],
    ['同事', 'I authorize Acme to verify my employment by contacting my former colleagues.'],
    ['客户', 'I consent to Acme sharing my profile with its clients for other opportunities.'],
    ['弃权不在仲裁协议里', 'I agree to waive my right to a jury trial.'],
    ['营销电话', 'I agree to receive marketing calls from Acme.'],
    ['AI 训练模型', 'I consent to Acme using my interview recordings to train its AI models.'],
    ['AI 分析情绪', 'I consent to AI analysis of my emotions during video interviews.'],
    ['AI 自动决定', 'I consent to Acme using AI to make hiring decisions based on my interview.'],
    ['AI 评估申请（不是面试）', 'I consent to Acme using AI to evaluate my application.'],
    ['集团以外的公司', 'I agree that other companies may contact me about future opportunities.'],
    ['没说招聘用途的第三方分享', 'I consent to Acme sharing my information with third parties.'],
    ['验证码', 'We may text you a verification code. Do you consent?'],
    ['验证码', 'I agree to verify my email address with a one-time code.'],
    ['社交媒体政策', 'Do you agree to our social media policy?'],
    ['事实问题，不是同意', 'Can you pass a credit check?'],
    ['事实问题，不是同意', 'Do you have a valid driving record?'],
    ['知悉不是同意', 'Do you know that we verify employment history?'],
    ['以动作名起头', 'Submit to a drug test'],
    ['空', ''],
  ])('%s → null：%s', (_why, label) => {
    expect(widenedConsentKind(label)).toBeNull();
    expect(signOnBehalfChoiceKind(label)).toBeNull();
  });

  it('太长（> 600 字）→ null', () => {
    expect(widenedConsentKind(`I authorize a credit check. ${'The report covers my credit history. '.repeat(20)}`)).toBeNull();
  });
});

describe('前三刀漏过的几种说法，第五刀起一并拦住（这几类在哪一版的同意里都不代填）', () => {
  it.each([
    ['不追责（中间夹着公司名）', 'I authorize Acme to conduct a background check and agree to hold Acme harmless.'],
    ['出售（sale of）', 'I have read and agree to the Privacy Policy, including the sale of my personal information.'],
    ['保密协议（NDA）', 'I certify that the information I provided is true and I agree to sign an NDA.'],
    ['条款同意里夹着健康信息', 'I agree to the Privacy Policy and consent to the processing of my health information.'],
    ['条款同意里夹着残障信息', 'I have read and agree to the Applicant Privacy Notice, including the processing of my disability status.'],
    ['人脸扫描', 'I consent to the recording of my interviews, including face scans.'],
  ])('%s → null：%s', (_why, label) => {
    expect(signOnBehalfCheckboxKind(label)).toBeNull();
    expect(consentOnBehalfKind(label)).toBeNull();
    expect(signOnBehalfChoiceKind(label)).toBeNull();
  });

  it('集团公司日后联系（group of companies、sister company）不再算作 09-24 那一版的「日后联系」', () => {
    for (const label of [
      'I would like to be considered for other roles within the Acme group of companies.',
      'I would like to be contacted about future opportunities at Acme and its sister companies.',
    ]) {
      expect(consentOnBehalfKind(label)).toBeNull();
      expect(signOnBehalfChoiceKind(label)).toBe('GROUP_FUTURE_CONTACT');
    }
  });
});

describe('否定句不是同意', () => {
  it.each([
    'I do not consent to a credit check.',
    "I do not agree to share my data with Acme's recruiting service providers.",
    'I decline the drug test.',
    "I don't want to receive phone calls about my application.",
    'I do not authorize Acme to verify my education.',
    'I refuse AI analysis of my interview recordings.',
    'Please do not contact me about opportunities at Acme affiliates.',
    'I do not agree to the class action waiver in the Arbitration Agreement.',
    'I do not acknowledge that employment is at-will.',
    'Class Action Waiver: I agree not to participate in any class action.',
  ])('%s → null', (label) => {
    expect(widenedConsentKind(label)).toBeNull();
    expect(signOnBehalfChoiceKind(label)).toBeNull();
  });
});

describe('标题：同一类、没有同意动词的题面', () => {
  it.each([
    ['INFORMATION_VERIFICATION', 'E-Verify Acknowledgement'],
    ['SCREENING_CONSENT', 'Credit Check Authorization'],
    ['AT_WILL_ACKNOWLEDGEMENT', 'At-Will Employment'],
    ['ARBITRATION_WAIVER', 'Arbitration Agreement and Class Action Waiver'],
    ['CALL_NOTIFICATION_CONSENT', 'WhatsApp opt-in'],
  ] as const)('%s ← %s', (kind, title) => {
    expect(widenedTopicTitle(title)).toBe(kind);
  });

  it.each(['Class Action Waiver', 'Credit Check and Non-Compete', 'Medical Examination', 'Background Check', 'Name', ''])(
    '%s → null',
    (title) => {
      expect(widenedTopicTitle(title)).toBeNull();
    },
  );

  it('标题 + Yes/No 不算同意（标题只让本身就是整句同意的选项算数）', () => {
    expect(signOnBehalfChoiceAnswer('Credit Check Authorization', ['Yes', 'No'])).toBeNull();
    expect(signOnBehalfChoiceAnswer('Credit Check Authorization', ['I authorize Acme to obtain a credit report.', 'No']))
      .toEqual({ kind: 'SCREENING_CONSENT', index: 0 });
  });
});

describe('只有标题的隐私声明（正文读不到）+ 一个肯定回答', () => {
  it.each(['Applicant Privacy Notice', 'California Applicant Privacy Notice', 'Candidate Privacy Policy', 'GDPR Privacy Notice *', 'Privacy Notice Acknowledgement'])(
    '%s',
    (title) => {
      expect(privacyNoticeTitle(title)).toBe(true);
      expect(signOnBehalfChoiceKind(title)).toBe('PRIVACY_NOTICE_TITLE');
    },
  );

  it('选一项：恰好一个肯定回答，其余只能是否定回答或占位项', () => {
    expect(signOnBehalfChoiceAnswer('Applicant Privacy Notice', ['Yes'])).toEqual({ kind: 'PRIVACY_NOTICE_TITLE', index: 0 });
    expect(signOnBehalfChoiceAnswer('California Applicant Privacy Notice', ['Select...', 'Yes', 'No']))
      .toEqual({ kind: 'PRIVACY_NOTICE_TITLE', index: 1 });
    expect(signOnBehalfChoiceAnswer('Applicant Privacy Notice', ['Acknowledge'])).toEqual({ kind: 'PRIVACY_NOTICE_TITLE', index: 0 });
  });

  it.each([
    ['掺了别的类别', 'Privacy Notice for SMS Updates', ['Yes']],
    ['两个肯定回答', 'Applicant Privacy Notice', ['Yes', 'I agree']],
    ['另一项不是否定回答', 'Applicant Privacy Notice', ['Yes', 'Maybe later']],
    ['点名出售', 'Notice of Right to Opt Out of Sale of Personal Information', ['Yes']],
    ['不是标题', 'Have you read the Applicant Privacy Notice and do you want to share it with your employer?', ['Yes']],
  ])('%s → null', (_why, question, options) => {
    expect(signOnBehalfChoiceAnswer(question, options)).toBeNull();
  });

  it('旧判据照旧先答：选项本身是「已阅读并知悉」那一句的，仍是条款同意', () => {
    expect(signOnBehalfChoiceAnswer('Applicant Privacy Notice', ['I acknowledge that I have read the Applicant Privacy Notice.', 'No']))
      .toEqual({ kind: 'TERMS_CONSENT', index: 0 });
  });
});

describe('选择题（合并判据）：第五刀的类别', () => {
  it('题面是同意问句 → 恰好一个肯定回答', () => {
    expect(signOnBehalfChoiceAnswer('Do you consent to a credit check as part of our hiring process?', ['Yes', 'No']))
      .toEqual({ kind: 'SCREENING_CONSENT', index: 0 });
    expect(signOnBehalfChoiceAnswer('Do you authorize Acme to verify your education?', ['I authorize', 'I do not authorize']))
      .toEqual({ kind: 'INFORMATION_VERIFICATION', index: 0 });
    expect(signOnBehalfChoiceAnswer('I understand that employment with Acme is at-will.', ['Select...', 'I understand', 'I do not understand']))
      .toEqual({ kind: 'AT_WILL_ACKNOWLEDGEMENT', index: 1 });
  });

  it('题面不沾任何一类，选项本身是整句同意、其余是否定回答 → 那一项', () => {
    expect(signOnBehalfChoiceAnswer('Please review the linked document:', ['I agree to submit to a pre-employment drug test.', 'No']))
      .toEqual({ kind: 'SCREENING_CONSENT', index: 0 });
  });

  it.each([
    ['两项都是肯定回答', 'Do you consent to a credit check?', ['Yes', 'I agree']],
    ['没有肯定回答', 'Do you consent to a credit check?', ['Sure thing', 'No']],
    ['题面是否定句', 'If you do not agree, select below', ['I agree to submit to a pre-employment drug test.']],
    ['题面点名出售', 'Do you consent to Acme selling your data?', ['Yes', 'No']],
  ])('%s → null', (_why, question, options) => {
    expect(signOnBehalfChoiceAnswer(question, options)).toBeNull();
  });
});

describe('同意书覆盖哪几类（2026-09-28 起只有当前版本算数）', () => {
  const OLD: readonly SignOnBehalfKind[] = [
    'TERMS_CONSENT', 'TRUTH_ATTESTATION', 'SIGNATURE_NAME', 'SIGNATURE_DATE',
    'AI_RECORDING_CONSENT', 'SMS_CONSENT', 'FUTURE_CONTACT_CONSENT', 'MARKETING_CONSENT', 'BACKGROUND_CHECK_CONSENT', 'ARBITRATION_AGREEMENT',
  ];
  const NEW: readonly SignOnBehalfKind[] = [
    'RECRUITING_DATA_SHARING', 'INFORMATION_VERIFICATION', 'SCREENING_CONSENT', 'AT_WILL_ACKNOWLEDGEMENT', 'ARBITRATION_WAIVER',
    'AI_INTERVIEW_ANALYSIS', 'CALL_NOTIFICATION_CONSENT', 'GROUP_FUTURE_CONTACT', 'PRIVACY_NOTICE_TITLE', 'COMBINED_CONSENT',
  ];

  it('当前版本（2026-09-28）覆盖旧的十类加上新的十类；旧版本的同意一类都不覆盖（由调用方按没同意处理）', () => {
    expect([...SIGNING_CONSENT_KINDS].sort()).toEqual([...OLD, ...NEW].sort());
  });

  it('能不能联系雇主不看同意书，只看资料里的回答；没答就一类都不放', () => {
    expect(SIGNING_CONSENT_KINDS.some((kind) => isEmployerContactKind(kind))).toBe(false);
    expect([...employerContactKinds('YES')].sort()).toEqual(['EMPLOYER_CONTACT_YES', 'REFERENCE_CONTACT_YES']);
    expect([...employerContactKinds('NO')].sort()).toEqual(['EMPLOYER_CONTACT_NO', 'REFERENCE_CONTACT_NO']);
    expect(employerContactKinds(undefined)).toEqual([]);
  });

  it('全部类别那张表：一类不漏、一类不重，与内核的条目键表（按类别穷举、少一类编译不过）逐项相等', () => {
    const expected = [...SIGNING_CONSENT_KINDS, ...employerContactKinds('YES'), ...employerContactKinds('NO')];
    expect([...ALL_SIGN_ON_BEHALF_KINDS].sort()).toEqual([...new Set(expected)].sort());
    expect(new Set(ALL_SIGN_ON_BEHALF_KINDS).size).toBe(ALL_SIGN_ON_BEHALF_KINDS.length);
    expect([...ALL_SIGN_ON_BEHALF_KINDS].sort()).toEqual(Object.keys(SIGN_ON_BEHALF_ENTRY_KEY).sort());
  });
});

describe('能不能联系现在的雇主：按资料里的回答答', () => {
  it.each([
    ['May we contact your current employer?', ['Yes', 'No'], 'YES', 'EMPLOYER_CONTACT_YES', 0],
    ['May we contact your current employer?', ['Yes', 'No'], 'NO', 'EMPLOYER_CONTACT_NO', 1],
    ['May we contact your present employer for a reference?', ['Yes', 'No', 'Yes, after an offer is made'], 'YES', 'EMPLOYER_CONTACT_YES', 0],
    ['Can we contact your employer to verify your employment?', ['Select...', 'Yes', 'No'], 'NO', 'EMPLOYER_CONTACT_NO', 2],
    ['May we contact your current and former employers?', ['Yes', 'No'], 'YES', 'EMPLOYER_CONTACT_YES', 0],
    [
      'May we contact your current employer?',
      ['Yes, you may contact my current employer', 'No, please do not contact my current employer'],
      'NO',
      'EMPLOYER_CONTACT_NO',
      1,
    ],
    [
      'May we contact your current employer?',
      ['Yes, you may contact my current employer', 'No, please do not contact my current employer'],
      'YES',
      'EMPLOYER_CONTACT_YES',
      0,
    ],
  ] as const)('%s %j + %s → %s', (question, options, answer, kind, index) => {
    expect(employerContactAnswer(question, options, answer)).toEqual({ kind, index });
    expect(signOnBehalfAnswerFor(kind, question, options)).toBe(index);
  });

  it('以前的雇主与推荐人：题目只问他们时，照同一个回答答', () => {
    expect(employerContactAnswer('Can we contact your previous employers?', ['Yes', 'No'], 'YES'))
      .toEqual({ kind: 'REFERENCE_CONTACT_YES', index: 0 });
    expect(employerContactAnswer('May we contact the references you listed?', ['Yes', 'No'], 'NO'))
      .toEqual({ kind: 'REFERENCE_CONTACT_NO', index: 1 });
    expect(employerContactSubject('May we contact your former supervisors?')).toBe('PAST');
    expect(employerContactSubject('May we contact your current employer?')).toBe('CURRENT');
  });

  it.each([
    ['掺了背景调查', 'May we contact your current employer and run a background check?', ['Yes', 'No']],
    ['掺了信用', 'May we contact your current employer about your credit history?', ['Yes', 'No']],
    ['否定问句', 'Do you not want us to contact your current employer?', ['Yes', 'No']],
    ['没有联系动词', 'Who is your current employer?', ['Yes', 'No']],
    ['事实问题', 'Is your current employer aware of your application?', ['Yes', 'No']],
    ['还点名了同事', 'May we contact your current employer and colleagues?', ['Yes', 'No']],
    ['两个否定回答', 'May we contact your current employer?', ['No', 'Not at this time']],
  ])('%s → 两个方向都不答', (_why, question, options) => {
    expect(employerContactAnswer(question, options, 'YES')).toBeNull();
    expect(employerContactAnswer(question, options, 'NO')).toBeNull();
  });

  it('有条件的肯定（「Only after an offer」）不算「可以」；「不可以」照样答 No', () => {
    const options = ['Only after an offer', 'No'];
    expect(employerContactAnswer('May we contact your current employer?', options, 'YES')).toBeNull();
    expect(employerContactAnswer('May we contact your current employer?', options, 'NO')).toEqual({ kind: 'EMPLOYER_CONTACT_NO', index: 1 });
  });

  it('单个勾选框：只在答「可以」且那句话是正面的授权时勾', () => {
    expect(employerContactCheckboxKind('I authorize Acme to contact my current employer.', 'YES')).toBe('EMPLOYER_CONTACT_YES');
    expect(employerContactCheckboxKind('I authorize Acme to contact my current employer.', 'NO')).toBeNull();
    expect(employerContactCheckboxKind('You may contact my references.', 'YES')).toBe('REFERENCE_CONTACT_YES');
    expect(employerContactCheckboxKind('Please do not contact my current employer.', 'YES')).toBeNull();
    expect(employerContactCheckboxKind('Please do not contact my current employer.', 'NO')).toBeNull();
    expect(employerContactCheckboxKind('I authorize a background check and contact with my current employer.', 'YES')).toBeNull();
  });

  it('同意类的判据不接这一问（它只由资料里的回答答）', () => {
    expect(signOnBehalfChoiceKind('I authorize Acme to contact my current employer.')).toBeNull();
    expect(signOnBehalfChoiceAnswer('May we contact your current employer?', ['Yes', 'No'])).toBeNull();
  });

  it('按类别答：方向与对象都要对得上', () => {
    const question = 'May we contact your current employer?';
    expect(signOnBehalfAnswerFor('EMPLOYER_CONTACT_YES', question, ['Yes', 'No'])).toBe(0);
    expect(signOnBehalfAnswerFor('EMPLOYER_CONTACT_NO', question, ['Yes', 'No'])).toBe(1);
    expect(signOnBehalfAnswerFor('REFERENCE_CONTACT_YES', question, ['Yes', 'No'])).toBeNull();
    expect(signOnBehalfAnswerFor('SCREENING_CONSENT', 'Do you consent to a credit check?', ['Yes', 'No'])).toBe(0);
    expect(signOnBehalfAnswerFor('BACKGROUND_CHECK_CONSENT', 'Do you consent to a credit check?', ['Yes', 'No'])).toBeNull();
  });
});

describe('点击当下认回来的那几句（点击策略用的判据）', () => {
  it('题面与选项各认各的：方向不对的选项认不回来', () => {
    const question = 'May we contact your current employer?';
    expect(signOnBehalfAsks(question, 'EMPLOYER_CONTACT_NO')).toBe(true);
    expect(signOnBehalfAnswers('EMPLOYER_CONTACT_NO', 'No')).toBe(true);
    expect(signOnBehalfAnswers('EMPLOYER_CONTACT_NO', 'Yes')).toBe(false);
    expect(signOnBehalfAnswers('EMPLOYER_CONTACT_YES', 'Yes')).toBe(true);
    expect(signOnBehalfAnswers('EMPLOYER_CONTACT_YES', 'No')).toBe(false);
    expect(signOnBehalfAsks('May we contact your references?', 'EMPLOYER_CONTACT_YES')).toBe(false);
  });

  it('整句同意认得回来是这一类；换成别的类别就认不回来', () => {
    expect(signOnBehalfStates('I authorize Acme to obtain a credit report as part of my application.', 'SCREENING_CONSENT')).toBe(true);
    expect(signOnBehalfStates('I authorize Acme to obtain a credit report as part of my application.', 'BACKGROUND_CHECK_CONSENT')).toBe(false);
    expect(signOnBehalfStates('I authorize Acme to contact my current employer.', 'EMPLOYER_CONTACT_YES')).toBe(true);
    expect(signOnBehalfStates('Please do not contact my current employer.', 'EMPLOYER_CONTACT_YES')).toBe(false);
    expect(signOnBehalfAsks('Applicant Privacy Notice', 'PRIVACY_NOTICE_TITLE')).toBe(true);
    expect(signOnBehalfAnswers('PRIVACY_NOTICE_TITLE', 'Yes')).toBe(true);
  });

  it('选择题的类别都走整道题的判据', () => {
    for (const kind of ALL_SIGN_ON_BEHALF_KINDS) {
      if (kind === 'SIGNATURE_NAME' || kind === 'SIGNATURE_DATE') expect(isSignOnBehalfChoiceKind(kind)).toBe(false);
      else expect(isSignOnBehalfChoiceKind(kind)).toBe(true);
    }
  });
});
