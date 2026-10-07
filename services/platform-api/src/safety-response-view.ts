import type { SafetyResponseRenderResult } from '@companion/career-core';

/** Unsafe optional personalization cannot block a fixed resource response. */
export function optionalSafetyUserName(value: unknown): string {
  if (typeof value !== 'string' || Array.from(value).length>100 || Buffer.from(value,'utf8').toString('utf8')!==value
    || /[<>{}\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)) return '';
  return value.trim()?value:'';
}
export function publicSafetyResponse(response: SafetyResponseRenderResult) {
  return Object.freeze({ text:response.text, ...(response.question===undefined?{}:{question:response.question}),
    resourceCard:Object.freeze({ ...response.resourceCard,
      contacts:Object.freeze(response.resourceCard.contacts.map(({ reviewRef: _privateReview, ...contact })=>Object.freeze(contact))) }) });
}
/** Body only: this projection establishes no delivery, question or presentation evidence. */
export function publicSafetyResponseBody(response: SafetyResponseRenderResult) {
  const { question: _privateQuestion, ...body } = publicSafetyResponse(response);
  return Object.freeze(body);
}
