import type { ApplicationProfileFieldKey } from "@edaix/contracts";
import type { Translator } from "../../i18n";
export function autofillFieldLabel(
  t: Translator,
  key: string,
  _index: number,
): string {
  const fields = {
    firstName: "名", lastName: "姓", fullName: "姓名", preferredName: "常用名",
    email: "邮箱", phone: "电话", city: "城市", location: "所在地",
    linkedinUrl: "LinkedIn", githubUrl: "GitHub", portfolioUrl: "个人网站",
    addressLine1: "街道地址", addressRegion: "省/州", addressCountry: "国家",
    addressPostalCode: "邮编", currentCompany: "现任公司", currentJobTitle: "现任职位",
    eeoGender: "性别", eeoRace: "族裔", eeoVeteran: "退伍军人身份",
    eeoDisability: "残障身份", heardAboutSource: "从哪听说职位",
    preferredPronouns: "代词", earliestStartDate: "最早到岗日期", noticePeriodDays: "离职通知期（天）",
    profileSummary: "个人简介", expectedSalaryAmount: "期望薪资", expectedSalaryCurrency: "薪资币种",
    expectedSalaryPeriod: "薪资周期", over18: "是否年满 18 岁", openToRelocation: "是否愿意搬迁",
    openToRelocationCities: "愿意搬迁的城市", preferredWorkModes: "办公模式", profileTwitterUrl: "Twitter / X",
    otherWebsiteUrl: "其他网站",
  } as const satisfies Record<ApplicationProfileFieldKey, string>;
  return Object.hasOwn(fields, key) ? t(fields[key as keyof typeof fields]) : t("其他申请项");
}
