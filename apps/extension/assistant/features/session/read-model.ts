import type { ProfileDirectoryPersonalV1, ResumeLibrarySnapshotV1 } from '@edaix/contracts';
import type { Profile, ResumeOption } from '../../state/types';
import { createTranslator, type AssistantLocale } from '../../i18n';

export function emptyProfile(): Profile {
  return { name: '', nick: '', email: '', phone: '', city: '', links: '', role: '', locations: '',
    workMode: '', salary: '', start: '', notice: '', workAuth: '', sponsorship: '', gender: '', race: '',
    disability: '', veteran: '', education: '', projects: '', languages: '', summary: '', experience: [], skills: [] };
}

/** Display only. Directory reads do not constitute candidate confirmation or fill authority. */
export function projectPersonal(value: ProfileDirectoryPersonalV1): Profile {
  const f = value.fields;
  return { ...emptyProfile(), name: f.fullName || [f.firstName, f.lastName].filter(Boolean).join(' '),
    nick: f.preferredName ?? '', email: f.email ?? '', phone: f.phone ?? '', city: f.city || f.location || '',
    links: [f.linkedinUrl, f.githubUrl, f.portfolioUrl].filter(Boolean).join('\n') };
}

export function projectResumeLibrary(value: ResumeLibrarySnapshotV1, previousId = '', locale: AssistantLocale = 'en-US') {
  const t = createTranslator(locale);
  const active = value.tracks.filter(track => track.archivedAt === null);
  const options: ResumeOption[] = active.flatMap(track => track.versions
    .filter(version => version.lifecycleStatus === 'READY')
    .map(version => ({ id: version.resumeVersionId, track: track.name, version: `v${version.versionNumber}`,
      label: `${track.name} · ${version.label || `v${version.versionNumber}`}`, kind: 'existing' as const,
      current: version.isCurrent, note: t('{v0} · 交付权限需在申请时验证', { v0: t(version.isCurrent ? '当前版本' : '历史版本') }) })));
  const defaultCurrent = active.find(track => track.trackId === value.defaultTrackId)?.currentVersionId;
  const selectedId = options.find(option => option.id === previousId)?.id
    ?? options.find(option => option.id === defaultCurrent)?.id ?? options[0]?.id ?? '';
  return { options, selectedId,
    processingCount: active.reduce((count, track) => count + track.versions.filter(version =>
      version.lifecycleStatus === 'PROCESSING' || version.lifecycleStatus === 'UPLOAD_PENDING').length, 0),
    failedCount: active.reduce((count, track) => count + track.versions.filter(version => version.lifecycleStatus === 'FAILED').length, 0),
    hasMoreVersions: active.some(track => track.hasMoreVersions) };
}
