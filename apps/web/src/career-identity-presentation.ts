import type { CareerIdentityField, CareerIdentityRecord, CareerIdentityInputValue } from '@companion/platform-contracts';
export const IDENTITY_FOOTER = '信息与提醒，不是法律意见。涉及你个人身份的决定，请先和学校 DSO 或移民律师确认。';
export const identityLabels: Readonly<Record<CareerIdentityField, string>> = Object.freeze({ program_end_date: 'I-20 上的 program end date', stem_designated: '你报告的 STEM 指定', opt_status: '你记录的 OPT 状态', opt_start_date: 'OPT EAD 起始日期', opt_end_date: 'OPT EAD 结束日期', stem_opt_start_date: 'STEM OPT EAD 起始日期', stem_opt_end_date: 'STEM OPT EAD 结束日期', unemployment_days_reported: '你自己记的待业天数', employment_reported: '你报告的当前就业情况', h1b_registration: '你报告的 H-1B 注册结果', custom_status_date: '自定义日期' });
export function identityValueText(r: Readonly<CareerIdentityRecord>) {
    if (r.field === 'unemployment_days_reported') {
        const v = r.value as {
            days: number;
            reportedAt: string;
        };
        return '你 ' + v.reportedAt.slice(0, 10) + ' 记的：' + v.days + ' 天（记录日期为 UTC）';
    }
    if (r.field === 'h1b_registration') {
        const v = r.value as {
            year: number;
            outcome: 'selected' | 'not_selected' | 'unknown';
        };
        return v.year + ' 年 · ' + ({ selected: '你报告已中签', not_selected: '你报告未中签', unknown: '你还不确定' }[v.outcome]);
    }
    if (typeof r.value === 'boolean')
        return r.field === 'employment_reported' ? (r.value ? '有工作' : '没有工作') : (r.value ? '是' : '否');
    return r.value as string;
}
export function identityEditorValue(field: CareerIdentityField, text: string, booleanChoice: string, year: string, outcome: string): CareerIdentityInputValue {
    if (field === 'employment_reported' || field === 'stem_designated') {
        if (!['true', 'false'].includes(booleanChoice))
            throw Error('请明确选择，或先取消。');
        return booleanChoice === 'true';
    }
    if (field === 'unemployment_days_reported') {
        if (!/^(0|[1-9][0-9]*)$/.test(text))
            throw Error('填写你自己记的整数；不确定可以先取消。');
        return { days: Number(text) };
    }
    if (field === 'h1b_registration') {
        if (!/^[1-9][0-9]{0,3}$/.test(year) || !['selected', 'not_selected', 'unknown'].includes(outcome))
            throw Error('填写报告年份并选择你知道的结果。');
        return { year: Number(year), outcome: outcome as 'selected' | 'not_selected' | 'unknown' };
    }
    return text; // Calendar day / owner wording is validated by the closed contract.
}
