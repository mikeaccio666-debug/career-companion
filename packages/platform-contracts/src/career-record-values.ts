export const CAREER_ROLE_FAMILIES = Object.freeze(['swe', 'mle', 'ds', 'da', 'de', 'hw', 'other'] as const);
export type CareerRoleFamily = typeof CAREER_ROLE_FAMILIES[number];
export class CareerRecordInputError extends Error {constructor(){super('The career record could not be confirmed.');}}
const fail=():never=>{throw new CareerRecordInputError();};
export function careerRecordObject(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return fail();
 const d=Object.getOwnPropertyDescriptors(value),allowed=[...required,...optional];
 if(Reflect.ownKeys(d).some(k=>typeof k!=='string'||!allowed.includes(k))||required.some(k=>!d[k])||Object.values(d).some(v=>!('value' in v)||!v.enumerable))return fail();
 return Object.fromEntries(Object.keys(d).map(k=>[k,d[k].value]));
}
export function careerRecordId(value:unknown):string{
 if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))return fail();return value;
}
