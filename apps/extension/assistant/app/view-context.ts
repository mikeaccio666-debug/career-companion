import { createTranslator, resolveAssistantLocale } from '../i18n';
import { localizePresentationData } from '../presentation-data';
import { C, MARKS } from '../design/palette';
import { heroHeight, type PanelDimensions } from '../shell/geometry';
import type { AssistantData, AssistantState, AtsReport, Entitlement, Job, ResumeOption, UsageKind } from '../state/types';

const EMPTY_JOB: Job = { id: '', company: '', title: '', location: '', mode: '', type: '', salary: null, salaryUnit: null, summary: '', matches: [], gap: '', source: '', posted: '', boardUrl: '', jdDigest: '', coverLetterRequirement: 'UNKNOWN', responsibilities: [], requirements: [] };
export const EMPTY_REPORT: AtsReport = { total: 0, max: 100, dims: {}, problems: [], suggestions: [], missing: [], rubricVersion: '', measuredAt: '' };

export const atsInputKey = (job: Job, resumeId: string) => `${job.id}|${resumeId}|${job.jdDigest}`;

export function visibleBatchSize(entitlement: Entitlement, sourceRemaining: number, groupSize = 10): number {
  if (entitlement.access !== 'granted' || entitlement.remaining === undefined || entitlement.sourceExhausted) return 0;
  return Math.max(0, Math.min(groupSize, sourceRemaining, entitlement.remaining === null ? groupSize : entitlement.remaining));
}

export function createViewContext(state: AssistantState, data: AssistantData, geometry: PanelDimensions) {
  const locale = resolveAssistantLocale(state.locale), t = createTranslator(locale);
  data = localizePresentationData(data, locale);
  const EMPTY_RESUME: ResumeOption = { id: '', track: '', version: '', label: t("尚未选择简历"), kind: 'existing', current: false, note: '' };
  if (state.jobOptions) data = {...data,jobs:state.jobOptions};
  if (state.resumeOptions) data = { ...data, resumeVersions: state.resumeOptions };
  const job = (id: string | undefined) => data.jobs.find(item => item.id === id) ?? EMPTY_JOB;
  const resume = () => data.resumeVersions.find(item => item.id === state.resumeId) ?? EMPTY_RESUME;
  const currentTarget = () => state.targets.find(item => item.id === state.currentTargetId) ?? state.targets[0] ?? null;
  const target = currentTarget();
  // Project the current target without overwriting shared personal/EEO facts.
  const profile = target ? { ...state.profile, role: target.role, locations: target.locations, workMode: target.workMode, salary: target.salary, start: target.start } : state.profile;
  const atsKey = (id: string | undefined) => atsInputKey(job(id), state.resumeId);
  return {
    locale, t, state: { ...state, profile }, data, geometry,
    panelDims: (_scene?: string) => ({ ...geometry, w: geometry.width, h: geometry.height }),
    heroH: (_geometry?: unknown) => heroHeight(geometry),
    job, resume, currentTarget, atsKey,
    report: (id: string | undefined, sample = false) => (sample ? data.sampleReports?.[id ?? ''] : state.atsResults[atsKey(id)]?.report) ?? EMPTY_REPORT,
    markBg: (id: string) => MARKS[Math.max(0, data.jobs.findIndex(item => item.id === id)) % MARKS.length] ?? C.ice,
    ent: (kind: UsageKind): Entitlement => {
      const entitlement = state.entitlements[kind], usage = entitlement.usage;
      if (!usage) return entitlement;
      return { ...entitlement,
        unit: t(usage.unit === 'JOB' ? '个岗位' : usage.unit === 'REPORT' ? '份' : usage.unit === 'SECOND' ? '秒' : '条'),
        period: t('本周期'),
        resetsAt: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(usage.resetsAt)),
      };
    },
    nextPhase: () => !state.confirmed[0] ? 0 : !state.confirmed[1] ? 1 : 2,
    batchSize: () => visibleBatchSize(state.entitlements.jobs, Math.max(0, data.jobs.length - state.deck.cursor)),
    letterReq: (id: string) => job(id).coverLetterRequirement,
  };
}
export type ViewContext = ReturnType<typeof createViewContext>;
