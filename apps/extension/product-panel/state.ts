export type ProductPanelState =
  | Readonly<{ kind: 'HOME' }>
  | Readonly<{ kind: 'AUTOFILL_EXPANDED'; runId: string }>
  | Readonly<{ kind: 'AUTOFILL_STICKY_COLLAPSED'; runId: string }>;

export type ProductPanelTransition =
  | Readonly<{ type: 'PRESENT_RUN'; runId: string }>
  | Readonly<{ type: 'COLLAPSE_AUTOFILL'; runId: string }>
  | Readonly<{ type: 'EXPAND_AUTOFILL'; runId: string }>
  | Readonly<{ type: 'CLEAR_RUN'; runId: string }>;

export type ProductPanelTransitionResult =
  | Readonly<{ ok: true; state: ProductPanelState }>
  | Readonly<{
      ok: false;
      code: 'PRODUCT_PANEL_TRANSITION_INVALID';
      state: ProductPanelState;
    }>;

export type ProductPanelContinueIntent = Readonly<{
  kind: 'CONTINUE_TO_NEXT_PAGE';
  runId: string;
  intentId: string;
}>;

export type ProductPanelIntentResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      code:
        | 'PRODUCT_PANEL_INTENT_REJECTED'
        | 'PRODUCT_PANEL_INTENT_UNAVAILABLE'
        | 'USER_ACTION_REQUIRED'
        | 'SITE_ACCESS_REQUIRED'
        | 'API_UNREACHABLE'
        | 'AUTH_REQUIRED'
        | 'PAGE_NOT_REGISTERED'
        | 'LIVE_WRITE_NOT_AUTHORIZED'
        | 'PROFILE_UNAVAILABLE'
        | 'RECOVERY_REQUIRED'
        | 'CONTINUE_INTENT_ALREADY_CONSUMED'
        | 'CONTINUE_INTENT_REJECTED'
        | 'CONTINUE_INTENT_UNAVAILABLE';
    }>;

type ContinueIntentHandler = (
  intent: ProductPanelContinueIntent,
) => ProductPanelIntentResult | Promise<ProductPanelIntentResult>;

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

function invalidTransition(state: ProductPanelState): ProductPanelTransitionResult {
  return { ok: false, code: 'PRODUCT_PANEL_TRANSITION_INVALID', state };
}

export function reduceProductPanelState(
  state: ProductPanelState,
  transition: ProductPanelTransition,
): ProductPanelTransitionResult {
  if (!SAFE_ID.test(transition.runId)) return invalidTransition(state);
  if (transition.type === 'PRESENT_RUN') {
    if (state.kind !== 'HOME' && state.runId === transition.runId) {
      return { ok: true, state };
    }
    return {
      ok: true,
      state: { kind: 'AUTOFILL_EXPANDED', runId: transition.runId },
    };
  }
  if (state.kind === 'HOME' || state.runId !== transition.runId) {
    return invalidTransition(state);
  }
  if (transition.type === 'CLEAR_RUN') return { ok: true, state: { kind: 'HOME' } };
  if (transition.type === 'COLLAPSE_AUTOFILL' && state.kind === 'AUTOFILL_EXPANDED') {
    return {
      ok: true,
      state: { kind: 'AUTOFILL_STICKY_COLLAPSED', runId: state.runId },
    };
  }
  if (transition.type === 'EXPAND_AUTOFILL' && state.kind === 'AUTOFILL_STICKY_COLLAPSED') {
    return {
      ok: true,
      state: { kind: 'AUTOFILL_EXPANDED', runId: state.runId },
    };
  }
  return invalidTransition(state);
}

function canonicalIntentResult(value: unknown): ProductPanelIntentResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key !== 'string')) return null;
  const okDescriptor = descriptors.ok;
  if (
    okDescriptor === undefined ||
    !okDescriptor.enumerable ||
    !('value' in okDescriptor)
  ) return null;
  const { value: okValue } = okDescriptor;
  if (okValue === true) {
    return ownKeys.length === 1 ? Object.freeze({ ok: true }) : null;
  }
  if (okValue !== false || ownKeys.length !== 2 || !ownKeys.includes('code')) {
    return null;
  }
  const codeDescriptor = descriptors.code;
  if (
    codeDescriptor === undefined ||
    !codeDescriptor.enumerable ||
    !('value' in codeDescriptor) ||
    typeof codeDescriptor['value'] !== 'string' ||
    ![
    'PRODUCT_PANEL_INTENT_REJECTED',
    'PRODUCT_PANEL_INTENT_UNAVAILABLE',
    'USER_ACTION_REQUIRED',
    'SITE_ACCESS_REQUIRED',
    'API_UNREACHABLE',
    'AUTH_REQUIRED',
    'PAGE_NOT_REGISTERED',
    'LIVE_WRITE_NOT_AUTHORIZED',
    'PROFILE_UNAVAILABLE',
    'RECOVERY_REQUIRED',
    'CONTINUE_INTENT_ALREADY_CONSUMED',
    'CONTINUE_INTENT_REJECTED',
    'CONTINUE_INTENT_UNAVAILABLE',
    ].includes(codeDescriptor['value'])
  ) return null;
  const { value: codeValue } = codeDescriptor;
  return Object.freeze({
    ok: false,
    code: codeValue as Exclude<ProductPanelIntentResult, { ok: true }>['code'],
  });
}

export function normalizeProductPanelIntentResult(value: unknown): ProductPanelIntentResult {
  try {
    return canonicalIntentResult(value) ?? Object.freeze({
      ok: false,
      code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE',
    });
  } catch {
    return Object.freeze({ ok: false, code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE' });
  }
}

export function createContinueIntentGate(handler: ContinueIntentHandler): Readonly<{
  dispatch(intent: ProductPanelContinueIntent): Promise<ProductPanelIntentResult>;
}> {
  const consumed = new Set<string>();
  return Object.freeze({
    async dispatch(intent: ProductPanelContinueIntent): Promise<ProductPanelIntentResult> {
      if (
        intent.kind !== 'CONTINUE_TO_NEXT_PAGE' ||
        !SAFE_ID.test(intent.runId) ||
        !SAFE_ID.test(intent.intentId)
      ) return { ok: false, code: 'CONTINUE_INTENT_REJECTED' };
      const key = `${intent.runId}:${intent.intentId}`;
      if (consumed.has(key)) return { ok: false, code: 'CONTINUE_INTENT_ALREADY_CONSUMED' };
      consumed.add(key);
      try {
        return normalizeProductPanelIntentResult(await handler(intent));
      } catch {
        return { ok: false, code: 'CONTINUE_INTENT_UNAVAILABLE' };
      }
    },
  });
}
