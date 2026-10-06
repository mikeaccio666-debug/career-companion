import { describe, expect, it } from 'vitest';
import { parseSubscriptionRenewalRequest, parseSubscriptionChangeQuote, parseSubscriptionRefundQuote,
  parseSubscriptionRefundRequest, parseSubscriptionRefundView, parseSubscriptionOperationRetryRequest, parseSubscriptionRefundAccessReviewRequest } from '../src/subscription-lifecycle.ts';
const id='11111111-1111-4111-8111-111111111111';
const end='2026-10-13T00:00:00.000Z';
describe('versioned subscription operations',()=>{
  it('recovers only an existing operation and requires an explicit revision-bound later-purchase decision',()=>{
    expect(parseSubscriptionOperationRetryRequest({operationId:id})).not.toBeNull();
    expect(parseSubscriptionOperationRetryRequest({operationId:id,amountCents:100})).toBeNull();
    expect(parseSubscriptionOperationRetryRequest({operationId:'missing'})).toBeNull();
    const decision={clientRequestId:id,expectedRevision:3,decision:'KEEP_LATER_PURCHASE'};
    expect(parseSubscriptionRefundAccessReviewRequest(decision)).not.toBeNull();
    for(const value of [{...decision,decision:'TERMINATE'},{...decision,expectedRevision:0},{...decision,subscriptionId:id}])
      expect(parseSubscriptionRefundAccessReviewRequest(value)).toBeNull();
  });
  it('requires explicit renewal intent and the exact reviewed subscription period',()=>{
    const input={clientRequestId:id,subscriptionId:id,expectedPeriodEndsAt:end,renew:false};
    expect(parseSubscriptionRenewalRequest(input)).not.toBeNull();
    for(const value of [{...input,renew:'false'},{...input,expectedPeriodEndsAt:null},{...input,immediate:true}])
      expect(parseSubscriptionRenewalRequest(value)).toBeNull();
  });
  it('does not accept negative, fractional, excessive or hidden refund amounts',()=>{
    const input={clientRequestId:id,invoiceReference:'in_fixture',amountCents:100,reason:'SERVICE_ISSUE'};
    expect(parseSubscriptionRefundRequest(input)).not.toBeNull();
    for(const amountCents of [0,-1,0.5,Number.MAX_SAFE_INTEGER])expect(parseSubscriptionRefundRequest({...input,amountCents})).toBeNull();
    expect(parseSubscriptionRefundRequest({...input,paymentIntentId:'pi_other'})).toBeNull();
  });
  it('checks refund quote arithmetic before displaying a refundable balance',()=>{
    const quote={schemaVersion:1,invoiceReference:'in_fixture',subscriptionId:id,policyVersion:'s5-period-end-reviewed-refund-v2',
      paidCents:1000,refundedCents:200,pendingCents:100,refundableCents:700,currency:'usd',currentPeriodEndsAt:end,
      fullRefundTerminates:true,createdAt:'2026-09-13T00:00:00.000Z'};
    expect(parseSubscriptionRefundQuote(quote)).not.toBeNull();
    expect(parseSubscriptionRefundQuote({...quote,refundableCents:1000})).toBeNull();
    expect(parseSubscriptionRefundQuote({...quote,pendingCents:900})).toBeNull();
  });
  it('requires full-refund termination to remain visible as a separate unfinished step',()=>{
    const refund={id,ownerId:id,subscriptionId:id,invoiceReference:'in_fixture',amountCents:1000,currency:'usd',reason:'SERVICE_ISSUE',
      state:'SUCCEEDED',revision:3,reviewReason:null,accessEffect:'TERMINATION_PENDING',createdAt:'2026-09-13T00:00:00.000Z',updatedAt:end};
    expect(parseSubscriptionRefundView(refund)).not.toBeNull();
    expect(parseSubscriptionRefundView({...refund,state:'REQUESTED',accessEffect:'TERMINATED'})).toBeNull();
    expect(parseSubscriptionRefundView({...refund,accessEffect:'UNKNOWN'})).toBeNull();
  });
  it('does not present future downgrades as an immediate charge or unreviewed negative credit',()=>{
    const quote={schemaVersion:1,id,subscriptionId:id,currentOfferId:id,targetOfferId:'22222222-2222-4222-8222-222222222222',kind:'DOWNGRADE',amountDueCents:0,currency:'usd',
      effectiveAt:end,expiresAt:'2026-09-13T00:10:00.000Z',policyVersion:'s5-period-end-reviewed-refund-v2'};
    expect(parseSubscriptionChangeQuote(quote)).not.toBeNull();
    expect(parseSubscriptionChangeQuote({...quote,amountDueCents:100})).toBeNull();
    expect(parseSubscriptionChangeQuote({...quote,kind:'UPGRADE',amountDueCents:-1})).toBeNull();
  });
});
