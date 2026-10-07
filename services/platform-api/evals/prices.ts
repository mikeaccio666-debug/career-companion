/** Research candidates only: these do not constitute human budget/configuration approval. */
export const PROPOSED_EVAL_PRICES = Object.freeze([
  Object.freeze({
    id: 'openai-luna-standard-global-20261007', tier: 'development' as const,
    provider: 'openai', model: 'gpt-6-luna', checkedAt: '2026-10-07T07:01:13.000Z',
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-6-luna',
    pricingUrl: 'https://developers.openai.com/api/docs/pricing',
    maxContextInputTokens: 1_050_000, maxOutputTokens: 2048,
    inputMicroUsdPerMillion: 250_000, outputMicroUsdPerMillion: 750_000,
  }),
  Object.freeze({
    id: 'openai-sol-standard-global-20261007', tier: 'formal' as const,
    provider: 'openai', model: 'gpt-6.1-sol', checkedAt: '2026-10-07T07:01:13.000Z',
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol',
    pricingUrl: 'https://developers.openai.com/api/docs/pricing',
    maxContextInputTokens: 1_050_000, maxOutputTokens: 2048,
    inputMicroUsdPerMillion: 5_000_000, outputMicroUsdPerMillion: 15_000_000,
  }),
]);

// Input uses the maximum long-context Standard tariff, including cache writes;
// aggregate usage cannot prove discounts. Regional/Fast/other tariffs need a
// separately reviewed snapshot and actual request configuration before live use.
export const PROPOSED_PRICE_STATUS = 'research_only_not_approved' as const;
