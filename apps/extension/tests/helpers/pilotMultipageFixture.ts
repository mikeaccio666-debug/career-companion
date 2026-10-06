import {
  PILOT_UA4_LEDGER_SCHEMA_VERSION,
  type PilotUa4FinalDisposition,
  type PilotUa4TerminalLedger,
  type PilotUa4UnobservedRegion,
} from '@edaix/contracts/draft/pilot-ua4-write-authority';

export const digest = (character: string): string => character.repeat(64);

export const MULTIPAGE_MISSION_DIGEST = digest('a');

export const MULTIPAGE_PAGES = Object.freeze([
  Object.freeze({
    exactPageUrlDigest: digest('1'),
    pageOrdinal: 0,
    stepIdentityDigest: digest('b'),
  }),
  Object.freeze({
    exactPageUrlDigest: digest('2'),
    pageOrdinal: 1,
    stepIdentityDigest: digest('c'),
  }),
  Object.freeze({
    exactPageUrlDigest: digest('3'),
    pageOrdinal: 2,
    stepIdentityDigest: digest('d'),
  }),
] as const);

export interface FixtureDispositionRow {
  readonly questionId: string;
  readonly required: boolean;
  readonly disposition: PilotUa4FinalDisposition;
}

export function terminalLedger(
  pageIndex: 0 | 1 | 2,
  rows: readonly FixtureDispositionRow[],
  discoveryComplete = true,
  domGenerationDigest = digest(String(pageIndex + 4)),
  unobservedRegions: readonly PilotUa4UnobservedRegion[] = [],
): PilotUa4TerminalLedger {
  const requiredQuestions = rows.filter((row) => row.required).length;
  return Object.freeze({
    binding: Object.freeze({
      domGeneration: domGenerationDigest,
      origin: 'https://wizard.example.test',
      pathname: `/step-${pageIndex + 1}`,
    }),
    discoveryComplete,
    dispositions: Object.freeze(rows.map((row) => Object.freeze({
      disposition: row.disposition,
      questionId: row.questionId,
    }))),
    questions: Object.freeze(rows.map((row) => Object.freeze({
      questionId: row.questionId,
      required: row.required,
    }))),
    schemaVersion: PILOT_UA4_LEDGER_SCHEMA_VERSION,
    unobservedRegions: Object.freeze([...unobservedRegions]),
    summary: Object.freeze({
      observableQuestions: rows.length,
      requiredFieldFinalDispositionCoverage: 100,
      requiredQuestions,
      terminalQuestions: rows.length,
      terminalRequiredQuestions: requiredQuestions,
      unobservedRegions: unobservedRegions.length,
    }),
  });
}

export const MULTIPAGE_DOM_FIXTURES = Object.freeze({
  initial: '<main><section data-fixture="initial"></section></main>',
  replacement: '<main><form><div role="combobox"></div></form></main>',
  spaNext: '<main><form><div><input type="text"></div></form></main>',
});
