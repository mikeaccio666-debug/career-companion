import { KNOWN_CITIES } from './knownCities';

/**
 * The full names a short region code may stand for in a place-style value
 * ("Seattle, WA", "Toronto, ON", "Berlin, DE"). A code expands only to the
 * complete names listed here; nothing else is an alias, and no token ever
 * matches a longer word by prefix ("AU" is not "Austell").
 *
 * Postal codes collide across countries ("DE" is Delaware and Germany), so a
 * code may expand to several names; the caller compares each against the exact
 * option segment and treats more than one agreeing option as ambiguous.
 */
const SUBDIVISIONS: Readonly<Record<string, string>> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia', PR: 'Puerto Rico',
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut',
  ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',
};

const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  USA: 'United States', UK: 'United Kingdom', UAE: 'United Arab Emirates',
};

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });

/** ISO 3166-1 alpha-2 → English country name, or null when the code is not a country. */
export function countryName(code: string): string | null {
  try {
    const name = countryNames.of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

/**
 * 一个 ISO 3166-1 alpha-2 国家码在申请表下拉里可能的写法，按「最像选项原文」排序：
 * Intl 的英文全名在前（"United States"），常见别名随后（"United States of America"、"USA"）。
 * 不是国家码（或 Intl 不认）→ 空。给填写候选用，与 `regionNames` 的小写比对集是两回事。
 */
const COUNTRY_DISPLAY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  US: ['United States of America', 'USA', 'U.S.', 'U.S.A.'],
  GB: ['UK', 'Great Britain', 'Britain'],
  AE: ['UAE'],
  KR: ['Korea, Republic of', 'Republic of Korea'],
  RU: ['Russian Federation'],
  VN: ['Viet Nam'],
  CZ: ['Czech Republic'],
  TW: ['Taiwan, Province of China'],
  NL: ['The Netherlands', 'Holland'],
};

export function countryDisplayNames(token: string): readonly string[] {
  const code = token.trim().toUpperCase();
  if (!/^[A-Z]{2}$/u.test(code)) return [];
  const name = countryName(code);
  if (name === null) return [];
  return [name, ...(COUNTRY_DISPLAY_ALIASES[code] ?? [])];
}

/**
 * 同一个国家在德文、法文、西文、意文、葡文、荷文下拉里的写法（2026-09-28 通用路：Hetzner 的「Land」下拉写的是
 * 「Deutschland」「Vereinigte Staaten」）。只作英文名之后的候选：英文页上它们撞不上任何一项，不改变那边的结果。
 * 读不到 Intl（或不是国家码）就是空。
 */
const LOCAL_COUNTRY_LANGUAGES = ['de', 'fr', 'es', 'it', 'pt', 'nl'] as const;
const localCountryNamers = new Map<string, Intl.DisplayNames | null>();

export function countryLocalNames(token: string): readonly string[] {
  const code = token.trim().toUpperCase();
  if (!/^[A-Z]{2}$/u.test(code) || countryName(code) === null) return [];
  const names: string[] = [];
  for (const language of LOCAL_COUNTRY_LANGUAGES) {
    let namer = localCountryNamers.get(language);
    if (namer === undefined) {
      try {
        namer = new Intl.DisplayNames([language], { type: 'region', fallback: 'none' });
      } catch {
        namer = null;
      }
      localCountryNamers.set(language, namer);
    }
    const name = namer?.of(code);
    if (typeof name === 'string' && name !== '' && name !== code) names.push(name);
  }
  return [...new Set(names)];
}

/** 美国州／加拿大省的两字母码 → 全名（"AL" → "Alabama"）；不是就 null。 */
export function subdivisionName(token: string): string | null {
  return SUBDIVISIONS[token.trim().toUpperCase()] ?? null;
}

/** Lower-cased full names the code may stand for; empty when the token is not a known code. */
export function regionNames(token: string): ReadonlySet<string> {
  const code = token.trim().toUpperCase();
  if (!/^[A-Z]{2,3}$/u.test(code)) return new Set();
  const names = [SUBDIVISIONS[code], COUNTRY_ALIASES[code], code.length === 2 ? countryName(code) : null];
  return new Set(names.flatMap((name) => (name ? [name.toLowerCase()] : [])));
}

const COUNTRY_ALIAS_CODES: Readonly<Record<string, string>> = {
  'usa': 'US', 'u.s.': 'US', 'u.s.a.': 'US', 'united states of america': 'US',
  'uk': 'GB', 'u.k.': 'GB', 'great britain': 'GB', 'england': 'GB', 'scotland': 'GB', 'wales': 'GB',
  'northern ireland': 'GB', 'uae': 'AE',
};
const CANADIAN_SUBDIVISIONS: ReadonlySet<string> = new Set([
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
]);

/** 美国州／加拿大省的码属于哪一国（US／CA）；不是州／省码就 null。 */
function subdivisionCountry(code: string): string | null {
  return SUBDIVISIONS[code] === undefined ? null : CANADIAN_SUBDIVISIONS.has(code) ? 'CA' : 'US';
}

/**
 * 现行的国家码：Intl 认得，而且不是已废码的别名（2026-09-24）。Intl 把 FX、UK、SU、YU、NH 也叫成 France、
 * United Kingdom、Russia、Serbia、Vanuatu；反查国名时从前后写的覆盖先写的，「Paris, France」解成了 FX。
 */
function isCountryCode(code: string): boolean {
  return countryName(code) !== null && Intl.getCanonicalLocales(`und-${code}`)[0] === `und-${code}`;
}

let countryTable: ReadonlyMap<string, string> | null = null;
function countryNameTable(): ReadonlyMap<string, string> {
  if (countryTable !== null) return countryTable;
  const table = new Map<string, string>();
  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const code = String.fromCharCode(first, second);
      if (isCountryCode(code)) table.set(countryName(code)!.toLowerCase(), code);
    }
  }
  countryTable = table;
  return table;
}

/** 整词出现的位置（从 `from` 起找）；没有就 -1。 */
function wordIndex(haystack: string, needle: string, from = 0): number {
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return -1;
    const before = at === 0 ? '' : haystack[at - 1]!;
    const after = haystack[at + needle.length] ?? '';
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return at;
    from = at + 1;
  }
}

function wordIn(haystack: string, needle: string): boolean {
  return wordIndex(haystack, needle) >= 0;
}

/**
 * 按全名点到的美国州／加拿大省（2026-09-24）：它们属于哪一国（US／CA）。两字母码不在这里认——CA、DE、IN 与国家码同形，
 * ID、OR、ME 又是常用词，认不认由调用方定（岗位地点认，工作授权的题面不认）。
 *
 * `rest` 是挖掉这些全名之后的小写文字，国名只在它里面找：「New Mexico」「New Jersey」里的 Mexico、Jersey 不是国名。
 * 全名本身就是国名的（Georgia、Puerto Rico）说不清是州还是国家：不挖，报 `ambiguous`，国名那一遍照样认到它。
 */
export function subdivisionsNamed(text: string): Readonly<{ countries: ReadonlySet<string>; rest: string; ambiguous: boolean }> {
  let rest = text.normalize('NFKC').toLowerCase();
  const countries = new Set<string>();
  let ambiguous = false;
  for (const [code, name] of Object.entries(SUBDIVISIONS)) {
    const lower = name.toLowerCase();
    let at = wordIndex(rest, lower);
    if (at < 0) continue;
    countries.add(subdivisionCountry(code)!);
    if (countryNameTable().has(lower)) {
      ambiguous = true;
      continue;
    }
    for (; at >= 0; at = wordIndex(rest, lower, at + 1)) {
      rest = rest.slice(0, at) + ' '.repeat(lower.length) + rest.slice(at + lower.length);
    }
  }
  return { countries, rest, ambiguous };
}

/** 名字写出来的地方各在哪一国：国名、常见别名、美国州与加拿大省的全名（州／省算它所在的国家）。两字母码不在这里认。 */
function namedRegions(text: string): Set<string> {
  const named = subdivisionsNamed(text);
  const { rest } = named;
  const found = new Set(named.countries);
  if (rest.trim() === '') return found;
  for (const [name, code] of countryNameTable()) {
    if (name.length >= 4 && wordIn(rest, name)) found.add(code);
  }
  for (const [alias, code] of Object.entries(COUNTRY_ALIAS_CODES)) {
    if (wordIn(rest, alias)) found.add(code);
  }
  return found;
}

/** 单独成段的两字母大写码，后面可以跟美国邮编（「NY 10001」）；段由逗号、分号、斜杠、竖线、括号、破折号隔开。 */
const PLACE_CODE = /^\s*([A-Z]{2})(?: \d{5})?\s*$/u;

/**
 * 岗位地点文本 → **恰好一个**国家码；解不出、或解出两个以上，一律 null（P1-7）。这个码拿去回答工作授权题，2026-09-24 起
 * 资料里没有那一国的记录时还会按默认答——推错一国就是拿错一条记录，所以宁可交还用户，不可猜。
 *
 * 国家的英文名（只认现行码）、几个常见别名（USA / UK / England…）、美国州与加拿大省的全名直接算。"Remote"、"EMEA"、
 * "Berlin or Paris" 解不出；"Georgia" 既是国家又是州，也解不出。
 *
 * 两字母码从严（2026-09-24）。只认单独成段的大写（「Remote OR Hybrid」里的 OR 不算），而且：
 *  · 只可能是州／省的码（TX、NY、WA、ON、BC）直接算；
 *  · 与国家码同形的（CA、DE、IN、GA、IL、NL、PE、SK… 共 32 个）和纯国家码（FR）只约束——答案得是它的一种读法，
 *    要靠同一地点里别的码（「Remote - CA, NY, WA」的 NY、WA）或认得的城市（`knownCities.ts`：「San Jose, CA」是
 *    美国，「Berlin, DE」「Toronto, CA」是德国、加拿大）定下来。定不下来就解不出（「Remote - IN」；不认得的
 *    「Wilmington, DE」也一样）；
 *  · 「…, ON, CA」「…, DE, US」两个码连着收尾时，末一个是国家码（结构化地址的 region、country）；
 *  · 名字写出了国家或州时，码只能附和它（「Chennai, TN, India」的 TN 读成 Tennessee，解不出）；没写出时，读到了码，
 *    认得的城市就不能在别国（「Paris, TX」「Perth, WA」解不出）。
 * 认得的城市只拿来印证，不单独推国家（「Berlin」解不出）。
 *
 * `placeCodes` 为 false（工作授权的题面）时两字母码与城市都不看，只认名字：题面上的 CA、DE、IN 说不清是州还是国家。
 */
export function inferRegionCode(text: string, placeCodes = true): string | null {
  const found = namedRegions(text);
  if (!placeCodes) return found.size === 1 ? [...found][0]! : null;
  const plain = text.normalize('NFKC');
  const pieces = plain.split(/[,;/|()–—-]/u);
  const country = /(?:^|,)\s*[A-Z]{2}\s*,\s*([A-Z]{2})\s*$/u.exec(plain)?.[1];
  if (country !== undefined && isCountryCode(country)) {
    found.add(country);
    pieces.pop();
  }
  // 名字（或收尾的国家码）写出了国家：码只能附和它，城市不看。没写出：只可能是州／省的码直接算；与国家码同形的码
  // 只约束（答案得是它的一种读法），要靠别的码或认得的城市定下来；读到了码，认得的城市也不能在别国。
  const named = found.size > 0;
  const lower = plain.toLowerCase();
  const cities = named ? [] : Object.keys(KNOWN_CITIES).filter((code) =>
    KNOWN_CITIES[code]!.split('|').some((city) => wordIn(lower, city)));
  const options: string[][] = [];
  for (const match of pieces.map((piece) => PLACE_CODE.exec(piece))) {
    const code = match?.[1];
    if (code === undefined) continue;
    const state = subdivisionCountry(code);
    if (!named && isCountryCode(code)) options.push([state ?? code, code]);
    else if (state !== null) found.add(state);
    else continue;
    for (const city of cities) found.add(city);
  }
  const only = found.size === 1 ? [...found][0]! : null;
  return only !== null && options.every((readings) => readings.includes(only)) ? only : null;
}

/**
 * 国名的常见写法与旧名 → 国家码（2026-09-28，`countryNamed` 用）：Intl 的英文名之外，申请表下拉里与用户资料里常见的那几种。
 * 与 `COUNTRY_ALIAS_CODES` 分开放：那一张给岗位地点推国家（从严），这一张只在「整段就是一个国名」时查。键都是
 * `countryKey` 归一过的（小写、去重音、弯引号换直引号、去掉开头的 the）。
 */
const COUNTRY_NAME_ALIASES: Readonly<Record<string, string>> = {
  'us': 'US', 'u.s': 'US', 'u.s.': 'US', 'usa': 'US', 'u.s.a': 'US', 'u.s.a.': 'US', 'united states of america': 'US',
  'united states (us)': 'US', 'united states (usa)': 'US',
  'uk': 'GB', 'u.k': 'GB', 'u.k.': 'GB', 'great britain': 'GB', 'britain': 'GB', 'england': 'GB', 'scotland': 'GB', 'wales': 'GB',
  'northern ireland': 'GB', 'united kingdom of great britain and northern ireland': 'GB', 'united kingdom (uk)': 'GB',
  'uae': 'AE', 'u.a.e.': 'AE',
  'republic of korea': 'KR', 'korea, republic of': 'KR', 'korea, south': 'KR', 'korea (south)': 'KR',
  'korea, democratic people\'s republic of': 'KP', 'democratic people\'s republic of korea': 'KP',
  'russian federation': 'RU', 'viet nam': 'VN', 'czech republic': 'CZ', 'holland': 'NL',
  'turkey': 'TR', 'turkiye': 'TR', 'mainland china': 'CN', 'people\'s republic of china': 'CN', 'china, people\'s republic of': 'CN', 'prc': 'CN',
  'hong kong': 'HK', 'hong kong sar': 'HK', 'hong kong, china': 'HK', 'macau': 'MO', 'macao': 'MO', 'macao sar': 'MO', 'macau sar': 'MO',
  'taiwan, province of china': 'TW', 'ivory coast': 'CI', 'burma': 'MM', 'myanmar': 'MM', 'swaziland': 'SZ', 'cabo verde': 'CV',
  'macedonia': 'MK', 'republic of north macedonia': 'MK', 'iran, islamic republic of': 'IR', 'syrian arab republic': 'SY',
  'lao people\'s democratic republic': 'LA', 'lao pdr': 'LA', 'bolivia, plurinational state of': 'BO',
  'venezuela, bolivarian republic of': 'VE', 'tanzania, united republic of': 'TZ', 'moldova, republic of': 'MD',
  'holy see': 'VA', 'vatican': 'VA', 'brunei darussalam': 'BN', 'palestine': 'PS', 'state of palestine': 'PS',
  'democratic republic of the congo': 'CD', 'congo, democratic republic of the': 'CD', 'dr congo': 'CD', 'drc': 'CD',
  'republic of the congo': 'CG', 'congo-brazzaville': 'CG', 'congo-kinshasa': 'CD',
};

/** 国名比对用的写法：小写、去重音、弯引号换直引号、空白归一、去掉开头的 the。 */
function countryKey(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[’‘`]/gu, "'").toLowerCase()
    .replace(/\s+/gu, ' ').trim().replace(/^the /u, '');
}

let subdivisionKeyTable: ReadonlySet<string> | null = null;
function subdivisionNameKeys(): ReadonlySet<string> {
  subdivisionKeyTable ??= new Set(Object.values(SUBDIVISIONS).map(countryKey));
  return subdivisionKeyTable;
}

let countryKeyTable: ReadonlyMap<string, string> | null = null;
function countryKeys(): ReadonlyMap<string, string> {
  if (countryKeyTable !== null) return countryKeyTable;
  const table = new Map<string, string>();
  for (const [name, code] of countryNameTable()) table.set(countryKey(name), code);
  countryKeyTable = table;
  return table;
}

/**
 * 一整段文字说的是哪一国（2026-09-28，浮层「选一个」给选项排先后用）：英文国名（Intl 的写法；重音、弯引号、开头的 the
 * 不计）、常见别名与旧名（USA、U.S.、United States of America、UK、Great Britain、England、Holland、Burma……），或者
 * 一个不与美国州／加拿大省同形的两字母国家码（US、GB、FR；CA、DE、IN 说不清，不认）。只认整段——「United States - Remote」
 * 「New Mexico」「Georgia」都不算。认不出就 null。
 */
export function countryNamed(text: string): string | null {
  const key = countryKey(text);
  if (key === '') return null;
  const alias = COUNTRY_NAME_ALIASES[key];
  if (alias !== undefined) return alias;
  // 同名的州（Georgia）说不清是哪一个，不认。
  const named = countryKeys().get(key);
  if (named !== undefined) return subdivisionNameKeys().has(key) ? null : named;
  if (/^[a-z]{2}$/u.test(key)) {
    const code = key.toUpperCase();
    if (SUBDIVISIONS[code] === undefined && isCountryCode(code)) return code;
  }
  return null;
}

/** 文本里提到任何国家 / 州省了吗——工作授权题点名了地方，就不按岗位地点推。 */
export function mentionsAnyRegion(text: string): boolean {
  return namedRegions(text).size > 0 || Object.keys(SUBDIVISIONS).some((code) => wordIn(text.normalize('NFKC'), code));
}
