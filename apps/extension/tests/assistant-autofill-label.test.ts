import {it,expect} from 'vitest';
import {autofillFieldLabel} from '../assistant/features/autofill/field-label';
import {APPLICATION_PROFILE_FIELD_KEYS} from '@edaix/contracts';
it('labels every approved profile field and gives unknown fields a position-independent label',()=>{
  const t=((key:string)=>key) as never;
  for(const key of APPLICATION_PROFILE_FIELD_KEYS) expect(autofillFieldLabel(t,key,6)).not.toContain('申请项');
  expect(autofillFieldLabel(t,'constructor',1)).toBe(autofillFieldLabel(t,'unknown',1));
  expect(autofillFieldLabel(t,'unknown',1)).toBe(autofillFieldLabel(t,'unknown',8));
});
