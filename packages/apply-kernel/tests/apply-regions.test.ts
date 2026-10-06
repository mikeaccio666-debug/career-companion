import { describe, expect, it } from 'vitest';

import { countryNamed, inferRegionCode, mentionsAnyRegion } from '../src/dict/regions';

/**
 * 岗位地点 → 恰好一个国家码（P1-7）。解不出、解出两个以上、国家名与州名撞了，一律 null：
 * 这个码会用来替用户向雇主陈述法律资格，宁可不答，不可猜。
 */
describe('岗位地点解成恰好一个国家', () => {
  it('国家英文名、常见别名', () => {
    expect(inferRegionCode('San Francisco, California, United States')).toBe('US');
    expect(inferRegionCode('London, UK')).toBe('GB');
    expect(inferRegionCode('Remote - USA')).toBe('US');
    expect(inferRegionCode('Manchester, England')).toBe('GB');
    expect(inferRegionCode('Toronto, ON, Canada')).toBe('CA');
    expect(inferRegionCode('Berlin, Germany')).toBe('DE');
    expect(inferRegionCode('Dubai, UAE')).toBe('AE');
  });

  it('只有州 / 省：美国州码与州名归美国，加拿大省归加拿大', () => {
    expect(inferRegionCode('San Francisco, CA')).toBe('US');
    expect(inferRegionCode('Austin, Texas')).toBe('US');
    expect(inferRegionCode('New York, NY 10001')).toBe('US');
    expect(inferRegionCode('Vancouver, BC')).toBe('CA');
    expect(inferRegionCode('Remote - TX')).toBe('US');
  });

  it('解不出就 null：远程、大区、两个国家、国家名与州名撞了、空串', () => {
    for (const text of ['Remote', 'EMEA', 'Berlin or Paris', 'United States / Canada', 'Atlanta, Georgia', '', '   ']) {
      expect(inferRegionCode(text), text).toBeNull();
    }
  });

  it('国家名只按整词认：Chad / Jordan 这类名字不从别的词里抠出来', () => {
    expect(inferRegionCode('Chadwick Street, Manchester')).toBeNull();
    expect(inferRegionCode('Jordanville')).toBeNull();
  });

  // 2026-09-24：州名里带着的国名（New Mexico 里的 Mexico、New Jersey 里的 Jersey）不算那个国家——从前这两个州的岗位
  // 一律解不出国家。Georgia 本身就是国名，照旧说不清。
  it('州名里带着的国名不算：New Mexico 是美国，不是墨西哥', () => {
    expect(inferRegionCode('Albuquerque, New Mexico, United States')).toBe('US');
    expect(inferRegionCode('Albuquerque, New Mexico')).toBe('US');
    expect(inferRegionCode('Newark, New Jersey')).toBe('US');
    expect(inferRegionCode('Mexico City, Mexico')).toBe('MX');
    expect(inferRegionCode('Atlanta, Georgia')).toBeNull();
  });

  // 题面（工作授权题）不认两字母州／省码：CA、DE、IN 与国家码同形，ID、OR、ME 又是常用词。岗位地点照旧认。
  it('不认两字母码的那一种：只有州码时解不出，州名照旧算', () => {
    expect(inferRegionCode('Are you authorized to work in CA?', false)).toBeNull();
    expect(inferRegionCode('Remote - IN', false)).toBeNull();
    expect(inferRegionCode('Are you authorized to work in California?', false)).toBe('US');
    expect(inferRegionCode('Are you authorized to work in Canada?', false)).toBe('CA');
    expect(inferRegionCode('San Francisco, CA')).toBe('US');
  });
});

/**
 * 两字母码从严（2026-09-24）。#108 起岗位国家推错了，就是拿错一国的工作授权记录答题，或者该写明「你的资料里没有这一国的
 * 记录」时拿别国的记录答了。从前「City, XX」一律先当美国州码认：「Berlin, DE」成了 Delaware → 美国，「Toronto, CA」
 * 成了加州。美国州／加拿大省的码里有 32 个与现行国家码同形（CA、DE、IN、GA、IL、NL、PE、SK…；NH 在 Intl 里还叫
 * Vanuatu，那是已废的旧码）。
 *
 * 现在：与国家码同形的码、以及纯国家码（FR），要地点别处印证——认得的城市、同一地点里只可能是美国州的码，或「…, ON, CA」
 * 这样收尾的国家码；印证不了、或者指向两个国家，一律解不出，交还用户。不与国家码同形的州码、省码（TX、NY、ON、BC）照旧
 * 直接算，只是认得的城市在别国时同样解不出。
 */
describe('岗位地点里的两字母码：地点别处印证了才算（2026-09-24）', () => {
  it('Berlin, DE 是德国：认得的外国城市胜过同码的州（Delaware）', () => {
    expect(inferRegionCode('Berlin, DE')).toBe('DE');
    expect(inferRegionCode('Toronto, CA')).toBe('CA');
    expect(inferRegionCode('Amsterdam, NL')).toBe('NL');
    expect(inferRegionCode('Bengaluru, IN')).toBe('IN');
    expect(inferRegionCode('Tel Aviv, IL')).toBe('IL');
  });

  it('Paris, FR 是法国；Paris, TX 解不出：城市在法国、TX 是美国的州，两边对不上', () => {
    expect(inferRegionCode('Paris, FR')).toBe('FR');
    expect(inferRegionCode('Paris, TX')).toBeNull();
    // 州写全名照旧是美国：全名不会是别国的码，城市不来抢。
    expect(inferRegionCode('Paris, Texas')).toBe('US');
    expect(inferRegionCode('Austin, TX')).toBe('US');
  });

  it('Toronto, ON、Vancouver, BC 照旧是加拿大；「…, ON, CA」两个码收尾时末一个是国家', () => {
    expect(inferRegionCode('Toronto, ON')).toBe('CA');
    expect(inferRegionCode('Vancouver, BC')).toBe('CA');
    expect(inferRegionCode('Toronto, ON, CA')).toBe('CA');
    expect(inferRegionCode('Wilmington, DE, US')).toBe('US');
    expect(inferRegionCode('Berlin, BE, DE')).toBe('DE');
  });

  it('San Jose, CA 是美国：认得的美国城市、或同一地点里只可能是美国州的码印证了州码；印证不了就解不出', () => {
    expect(inferRegionCode('San Jose, CA')).toBe('US');
    expect(inferRegionCode('San Jose, CA 95113')).toBe('US');
    expect(inferRegionCode('Remote - CA, NY, WA')).toBe('US');
    // 不认得的城市：Delaware 还是德国说不清，宁可交还用户。
    expect(inferRegionCode('Wilmington, DE')).toBeNull();
    expect(inferRegionCode('Remote - CA')).toBeNull();
    expect(inferRegionCode('Remote - IN')).toBeNull();
    // TN 读得成 Tennessee、IN 收尾是印度：地点自己打架，不猜。
    expect(inferRegionCode('Chennai, TN, IN')).toBeNull();
  });

  it('Georgia 说不清是州还是国家；GA 也要印证', () => {
    expect(inferRegionCode('Georgia')).toBeNull();
    expect(inferRegionCode('Remote - GA')).toBeNull();
    expect(inferRegionCode('Atlanta, GA')).toBe('US');
  });

  it('Remote - Estonia 是爱沙尼亚：国名照旧直接算', () => {
    expect(inferRegionCode('Remote - Estonia')).toBe('EE');
    expect(inferRegionCode('Tallinn, Estonia')).toBe('EE');
  });

  it('两字母码只认单独成段的大写：Remote OR Hybrid 里的 OR 不是 Oregon', () => {
    expect(inferRegionCode('Remote OR Hybrid')).toBeNull();
    expect(inferRegionCode('Portland, OR')).toBe('US');
  });

  it('认得的城市只用来印证两字母码，不单独推国家', () => {
    expect(inferRegionCode('Berlin')).toBeNull();
    expect(inferRegionCode('San Francisco')).toBeNull();
  });
});

describe('国名解成现行的国家码（2026-09-24）', () => {
  // Intl 把已废的码也叫成同一个名字（FX、UK、SU、YU 分别叫 France、United Kingdom、Russia、Serbia），国名反查表从前
  // 后写的覆盖先写的：「Paris, France」解成 FX，谁的记录都对不上。
  it('France 是 FR 不是 FX，United Kingdom 是 GB 不是 UK，Russia 是 RU，Serbia 是 RS', () => {
    expect(inferRegionCode('Paris, France')).toBe('FR');
    expect(inferRegionCode('London, United Kingdom')).toBe('GB');
    expect(inferRegionCode('Moscow, Russia')).toBe('RU');
    expect(inferRegionCode('Belgrade, Serbia')).toBe('RS');
  });
});

describe('题目有没有提到任何地方', () => {
  it('提到国家、别名或州就算', () => {
    expect(mentionsAnyRegion('Are you authorized to work in the United States?')).toBe(true);
    expect(mentionsAnyRegion('Will you require sponsorship to work in Japan?')).toBe(true);
    expect(mentionsAnyRegion('Are you eligible to work in the UK?')).toBe(true);
    expect(mentionsAnyRegion('Do you live in California?')).toBe(true);
  });

  it('「这个岗位所在的国家」「在 Cloudflare 工作」都没提到地方', () => {
    expect(mentionsAnyRegion('Are you currently legally authorized to work in the country in which this job is based?')).toBe(false);
    expect(mentionsAnyRegion('Do you now or will you in the future require immigration sponsorship to work at Cloudflare?')).toBe(false);
    expect(mentionsAnyRegion('Do you require visa sponsorship?')).toBe(false);
  });
});

describe('一整段文字说的是哪一国（2026-09-28，浮层给选项排先后用）', () => {
  it('常见写法与别名都认成同一国', () => {
    for (const text of ['United States', 'USA', 'US', 'U.S.', 'U.S.A.', 'United States of America', 'the United States']) {
      expect(countryNamed(text), text).toBe('US');
    }
    for (const text of ['United Kingdom', 'UK', 'U.K.', 'Great Britain', 'Britain', 'England', 'United Kingdom of Great Britain and Northern Ireland']) {
      expect(countryNamed(text), text).toBe('GB');
    }
    expect(countryNamed('Korea, Republic of')).toBe('KR');
    expect(countryNamed('South Korea')).toBe('KR');
    expect(countryNamed("Korea, Democratic People's Republic of")).toBe('KP');
    expect(countryNamed('The Netherlands')).toBe('NL');
    expect(countryNamed('Holland')).toBe('NL');
    expect(countryNamed('Turkey')).toBe('TR');
    expect(countryNamed('Türkiye')).toBe('TR');
    expect(countryNamed("Cote d'Ivoire")).toBe('CI');
    expect(countryNamed('Côte d’Ivoire')).toBe('CI');
    expect(countryNamed('Viet Nam')).toBe('VN');
    expect(countryNamed('Russian Federation')).toBe('RU');
    expect(countryNamed('Czech Republic')).toBe('CZ');
    expect(countryNamed('Hong Kong')).toBe('HK');
    expect(countryNamed('Burma')).toBe('MM');
    expect(countryNamed('France')).toBe('FR');
    expect(countryNamed('FR')).toBe('FR');
  });

  it('只认整段；说不清的不认', () => {
    expect(countryNamed('United States - Remote')).toBeNull();
    expect(countryNamed('Ukraine')).toBe('UA');
    expect(countryNamed('New Mexico')).toBeNull();
    // 与州同名、与州码同形：说不清。
    expect(countryNamed('Georgia')).toBeNull();
    expect(countryNamed('CA')).toBeNull();
    expect(countryNamed('DE')).toBeNull();
    expect(countryNamed('Korea')).toBeNull();
    expect(countryNamed('Other')).toBeNull();
    expect(countryNamed('')).toBeNull();
  });
});
