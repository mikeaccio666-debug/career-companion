/**
 * 认得的城市 → 所在国家（2026-09-24），只给 `regions.ts` 印证岗位地点里的两字母码用，从不单独推国家。
 *
 * 只收三类：
 *  · 州码与国家码同形的那几个州里岗位最多的城市——「San Jose, CA」「Atlanta, GA」「Boston, MA」要它们才算美国；
 *  · 那些国家码所在国的大城市——「Berlin, DE」「Toronto, CA」「Bengaluru, IN」要它们才算德国、加拿大、印度；
 *  · Paris（「Paris, FR」）与 Perth（「Perth, WA」的 WA 是西澳，不是华盛顿州）。
 * 别国也有出名同名城市的不收（Cambridge、London、Dublin、Richmond、Vienna、Birmingham）：「Cambridge, CA」可能是
 * 安大略的剑桥，收进来就会读成美国。
 *
 * 小写英文写法，整词比对；带重音的写法（Montréal）认不出。表刻意短：每个字节都进 apply.js 的评审预算，漏收的城市
 * 只是那一题交还用户，不会答错。
 */
export const KNOWN_CITIES: Readonly<Record<string, string>> = {
  US: 'san francisco|bay area|san jose|los angeles|san diego|palo alto|mountain view|menlo park|sunnyvale|santa clara'
    + '|cupertino|redwood city|san mateo|oakland|irvine|santa monica|boston|chicago|atlanta|denver|boulder'
    + '|philadelphia|pittsburgh|raleigh|charlotte|baltimore|arlington|minneapolis|phoenix|nashville|indianapolis|st. louis',
  CA: 'toronto|vancouver|montreal',
  DE: 'berlin|munich',
  IN: 'bangalore|bengaluru|hyderabad',
  IL: 'tel aviv',
  NL: 'amsterdam',
  FR: 'paris',
  AU: 'perth',
};
