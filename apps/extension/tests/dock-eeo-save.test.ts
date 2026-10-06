import { describe, expect, it } from 'vitest';
import { EEO_SELF_IDENTIFICATION_FIELD_CODES } from '@edaix/contracts';

import { EEO_FIELDS_BEYOND_DOCK, eeoAnswersBeyondDock, eeoAnswersForSave } from '../lib/dock/eeoSave';

/**
 * 2026-09-24：后端保存自我认同是整份替换（argoland 把新的 answers 整份封存）。浮层编辑器只管五问，
 * 从前保存时只发这五问，门户里另外存的出生性别、是否跨性别、性取向就被冲掉了——插件随后也答不出那几类题。
 * 全部是合成的回答。
 */
const LOADED = {
  genderIdentity: ['Woman'],
  eeoSex: ['Female'],
  transgenderStatus: ['No'],
  hispanicLatino: ['No'],
  raceEthnicity: ['Asian'],
  sexualOrientation: ['Heterosexual'],
  veteranStatus: ['I am not a protected veteran'],
  disabilityStatus: ['No, I do not have a disability and have not had one in the past'],
};
const EDITED = {
  genderIdentity: 'Man',
  hispanicLatino: 'No',
  raceEthnicity: ['Asian'],
  veteranStatus: 'I am not a protected veteran',
  disabilityStatus: '',
  reuseEnabled: true,
};

describe('浮层保存自我认同：浮层不管的那几问原样带回去', () => {
  it('改了浮层里的一问，门户另外存的三问还在', () => {
    expect(eeoAnswersForSave(EDITED, eeoAnswersBeyondDock(LOADED))).toEqual({
      genderIdentity: ['Man'],
      hispanicLatino: ['No'],
      raceEthnicity: ['Asian'],
      veteranStatus: ['I am not a protected veteran'],
      eeoSex: ['Female'],
      transgenderStatus: ['No'],
      sexualOrientation: ['Heterosexual'],
    });
  });

  it('浮层里清空的一问不发；门户里本来没答的，不凭空补上', () => {
    const saved = eeoAnswersForSave({ ...EDITED, genderIdentity: '' }, eeoAnswersBeyondDock({ sexualOrientation: ['Queer'], eeoSex: [] }));
    expect(saved).not.toHaveProperty('genderIdentity');
    expect(saved).not.toHaveProperty('eeoSex');
    expect(saved).not.toHaveProperty('transgenderStatus');
    expect(saved.sexualOrientation).toEqual(['Queer']);
  });

  it('「浮层不管的那几问」就是契约里的字段去掉浮层那五问', () => {
    const dock: readonly string[] = ['genderIdentity', 'hispanicLatino', 'raceEthnicity', 'veteranStatus', 'disabilityStatus'];
    expect([...EEO_FIELDS_BEYOND_DOCK].sort()).toEqual(EEO_SELF_IDENTIFICATION_FIELD_CODES.filter((code) => !dock.includes(code)).sort());
  });
});
