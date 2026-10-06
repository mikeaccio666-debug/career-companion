/** Action-card wire types shared by Conversation and Mission contracts. */

import type {
  DecimalString,
  IsoDateTime,
  LocalDate,
  Sha256Digest,
  Uuid,
} from './common.ts';
import type { CanonicalBcp47Locale, IsoCountryCode } from './sensitiveWrite.ts';

export const MESSAGE_SPEAKER_TYPES = [
  'USER',
  'AI_AGENT',
  'STAFF',
  'MENTOR',
  'SYSTEM',
] as const;
export type MessageSpeakerType = (typeof MESSAGE_SPEAKER_TYPES)[number];

export interface MessageSpeaker {
  readonly type: MessageSpeakerType;
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

export const DISPLAY_TEXT_CODES = [
  'REVIEW_APPLICATION_PLAN',
  'PLAN_FIELDS_SUMMARY',
  'USER_INPUT_REQUIRED',
  'AUTHENTICATION_REQUIRED',
  'COMPLETE_IN_PAGE_FIELD',
  'ANSWER_IN_CHAT',
  'CONFIRM_NON_DENYLISTED_FIELD',
] as const;
export type DisplayTextCode = (typeof DISPLAY_TEXT_CODES)[number];

export const SAFE_DISPLAY_PARAM_KEYS = [
  'fieldCount',
  'jobTitle',
  'companyName',
  'expiresAt',
] as const;
export type SafeDisplayParamKey = (typeof SAFE_DISPLAY_PARAM_KEYS)[number];

export interface DisplayCode {
  readonly code: DisplayTextCode;
  readonly defaultText: string;
  readonly safeParams: Readonly<
    Partial<Record<SafeDisplayParamKey, string | number | boolean>>
  >;
}

export const ACTION_CARD_TYPES = [
  'MISSION_APPROVAL',
  'IN_PAGE_ACTION',
  'CHAT_ANSWER',
  'SENSITIVE_CONFIRM',
  'AUTH_RECOVERY',
] as const;
export type ActionCardType = (typeof ACTION_CARD_TYPES)[number];

export const ACTION_CARD_STATUSES = [
  'PENDING',
  'COMPLETED',
  'EXPIRED',
  'SUPERSEDED',
  'CANCELLED',
] as const;
export type ActionCardStatus = (typeof ACTION_CARD_STATUSES)[number];

export const ACTION_CODES = [
  'APPROVE',
  'REJECT',
  'OPEN_WORKSPACE',
  'SEND_REPLY',
  'SUBMIT_ANSWER',
  'CONFIRM',
  'REAUTHENTICATE',
] as const;
export type ActionCode = (typeof ACTION_CODES)[number];

export const ACTION_ENDPOINT_IDS = [
  'MISSION_APPROVAL',
  'ACTION_DECISION',
  'OPEN_EXTENSION',
  'AUTH_LOGIN',
] as const;
export type ActionEndpointId = (typeof ACTION_ENDPOINT_IDS)[number];

export const ACTION_LABEL_CODES = [
  'APPROVE_PLAN',
  'REJECT_PLAN',
  'OPEN_WORKSPACE',
  'SEND_REPLY',
  'SUBMIT_ANSWER',
  'CONFIRM',
  'REAUTHENTICATE',
] as const;
export type ActionLabelCode = (typeof ACTION_LABEL_CODES)[number];

export type ActionCardOutcome = {
  readonly actionCode: ActionCode;
  readonly resultCode:
    | 'ACCEPTED'
    | 'REJECTED'
    | 'COMPLETED'
    | 'CANCELLED'
    | 'EXPIRED'
    | 'SUPERSEDED';
  readonly resolvedAt: IsoDateTime;
  readonly resolvedBySpeaker: MessageSpeaker | null;
};

export const ANSWER_SCOPE_KINDS = [
  'USER',
  'REGION',
  'ROLE',
  'COMPANY',
  'JOB',
  'APPLICATION',
] as const;
export type AnswerScopeKind = (typeof ANSWER_SCOPE_KINDS)[number];

export type AnswerScopeRef =
  | { readonly scope: 'USER' }
  | { readonly scope: 'REGION'; readonly regionCode: IsoCountryCode }
  | { readonly scope: 'ROLE'; readonly roleConversationId: Uuid }
  | { readonly scope: 'COMPANY'; readonly companyId: string }
  | { readonly scope: 'JOB'; readonly companyId: string; readonly canonicalJobId: string }
  | {
      readonly scope: 'APPLICATION';
      readonly companyId: string;
      readonly canonicalJobId: string;
      readonly applicationId: Uuid;
    };

export const ANSWER_KINDS = [
  'BOOLEAN',
  'SINGLE_CHOICE',
  'MULTI_CHOICE',
  'SHORT_TEXT',
  'LONG_TEXT',
  'INTEGER',
  'DECIMAL',
  'DATE',
  'YEAR',
  'YEAR_MONTH',
  'MONEY',
] as const;
export type AnswerKind = (typeof ANSWER_KINDS)[number];

export type AnswerValueV1 =
  | { readonly kind: 'BOOLEAN'; readonly value: boolean }
  | { readonly kind: 'SINGLE_CHOICE'; readonly optionCode: string }
  | { readonly kind: 'MULTI_CHOICE'; readonly optionCodes: readonly string[] }
  | { readonly kind: 'SHORT_TEXT' | 'LONG_TEXT'; readonly text: string }
  | { readonly kind: 'INTEGER' | 'DECIMAL'; readonly value: string }
  | { readonly kind: 'DATE'; readonly value: LocalDate }
  | { readonly kind: 'YEAR'; readonly year: number }
  | { readonly kind: 'YEAR_MONTH'; readonly year: number; readonly month: number }
  | {
      readonly kind: 'MONEY';
      readonly shape: 'EXACT';
      readonly amountMinor: string;
      readonly currency: string;
      readonly period: 'HOUR' | 'YEAR' | 'ONE_TIME';
    }
  | {
      readonly kind: 'MONEY';
      readonly shape: 'RANGE';
      readonly minMinor: string;
      readonly maxMinor: string;
      readonly currency: string;
      readonly period: 'HOUR' | 'YEAR' | 'ONE_TIME';
    };

export type AnswerInputBlock =
  | {
      readonly type: 'ANSWER_INPUT';
      readonly answerSchemaVersion: 1;
      readonly answerKind: 'BOOLEAN';
      readonly required: boolean;
    }
  | {
      readonly type: 'ANSWER_INPUT';
      readonly answerSchemaVersion: 1;
      readonly answerKind: 'SINGLE_CHOICE' | 'MULTI_CHOICE';
      readonly required: boolean;
      readonly options: readonly { readonly optionCode: string; readonly label: string }[];
    }
  | {
      readonly type: 'ANSWER_INPUT';
      readonly answerSchemaVersion: 1;
      readonly answerKind: 'SHORT_TEXT' | 'LONG_TEXT';
      readonly required: boolean;
      readonly maxScalars: number;
    }
  | {
      readonly type: 'ANSWER_INPUT';
      readonly answerSchemaVersion: 1;
      readonly answerKind: 'INTEGER';
      readonly required: boolean;
      readonly maxDigits: 38;
    }
  | {
      readonly type: 'ANSWER_INPUT';
      readonly answerSchemaVersion: 1;
      readonly answerKind: 'DECIMAL';
      readonly required: boolean;
      readonly precision: 38;
      readonly maxScale: 6;
    }
  | {
      readonly type: 'ANSWER_INPUT';
      readonly answerSchemaVersion: 1;
      readonly answerKind: 'DATE';
      readonly required: boolean;
      readonly min: LocalDate;
      readonly max: LocalDate;
    }
  | {
      readonly type: 'ANSWER_INPUT';
      readonly answerSchemaVersion: 1;
      readonly answerKind: 'YEAR' | 'YEAR_MONTH';
      readonly required: boolean;
      readonly minYear: number;
      readonly maxYear: number;
    }
  | {
      readonly type: 'ANSWER_INPUT';
      readonly answerSchemaVersion: 1;
      readonly answerKind: 'MONEY';
      readonly required: boolean;
      readonly allowedShapes: readonly ('EXACT' | 'RANGE')[];
      readonly currencies: readonly string[];
      readonly periods: readonly ('HOUR' | 'YEAR' | 'ONE_TIME')[];
    };

export type ChatAnswerCardBlock =
  | {
      readonly type: 'QUESTION_BODY';
      readonly body: string;
      readonly locale: CanonicalBcp47Locale;
    }
  | {
      readonly type: 'JOB_CONTEXT';
      readonly canonicalJobId: string;
      readonly jobTitle: string;
      readonly companyName: string;
    }
  | AnswerInputBlock
  | {
      readonly type: 'MEMORY_SCOPE';
      readonly options: readonly {
        readonly scopeRef: AnswerScopeRef;
        readonly labelCode: AnswerScopeKind;
      }[];
      readonly defaultScope: AnswerScopeKind;
    };

interface ActionCardBase {
  readonly actionId: Uuid;
  readonly revision: DecimalString;
  readonly title: DisplayCode;
  readonly body: DisplayCode;
  readonly risk: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly resource: {
    readonly type:
      | 'MISSION'
      | 'MISSION_STEP'
      | 'CONVERSATION_TURN'
      | 'AUTH_SESSION'
      | 'APPLICATION_INPUT_REQUEST';
    readonly id: Uuid;
    readonly revision: DecimalString;
  };
  readonly payloadDigest: Sha256Digest;
  readonly actions: readonly {
    readonly code: ActionCode;
    readonly labelCode: ActionLabelCode;
    readonly style: 'PRIMARY' | 'SECONDARY' | 'DANGER';
    readonly endpointId: ActionEndpointId;
  }[];
  readonly expiresAt: IsoDateTime | null;
}

type NonChatAnswerActionCard = ActionCardBase & {
  readonly cardType: Exclude<ActionCardType, 'CHAT_ANSWER'>;
  readonly blocks?: never;
};

export type ChatAnswerActionCard = Omit<ActionCardBase, 'resource' | 'actions'> & {
  readonly cardType: 'CHAT_ANSWER';
  readonly resource: {
    readonly type: 'APPLICATION_INPUT_REQUEST';
    readonly id: Uuid;
    readonly revision: DecimalString;
  };
  readonly blocks: readonly [
    Extract<ChatAnswerCardBlock, { type: 'QUESTION_BODY' }>,
    Extract<ChatAnswerCardBlock, { type: 'JOB_CONTEXT' }>,
    AnswerInputBlock,
    Extract<ChatAnswerCardBlock, { type: 'MEMORY_SCOPE' }>,
  ];
  readonly actions: readonly [
    {
      readonly code: 'SUBMIT_ANSWER';
      readonly labelCode: 'SUBMIT_ANSWER';
      readonly style: 'PRIMARY';
      readonly endpointId: 'ACTION_DECISION';
    },
  ];
};

export type ActionCardView = (NonChatAnswerActionCard | ChatAnswerActionCard) &
  (
    | { readonly status: 'PENDING'; readonly outcome: null }
    | {
        readonly status: Exclude<ActionCardStatus, 'PENDING'>;
        readonly outcome: ActionCardOutcome;
      }
  );
