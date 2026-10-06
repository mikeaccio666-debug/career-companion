/**
 * ATS lab mock applicant (VIBE_DIST=ats-lab only).
 *
 * Every value is synthetic. The flat keys are the kernel's canonical
 * `ApplyProfileDraft`; collections, work authorizations and the cover letter go
 * through the same `buildApplyPlan` options production uses.
 *
 * ⚠️ 这份 mock 申请人**就是批测的分子上限**。2026-09-17 那轮 729 页跑出
 * 必填 4503/5239 时它还停在十一个键——于是当天上午合进来的四条工作流
 * （国家/邮编/职位三键、EEO 自我认同、工作授权、「你从哪听说」）对那次测量
 * 完全不可见：不是没填上，是这个申请人手上压根没有那些值。
 * 契约的键表长了，这里必须跟着长，否则批测量的是一个不存在的用户。
 */

import type { ApplyProfileDraft } from '@edaix/apply-kernel/profileDraft';
import type { BuildPlanOptions } from '@edaix/apply-kernel/engine';

export type LabProfileCollections = NonNullable<BuildPlanOptions['collections']>;

export const LAB_PROFILE: ApplyProfileDraft = Object.freeze({
  firstName: 'Taylor',
  lastName: 'Example',
  fullName: 'Taylor Example',
  preferredName: 'Taylor',
  email: 'taylor.example@example.com',
  phone: '+1 415 555 0142',
  linkedinUrl: 'https://www.linkedin.com/in/taylor-example',
  githubUrl: 'https://github.com/taylor-example',
  portfolioUrl: 'https://taylor-example.dev',
  city: 'San Francisco',
  location: 'San Francisco, CA, United States',
  // 地址三件套 + 现任公司：argoland #469 起端点就在发，插件 2026-09-17 才接住。
  addressLine1: '1 Example Street',
  addressRegion: 'CA',
  addressPostalCode: '94103',
  // ISO 双字母码。dict/regions.ts 做码→名展开，下拉按展开后的名字匹配，
  // 所以这里**不能**写成 'United States'——那会把展开这一步测掉。
  addressCountry: 'US',
  currentCompany: 'Example Corp',
  currentJobTitle: 'Senior Software Engineer',
  // EEO 自我认同：存的是档案枚举，不是页面文案；engine 的第四道闸负责在
  // 这一页的选项里找恰好对得上的那一项。DECLINE 也是一个真答案——
  // 「不愿回答」是美国申请表法律要求提供的选项。
  eeoGender: 'FEMALE',
  eeoRace: 'ASIAN',
  eeoVeteran: 'NOT_A_VETERAN',
  eeoDisability: 'DECLINE',
  heardAboutSource: 'LinkedIn',
});

/**
 * 当前有效的工作授权记录。
 *
 * 生产里这份清单由服务端按「未撤销、已生效、未过期」筛过才下发，所以内核
 * 不碰时间；lab 直接给筛好的结果。只给美国一条是有意的：
 * `namedWorkRegion` 要求题面**点名**用户有记录的那个国家且恰好一个匹配，
 * 多给几条只会让实验的判据比生产宽。
 */
export const LAB_WORK_AUTHORIZATIONS: NonNullable<BuildPlanOptions['workAuthorizations']> = [
  { regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO' },
];

export const LAB_COLLECTIONS: LabProfileCollections = {
  educations: [
    {
      // A real institution name so school pickers that only accept catalog
      // entries (Greenhouse, Workday) can resolve it; the person is still mock.
      school: 'University of California, Berkeley',
      degreeLevel: 'BACHELOR',
      fieldOfStudy: 'Computer Science',
      startDate: { year: 2014, month: 9 },
      endDate: { year: 2018, month: 6 },
      location: 'Berkeley, CA',
      gpa: '3.8/4.0',
      gpaScale: '4.0',
      isCurrent: false,
    },
  ],
  experiences: [
    {
      company: 'Example Corp',
      title: 'Senior Software Engineer',
      employmentType: 'FULL_TIME',
      startDate: { year: 2021, month: 3 },
      endDate: null,
      location: 'San Francisco, CA',
      isCurrent: true,
    },
    {
      company: 'Sample Labs',
      title: 'Software Engineer',
      employmentType: 'FULL_TIME',
      startDate: { year: 2018, month: 7 },
      endDate: { year: 2021, month: 2 },
      location: 'Oakland, CA',
      isCurrent: false,
    },
  ],
  skills: ['TypeScript', 'Node.js', 'React', 'Playwright', 'Chrome Extensions'],
};

export const LAB_COVER_LETTER = [
  'Dear Hiring Team,',
  '',
  'This is a mock cover letter written by the EdAIX ATS lab. It exists only to exercise',
  'cover-letter fields on application forms and is never submitted.',
  '',
  'Best regards,',
  'Taylor Example',
].join('\n');
