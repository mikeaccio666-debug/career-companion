import { describe, expect, it } from 'vitest';

import {
  consentOnBehalfKind,
  consentTopicTitle,
  isAffirmativeAnswerFor,
  signOnBehalfAnswer,
  signOnBehalfCheckboxKind,
  signOnBehalfChoiceAnswer,
  signOnBehalfChoiceKind,
} from '../src/dict/signOnBehalf';

/**
 * 代填第三刀（2026-09-24；负责人 2026-09-23 夜的决定）：同意类。
 *
 * 六类各有自己的整句判据：AI 面试记录／转写、与申请相关的短信、日后联系与人才库、营销信息、
 * 背景调查授权、仲裁协议的阅读确认与同意。整段文字只能说一类；掺了联系现任雇主、点名他人／第三方、
 * 信用／药检、免责、没有列明的授权，或者几类混在一起，一律交还本人；否定句不是同意。
 *
 * 题面全是合成的（公司名一律 Acme），不含任何真实 posting 的原文与个人信息。
 */

describe('六类，各认得出来', () => {
  it.each([
    ['AI_RECORDING_CONSENT', 'I consent to the recording and transcription of my interviews by an AI notetaker.'],
    ['AI_RECORDING_CONSENT', 'Do you consent to Acme using an AI note-taker to record and transcribe your interviews?'],
    [
      'AI_RECORDING_CONSENT',
      'We use AI note-taking tools to record and transcribe interviews so our interviewers can focus on the conversation. Do you consent?',
    ],
    ['AI_RECORDING_CONSENT', 'I agree that my interviews with Acme may be recorded and transcribed.'],
    ['AI_RECORDING_CONSENT', 'May we record your interview?'],
    [
      'AI_RECORDING_CONSENT',
      'Do you consent to AI note-taking during your interviews? If you prefer not to be recorded, select No.',
    ],
    ['AI_RECORDING_CONSENT', 'Declining will not affect your application. Do you consent to the recording of your interviews?'],
    ['AI_RECORDING_CONSENT', 'We use AI note-taking tools to record interviews. Please confirm.'],
    [
      'SMS_CONSENT',
      'I consent to receive recruiting text messages from Acme. Msg & data rates may apply. Msg frequency varies. Reply STOP to unsubscribe, HELP for help.',
    ],
    ['SMS_CONSENT', 'I agree to receive text messages. See our Privacy Policy.'],
    ['SMS_CONSENT', 'I agree to receive text messages from Acme about my application.'],
    [
      'SMS_CONSENT',
      'By checking this box, you consent to receive SMS updates about your application status. Message and data rates may apply. Reply STOP to opt out.',
    ],
    ['SMS_CONSENT', 'Would you like to receive text message updates about your application?'],
    ['SMS_CONSENT', 'Can we text you about interview scheduling?'],
    ['SMS_CONSENT', 'I consent to receive text messages about my application. Consent is not a condition of employment.'],
    ['SMS_CONSENT', 'I consent to receive text messages about my application in accordance with the Acme Privacy Policy.'],
    ['FUTURE_CONTACT_CONSENT', 'I would like to be contacted about future job opportunities at Acme.'],
    ['FUTURE_CONTACT_CONSENT', 'Join our talent community'],
    ['FUTURE_CONTACT_CONSENT', 'May we contact you about other roles that match your experience?'],
    ['FUTURE_CONTACT_CONSENT', 'I consent to Acme retaining my data for future job opportunities'],
    ['FUTURE_CONTACT_CONSENT', 'Yes, please keep me informed about future openings.'],
    ['MARKETING_CONSENT', 'I would like to receive marketing emails from Acme.'],
    ['MARKETING_CONSENT', 'Subscribe me to the Acme newsletter.'],
    ['MARKETING_CONSENT', 'I agree to receive promotional communications from Acme. You can unsubscribe at any time.'],
    ['BACKGROUND_CHECK_CONSENT', 'I authorize Acme to conduct a background check'],
    ['BACKGROUND_CHECK_CONSENT', 'Do you agree to a background check?'],
    [
      'BACKGROUND_CHECK_CONSENT',
      'We conduct thorough background checks as part of our hiring process. By selecting "Yes," you acknowledge and consent to a background check if you receive an offer.',
    ],
    [
      'BACKGROUND_CHECK_CONSENT',
      'We conduct thorough background checks as part of our hiring process. By selecting “Yes,” you acknowledge and consent.',
    ],
    ['BACKGROUND_CHECK_CONSENT', 'Are you willing to undergo a background check?'],
    ['ARBITRATION_AGREEMENT', 'I agree to resolve disputes through binding arbitration'],
    ['ARBITRATION_AGREEMENT', 'I understand and agree to the terms of the Agreement to Arbitrate set forth above.'],
    ['ARBITRATION_AGREEMENT', 'I will read the arbitration agreement below.'],
    ['ARBITRATION_AGREEMENT', 'I have read and agree to the Mutual Arbitration Agreement.'],
    ['ARBITRATION_AGREEMENT', 'I acknowledge and agree to the Arbitration Agreement, including the waiver of my right to a jury trial.'],
  ] as const)('%s ← %s', (kind, label) => {
    expect(consentOnBehalfKind(label)).toBe(kind);
    expect(signOnBehalfChoiceKind(label)).toBe(kind);
  });
});

describe('否决：点名他人、第三方与没有列明的授权，交还本人', () => {
  it.each([
    ['联系现任雇主', 'I authorize Acme to conduct a background check and contact my current employer.'],
    ['联系现任雇主（问句）', 'May we contact your current employer about future opportunities?'],
    ['点名推荐人', 'I authorize Acme to contact the references I listed as part of a background check.'],
    ['以前的雇主', 'I authorize a background check, including contacting my previous employers.'],
    ['合作方', 'I agree to receive marketing emails from Acme and its partners.'],
    ['免责', 'I authorize a background check and release Acme from any liability.'],
    ['营销短信', 'I agree to receive marketing text messages from Acme.'],
    ['验证码', 'We may text you a verification code. Do you consent?'],
    ['分享给客户', 'I consent to Acme sharing my profile with its clients for other opportunities.'],
    ['仲裁里混进竞业', 'I agree to the Arbitration Agreement and to the non-compete terms.'],
    ['多出一句别的事', 'I agree to receive text messages about my application. I also agree to relocate if required.'],
    ['没有列明的授权', 'Do you agree to our social media policy?'],
    ['不是面试录音', 'Are you comfortable working in a recording studio?'],
    ['事实问题，不是同意', 'Can you pass a background check?'],
    ['事实问题，不是同意', 'Have you ever been involved in an arbitration?'],
    ['事实问题，不是同意', 'Do you have experience writing marketing emails?'],
    ['事实问题，不是同意', 'Is this number able to receive text messages?'],
    ['知悉不是同意', 'Do you know that we record interviews?'],
    ['「请选一项」不是同意', 'We run background checks as part of our hiring process. Please select one.'],
    ['公司自称想录音，不是他同意', 'We would like to record your interview.'],
    ['以动作名起头', 'Send me text messages about my application'],
    ['空', ''],
  ])('%s → null：%s', (_why, label) => {
    expect(consentOnBehalfKind(label)).toBeNull();
    expect(signOnBehalfChoiceKind(label)).toBeNull();
  });

  it('太长（> 600 字）→ null', () => {
    expect(consentOnBehalfKind(`I agree to binding arbitration. ${'The agreement covers all claims. '.repeat(20)}`)).toBeNull();
  });
});

describe('第三刀不认、第五刀（2026-09-28）按新类别认：只由 2026-09-28 那一版的同意覆盖', () => {
  it.each([
    ['COMBINED_CONSENT', '背景调查 + 第三方服务商', 'I consent to a background check conducted by a third-party provider.'],
    ['COMBINED_CONSENT', '录音 + 分享给服务商', 'I consent to Acme sharing my interview recordings with its vendors.'],
    ['SCREENING_CONSENT', '信用调查', 'I authorize a background check, including a credit check.'],
    ['SCREENING_CONSENT', '药检', 'Do you consent to a background check and drug screening?'],
    ['SCREENING_CONSENT', '在职期间随时背调', 'I authorize Acme to conduct background checks at any time during my employment.'],
    ['COMBINED_CONSENT', '核实学历与工作经历 + 背景调查', 'I authorize Acme to verify my education and employment history as part of a background check.'],
    ['AI_INTERVIEW_ANALYSIS', 'AI 评估', 'I consent to Acme recording my interview and using AI to evaluate my answers.'],
    ['AI_INTERVIEW_ANALYSIS', 'AI 分析视频', 'Do you consent to AI analysis of your recorded video interview?'],
    ['CALL_NOTIFICATION_CONSENT', '电话', 'I agree to receive text messages and phone calls about my application.'],
  ] as const)('%s ← %s：%s', (kind, _why, label) => {
    expect(consentOnBehalfKind(label)).toBeNull();
    expect(signOnBehalfChoiceKind(label)).toBe(kind);
  });
});

describe('否定句不是同意', () => {
  it.each([
    'I do not consent to the recording of my interviews.',
    "I don't want to receive text messages.",
    'I do not agree to the arbitration agreement.',
    'Please do not contact me about future opportunities.',
    'I decline the background check.',
    'I would not like to receive marketing emails.',
    'I refuse to be recorded during interviews.',
  ])('%s → null', (label) => {
    expect(consentOnBehalfKind(label)).toBeNull();
  });
});

describe('几类混在一起：第三刀不认；第五刀（2026-09-28）起只由放行类别组成的混合按「混合」认', () => {
  it.each([
    'I agree to receive marketing emails and text messages',
    'I agree to receive marketing emails about future openings.',
    'Join our talent community and agree to the privacy policy',
    'I agree to the Privacy Policy and consent to receive SMS updates',
    'I have read the Privacy Policy and consent to receive text messages.',
    'I consent to a background check and agree to binding arbitration.',
    'I certify that the information I provided is true and agree to the Arbitration Agreement.',
    'Can we text you about future opportunities?',
    'I consent to the recording of my interviews and to a background check.',
  ])('%s → 第三刀 null，合并判据 COMBINED_CONSENT', (label) => {
    expect(consentOnBehalfKind(label)).toBeNull();
    expect(signOnBehalfChoiceKind(label)).toBe('COMBINED_CONSENT');
  });
});

describe('旧的四类不变；旧判据不再把同意类认成条款同意', () => {
  it('条款同意与属实声明照旧', () => {
    expect(signOnBehalfChoiceKind('I have read and agree to the Terms of Use and Privacy Policy')).toBe('TERMS_CONSENT');
    expect(signOnBehalfChoiceKind('I certify that the information provided in this application is true and complete.')).toBe('TRUTH_ATTESTATION');
  });

  it('提到隐私政策的录音同意：不是条款同意（从前会被认成 TERMS_CONSENT）', () => {
    const label = 'I consent to the recording of my interviews in accordance with the Privacy Policy.';
    expect(signOnBehalfCheckboxKind(label)).toBeNull();
    expect(signOnBehalfChoiceKind(label)).toBe('AI_RECORDING_CONSENT');
  });

  it('旧的选择题判据仍然不答背景调查（新类别只在合并判据里）', () => {
    expect(signOnBehalfAnswer('Do you agree to a background check?', ['Yes', 'No'])).toBeNull();
    expect(signOnBehalfChoiceAnswer('Do you agree to a background check?', ['Yes', 'No'])).toEqual({ kind: 'BACKGROUND_CHECK_CONSENT', index: 0 });
  });
});

describe('标题：同一类、没有同意动词的题面', () => {
  it.each([
    ['ARBITRATION_AGREEMENT', 'Agreement to Arbitrate'],
    ['ARBITRATION_AGREEMENT', 'Please read the arbitration agreement below'],
    ['SMS_CONSENT', 'SMS opt-in'],
    ['FUTURE_CONTACT_CONSENT', 'Talent Community'],
    ['BACKGROUND_CHECK_CONSENT', 'Background Check *'],
    ['AI_RECORDING_CONSENT', 'AI interview notetaker'],
  ] as const)('%s ← %s', (kind, title) => {
    expect(consentTopicTitle(title)).toBe(kind);
    expect(consentOnBehalfKind(title)).toBeNull();
  });

  it.each(['Agreement to Arbitrate and Background Check', 'Do not contact my current employer', 'Name', 'Recording', ''])('%s → null', (title) => {
    expect(consentTopicTitle(title)).toBeNull();
  });
});

describe('肯定回答：同意类多认几种说法，旧的四类不变', () => {
  it.each(['Opt in', 'Opt-in', 'I authorize', 'Yes, I authorize', 'I understand', 'I understand and agree', 'Yes, please'])('%s', (option) => {
    expect(isAffirmativeAnswerFor('SMS_CONSENT', option)).toBe(true);
    expect(isAffirmativeAnswerFor('TERMS_CONSENT', option)).toBe(false);
  });

  it.each(['Yes', 'I agree', 'Consent'])('%s 对两边都算', (option) => {
    expect(isAffirmativeAnswerFor('SMS_CONSENT', option)).toBe(true);
    expect(isAffirmativeAnswerFor('TERMS_CONSENT', option)).toBe(true);
  });

  it.each(['No', 'Opt out', 'Yes, and add me to your talent community', 'Maybe later'])('%s → 不是', (option) => {
    expect(isAffirmativeAnswerFor('FUTURE_CONTACT_CONSENT', option)).toBe(false);
  });
});

describe('选择题该选哪一项（合并判据）', () => {
  const ASHBY_BACKGROUND =
    'We conduct thorough background checks as part of our hiring process. By selecting "Yes," you acknowledge and consent to a background check if you receive an offer.';

  it('背景调查是非题 → Yes', () => {
    expect(signOnBehalfChoiceAnswer(ASHBY_BACKGROUND, ['Yes', 'No'])).toEqual({ kind: 'BACKGROUND_CHECK_CONSENT', index: 0 });
  });

  it('题面是同意问句、选项是整句 → 那一句肯定的', () => {
    expect(signOnBehalfChoiceAnswer('Do you consent to receive text messages about your application?', ['Yes, I consent', 'No, I do not consent']))
      .toEqual({ kind: 'SMS_CONSENT', index: 0 });
    expect(signOnBehalfChoiceAnswer('Would you like to join our talent community?', ['Opt out', 'Opt in']))
      .toEqual({ kind: 'FUTURE_CONTACT_CONSENT', index: 1 });
    expect(signOnBehalfChoiceAnswer('Do you authorize a background check?', ['I authorize', 'I do not authorize']))
      .toEqual({ kind: 'BACKGROUND_CHECK_CONSENT', index: 0 });
  });

  it('仲裁的两道必填下拉：题面是标题，选项本身是那一句阅读确认／同意', () => {
    expect(signOnBehalfChoiceAnswer('Agreement to Arbitrate', [
      'I understand and agree to the terms of the Agreement to Arbitrate set forth above.',
    ])).toEqual({ kind: 'ARBITRATION_AGREEMENT', index: 0 });
    expect(signOnBehalfChoiceAnswer('Please read the arbitration agreement below', ['I will read the arbitration agreement below.']))
      .toEqual({ kind: 'ARBITRATION_AGREEMENT', index: 0 });
    expect(signOnBehalfChoiceAnswer('Agreement to Arbitrate *', ['I agree to the Agreement to Arbitrate.', 'I do not agree to the Agreement to Arbitrate.']))
      .toEqual({ kind: 'ARBITRATION_AGREEMENT', index: 0 });
  });

  it('原生下拉的空白占位项不是一个回答', () => {
    expect(signOnBehalfChoiceAnswer('Agreement to Arbitrate', ['', 'Select...', 'I will read the arbitration agreement below.']))
      .toEqual({ kind: 'ARBITRATION_AGREEMENT', index: 2 });
  });

  it('题面不沾任何一类、选项是整句同意（其余是否定回答）→ 那一项', () => {
    expect(signOnBehalfChoiceAnswer('Please review the linked document:', ['I agree to binding arbitration.', 'No']))
      .toEqual({ kind: 'ARBITRATION_AGREEMENT', index: 0 });
  });

  it('旧的四类照旧', () => {
    expect(signOnBehalfChoiceAnswer('I certify that the information provided in this application is true and correct.', ['Yes', 'No']))
      .toEqual({ kind: 'TRUTH_ATTESTATION', index: 0 });
  });

  it.each([
    ['标题 + Yes/No（标题不是同意）', 'Agreement to Arbitrate', ['Yes', 'No']],
    ['两项都是肯定回答', 'Do you consent to a background check?', ['Yes', 'I agree']],
    ['标题 + 两句同意', 'Agreement to Arbitrate', ['I agree to the Agreement to Arbitrate.', 'I have read the arbitration agreement.']],
    ['另一项不是否定回答', 'Agreement to Arbitrate', ['I agree to the Agreement to Arbitrate.', 'I have questions about arbitration']],
    ['题面与选项是两类', 'Background Check', ['I agree to binding arbitration.']],
    ['题面是否定句', 'If you do not agree, select below', ['I agree to binding arbitration.']],
    ['题面混进现任雇主', 'Do you consent to a background check, including contacting your current employer?', ['Yes', 'No']],
    ['没有肯定回答', 'Do you consent to a background check?', ['Sure thing', 'No']],
  ])('%s → null', (_why, question, options) => {
    expect(signOnBehalfChoiceAnswer(question, options)).toBeNull();
  });
});
