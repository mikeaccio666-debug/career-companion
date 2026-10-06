import type { DockEeoAnswers } from './profileEditorPorts';

/**
 * 浮层资料编辑器里「自我认同」那一节只管五问。门户那一节另外存着出生性别、是否跨性别与性取向，而后端的保存是
 * 整份替换（argoland `EeoSelfIdentificationService` 把新的 answers 整份封存）：浮层保存时不把那几问原样带回去，
 * 用户在浮层里改一次性别，门户里的另外三问就没了，插件也就再答不出那几类题（2026-09-24）。
 */
const DOCK_FIELDS = ['genderIdentity', 'hispanicLatino', 'raceEthnicity', 'veteranStatus', 'disabilityStatus'] as const;

/** 契约里浮层不管、要原样带回去的那几问（= `EEO_SELF_IDENTIFICATION_FIELD_CODES` 去掉上面五问，由测试钉住）。 */
export const EEO_FIELDS_BEYOND_DOCK = ['eeoSex', 'transgenderStatus', 'sexualOrientation'] as const;

type EeoField = (typeof DOCK_FIELDS)[number] | (typeof EEO_FIELDS_BEYOND_DOCK)[number];
export type EeoSaveAnswers = Readonly<Partial<Record<EeoField, readonly string[]>>>;

/** 读到（或存成）的那一整份回答里，浮层不管的那几问；空的不留。 */
export function eeoAnswersBeyondDock(answers: Readonly<Record<string, readonly string[] | undefined>>): EeoSaveAnswers {
  const kept: Partial<Record<EeoField, readonly string[]>> = {};
  for (const field of EEO_FIELDS_BEYOND_DOCK) {
    const value = answers[field];
    if (value !== undefined && value.length > 0) kept[field] = [...value];
  }
  return kept;
}

/** 浮层要存的整份回答：它管的五问按编辑器里的样子（空的不发），其余几问照上一次读到的原样带回去。 */
export function eeoAnswersForSave(edited: DockEeoAnswers, beyondDock: EeoSaveAnswers): EeoSaveAnswers {
  return {
    ...beyondDock,
    ...(edited.genderIdentity !== '' ? { genderIdentity: [edited.genderIdentity] } : {}),
    ...(edited.hispanicLatino !== '' ? { hispanicLatino: [edited.hispanicLatino] } : {}),
    ...(edited.raceEthnicity.length > 0 ? { raceEthnicity: [...edited.raceEthnicity] } : {}),
    ...(edited.veteranStatus !== '' ? { veteranStatus: [edited.veteranStatus] } : {}),
    ...(edited.disabilityStatus !== '' ? { disabilityStatus: [edited.disabilityStatus] } : {}),
  };
}
