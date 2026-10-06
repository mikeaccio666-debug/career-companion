import { sectionLabels, type ProfileSection } from '../profile/editor-model';
import type { DatePart } from '@edaix/contracts';
import type { ViewContext } from '../../app/view-context';
import { C } from '../../design/palette';

/** Read projection: render stored content as text; never promote fact metadata to fill authority. */
export function savedProfileView(ctx: ViewContext) {
  const t = ctx.t, snapshot = ctx.state.profileV2, status = ctx.state.reads?.profileV2;
  const join = (values: (string | null | undefined)[], separator = ' · ') => values.filter(Boolean).join(separator);
  const date = (v: DatePart | null) => v ? `${v.year}${v.month ? '-' + String(v.month).padStart(2, '0') : ''}` : '';
  const range = (v: { startDate: DatePart | null; endDate: DatePart | null; isCurrent: boolean }) => join([date(v.startDate), v.isCurrent ? t('至今') : date(v.endDate)], ' — ');
  const row = (label: string, value: string | null | undefined) => ({ label, value: value || t('未提供'), dot: value ? C.green : '#C9D2DF', color: value ? C.ink : C.faint });
  const group = (section: ProfileSection | 'legacy', rows: ReturnType<typeof row>[]) => ({ title: t(section === 'legacy' ? '待整理的历史资料' : sectionLabels[section]), rows, phase: 0, hasSwitch: false, stacked: false, stackPad: 0, subtitle: '', switchLabel: '', editSection: ctx.state.profileEditingEnabled && section !== 'legacy' ? section : undefined });
  const groups: ReturnType<typeof group>[] = [];
  if (status === 'ready' && snapshot) {
    const p = snapshot.profile;
    groups.push(group('basic', [row(t('姓名'), p.identity.fullName || join([p.identity.firstName, p.identity.middleName, p.identity.lastName], ' ')),
      row(t('称呼'), p.identity.preferredName), row(t('邮箱'), p.contact.email), row(t('电话'), p.contact.phone.display || p.contact.phone.e164),
      row(t('地址'), join([p.address.line1, p.address.line2, p.address.city, p.address.region, p.address.postalCode, p.address.countryCode])),
      ]));
    groups.push(group('summary', [row(t('概述'), p.summary)]));
    groups.push(group('links', [row(t('链接'), p.links.map(v => join([v.label, v.url])).join('\n'))]));
    groups.push(group('experiences', p.experiences.length ? p.experiences.map(v => row(join([v.company, v.title]), join([range(v), join([v.city, v.region]), v.description], '\n'))) : [row(t('工作经历'), p.noExperience ? t('暂无工作经历') : '')]));
    groups.push(group('educations', p.educations.length ? p.educations.map(v => row(v.school, join([join([v.degree, v.fieldOfStudy]), range(v), v.expectedGraduationDate ? t('预计毕业：{v0}', { v0: date(v.expectedGraduationDate) }) : '', join([v.city, v.region]), v.gpa ? `GPA ${v.gpa}${v.gpaScale ? '/' + v.gpaScale : ''}` : '', v.coursework], '\n'))) : [row(t('教育'), '')]));
    groups.push(group('skills', [row(t('技能'), p.skills.map(v => v.name).join(' · '))]));
    groups.push(group('languages', p.languages.length ? p.languages.map(v => row(v.language, ({ NATIVE_OR_BILINGUAL: t('母语'), PROFESSIONAL: t('专业工作水平'), CONVERSATIONAL: t('日常交流'), BASIC: t('基础') } as Record<string, string>)[v.proficiency] ?? v.proficiency)) : [row(t('语言'), '')]));
    groups.push(group('projects', p.projects.length ? p.projects.map(v => row(v.title, join([join([v.organization, v.role, v.location]), range(v), v.description, v.url, v.skillIds.map(id => p.skills.find(s => s.id === id)?.name).filter(Boolean).join(' · ')], '\n'))) : [row(t('项目'), '')]));
    groups.push(group('achievements', p.achievements.length ? p.achievements.map(v => row(v.title, join([v.statement, date(v.occurredAt), v.url], '\n'))) : [row(t('成果'), '')]));
    groups.push(group('availability', [row(t('可开始时间'), p.availability.earliestStartDate), row(t('提前通知天数'), p.availability.noticePeriodDays === null ? '' : String(p.availability.noticePeriodDays))]));
    const answer = (v: string) => ({ YES: t('是'), NO: t('否'), UNSPECIFIED: t('未提供') } as Record<string, string>)[v] ?? v;
    groups.push(group('workAuthorizations', p.workAuthorizations.length ? p.workAuthorizations.map(v => row(v.regionCode, join([t('工作许可：{v0}', { v0: answer(v.authorizedToWork) }), t('签证支持：{v0}', { v0: answer(v.requiresSponsorship) }), v.revokedAt ? t('已撤销') : v.expiresAt ? t('有效期至：{v0}', { v0: v.expiresAt }) : ''], '\n'))) : [row(t('工作许可'), '')]));
    if (p.legacyUnresolved.profileLocation || p.legacyUnresolved.experienceLocations.length || p.legacyUnresolved.fieldValues.length) groups.push(group('legacy', [
      row(t('所在城市'), p.legacyUnresolved.profileLocation), ...p.legacyUnresolved.experienceLocations.map(v => row(t('工作经历'), v.value)), ...p.legacyUnresolved.fieldValues.map(v => row(t('历史字段'), v.value)),
    ]));
  }
  return { groups, sub: status === 'loading' ? t('正在读取完整资料…') : status === 'locked' ? t('完整资料暂未获准读取。') : status === 'unavailable' ? t('暂时无法读取完整资料，请稍后刷新。') : ctx.state.profileEditingEnabled ? t('按组查看和修改你的资料。') : snapshot?.hasStoredProfile ? t('以下为已保存的完整资料，可在 Portal 中修改。') : t('还没有已保存的完整资料。'),
    foot: ctx.state.profileEditingEnabled ? t('工作许可需按地区本人确认；可选的敏感自我认同信息单独处理。') : t('仅供查看。工作许可需按申请地区重新确认；敏感自我认同信息不在此处读取。') };
}
