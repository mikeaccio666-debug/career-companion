// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  createNearbyPostingReader,
  detailPageUrl,
  readJobCardFromPage,
  readJobSummaryFromPage,
  readPostingLocationNearby,
} from '../lib/jobCardFromPage';

/**
 * 卡片只认标准，不认任何一家的 DOM（RULE-GLOBAL-DOM-RULE-BOUNDARY）。
 *
 * 夹具是 2026-09-17 实测两家申请页的形状：Ashby 带完整 JobPosting，
 * Greenhouse 没有 ld+json、只有 Open Graph。
 */

function page(html: string): Document {
  const doc = document.implementation.createHTMLDocument();
  doc.head.innerHTML = html;
  return doc;
}

const ld = (value: unknown): string =>
  `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

// jobs.ashbyhq.com/notion/…/application，2026-09-17 实测。
const ASHBY = ld({
  '@type': 'JobPosting',
  title: 'Business Systems Analyst',
  hiringOrganization: { '@type': 'Organization', name: 'Notion' },
  jobLocation: {
    '@type': 'Place',
    address: {
      '@type': 'PostalAddress',
      addressLocality: 'San Francisco',
      addressRegion: 'California',
      addressCountry: 'United States',
    },
  },
});

// job-boards.greenhouse.io/discord/jobs/…，2026-09-17 实测：没有 ld+json。
const GREENHOUSE = `
  <meta property="og:title" content="Senior Software Engineer, Data Platform">
  <meta property="og:description" content="San Francisco Bay Area ">
`;

describe('带 JobPosting 的页面', () => {
  it('三项都读出来，地址拼成一行人话', () => {
    expect(readJobCardFromPage(page(ASHBY))).toEqual({
      title: 'Business Systems Analyst',
      company: 'Notion',
      location: 'San Francisco, California, United States',
    });
  });

  it('不取街道与邮编——卡片问的是「在哪个城市」', () => {
    // 街道门牌对那个问题没帮助，而且那是雇主办公地址，摆在用户面板上没有理由。
    const doc = page(ld({
      '@type': 'JobPosting', title: 'T',
      jobLocation: { address: {
        streetAddress: '1 Secret Way', postalCode: '94103', addressLocality: 'San Francisco',
      } },
    }));
    const card = readJobCardFromPage(doc);
    expect(card.location).toBe('San Francisco');
    expect(card.location).not.toContain('Secret Way');
    expect(card.location).not.toContain('94103');
  });

  it('@type 是数组、外面包着 @graph、或整份是数组，都认得', () => {
    for (const value of [
      [{ '@type': ['JobPosting', 'Thing'], title: 'T' }],
      { '@graph': [{ '@type': 'WebSite' }, { '@type': 'JobPosting', title: 'T' }] },
    ]) {
      expect(readJobCardFromPage(page(ld(value))).title, JSON.stringify(value)).toBe('T');
    }
  });

  it('一份坏掉的 ld+json 不让整页读不出卡片', () => {
    const doc = page(`<script type="application/ld+json">{ not json </script>${ASHBY}`);
    expect(readJobCardFromPage(doc).company).toBe('Notion');
  });
});

describe('只有 Open Graph 的页面', () => {
  it('og:title 当职位名', () => {
    expect(readJobCardFromPage(page(GREENHOUSE)).title)
      .toBe('Senior Software Engineer, Data Platform');
  });

  it('**绝不**读 og:description —— 那是 Data-L1 的陷阱', () => {
    // Greenhouse 上它恰好是地点，Ashby 上它是整篇 JD。拿它当地点等于在 Ashby
    // 把 JD 原文搬进卡片。要分辨这两种情况就得知道自己在哪一家，而这个模块
    // 不许知道。
    const card = readJobCardFromPage(page(GREENHOUSE));
    expect(card.location).toBe('');
    expect(card.company).toBe('');
    const jd = page(`
      <meta property="og:title" content="T">
      <meta property="og:description" content="WHO WE ARE Notion is the collaborative AI workspace">
    `);
    expect(JSON.stringify(readJobCardFromPage(jd))).not.toContain('WHO WE ARE');
  });

  it('读不出的就是空的，交给面板说「未写明」', () => {
    // 少一行，好过把一整篇 JD 摆上去。
    expect(readJobCardFromPage(page(''))).toEqual({ title: '', company: '', location: '' });
  });
});

describe('一条厂商选择器都没有', () => {
  it('不靠 document.title —— 那个格式是厂商知识，属于规则数据', () => {
    const doc = page('<meta property="og:title" content="T">');
    doc.title = 'Job Application for Senior Engineer at Discord';
    const card = readJobCardFromPage(doc);
    expect(card.title).toBe('T');
    expect(card.company).toBe('');
  });

  it('不碰 class、id、data-* —— 只认标准', () => {
    const doc = page('');
    doc.body.innerHTML = '<h1 class="job-title">Staff Engineer</h1><div id="company">Acme</div>';
    expect(readJobCardFromPage(doc)).toEqual({ title: '', company: '', location: '' });
  });
});

describe('异常值', () => {
  it('过长的值截断', () => {
    const doc = page(ld({ '@type': 'JobPosting', title: 'x'.repeat(500) }));
    expect(readJobCardFromPage(doc).title.length).toBe(160);
  });

  it('空白折叠，首尾去空', () => {
    const doc = page(ld({ '@type': 'JobPosting', title: '  Staff   Engineer \n ' }));
    expect(readJobCardFromPage(doc).title).toBe('Staff Engineer');
  });

  it('非字符串的字段当成没有', () => {
    const doc = page(ld({ '@type': 'JobPosting', title: 42, hiringOrganization: { name: null } }));
    expect(readJobCardFromPage(doc)).toEqual({ title: '', company: '', location: '' });
  });
});

describe('宿主写的那段文本当敌对输入处理', () => {
  it('超长的 ld+json 不解析——解析它卡住的是用户正在读的页面', () => {
    const huge = `<script type="application/ld+json">${'x'.repeat(200_000)}</script>`;
    expect(readJobCardFromPage(page(huge + ASHBY)).company).toBe('Notion');
  });

  it('嵌太深的数组到顶就停，不爆栈', () => {
    let nested: unknown = { '@type': 'JobPosting', title: 'Buried' };
    for (let i = 0; i < 50; i += 1) nested = [nested];
    expect(() => readJobCardFromPage(page(ld(nested)))).not.toThrow();
    expect(readJobCardFromPage(page(ld(nested))).title).toBe('');
  });

  it('一页塞几百份 ld+json 只看前二十份', () => {
    const many = Array.from({ length: 300 }, () => ld({ '@type': 'WebSite' })).join('');
    // 真的那一份排在第二十一位之后，读不出来——读不出卡片只是少一张卡片。
    expect(readJobCardFromPage(page(many + ASHBY)).company).toBe('');
    // 排在前面就读得到。
    expect(readJobCardFromPage(page(ASHBY + many)).company).toBe('Notion');
  });

  it('空的 script 直接跳过', () => {
    expect(readJobCardFromPage(page('<script type="application/ld+json"></script>' + ASHBY)).company)
      .toBe('Notion');
  });
});

/**
 * 申请页自己没有 JobPosting 时，去同一站点上的职位详情页读地点（2026-09-24）。
 *
 * 2026-09-23 实测：Jobvite（…/job/o6UHAfw1/apply）与 Lever（…/<uuid>/apply）的申请页都没有 ld+json，
 * 详情页（去掉 /apply）才有；于是「在岗位所在国家是否有工作授权」「是否需要担保」两题判成
 * JOB_DEPENDENT，而竞品按详情页上的 United States 答上了。Ashby 的 /application 页自己带着，
 * 不用多取一页。
 */
describe('申请页没有 JobPosting：读同站点详情页的地点', () => {
  const JOBVITE_DETAIL = `<html><head>${ld({
    '@type': 'JobPosting',
    title: 'Business Development Associate',
    jobLocation: [{ '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: 'United States' } }],
  })}</head><body></body></html>`;
  const html = (body: string, contentType = 'text/html; charset=utf-8') =>
    new Response(body, { status: 200, headers: { 'content-type': contentType } });
  const calls: string[] = [];
  const fetchReturning = (response: () => Response | Promise<Response>) =>
    (async (input: RequestInfo | URL) => { calls.push(String(input)); return response(); }) as typeof fetch;

  it('当前页自己带着地点：直接用，不取别的页', async () => {
    calls.length = 0;
    const location = await readPostingLocationNearby(page(ASHBY), 'https://jobs.ashbyhq.com/notion/x/application', {
      fetch: fetchReturning(() => html(JOBVITE_DETAIL)),
    });
    expect(location).toBe('San Francisco, California, United States');
    expect(calls).toEqual([]);
  });

  it('Jobvite 申请页：取去掉 /apply 的详情页，读出 United States', async () => {
    calls.length = 0;
    const location = await readPostingLocationNearby(page(''), 'https://jobs.jobvite.com/uplight/job/o6UHAfw1/apply', {
      fetch: fetchReturning(() => html(JOBVITE_DETAIL)),
    });
    expect(calls).toEqual(['https://jobs.jobvite.com/uplight/job/o6UHAfw1']);
    expect(location).toBe('United States');
  });

  it('不是申请页的地址（Greenhouse 职位页本身）：不取、不猜', async () => {
    calls.length = 0;
    const location = await readPostingLocationNearby(page(GREENHOUSE), 'https://job-boards.greenhouse.io/discord/jobs/123', {
      fetch: fetchReturning(() => html(JOBVITE_DETAIL)),
    });
    expect(location).toBe('');
    expect(calls).toEqual([]);
  });

  it('详情页跳去了别的站点、不是网页、取不到或超时：一律当读不出', async () => {
    const redirected = Object.defineProperty(html(JOBVITE_DETAIL), 'url', { value: 'https://evil.example/job' });
    for (const fetchImpl of [
      fetchReturning(() => redirected),
      fetchReturning(() => html(JOBVITE_DETAIL, 'application/json')),
      fetchReturning(() => new Response('', { status: 404 })),
      (async () => { throw new TypeError('network'); }) as typeof fetch,
      ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')));
      })) as typeof fetch,
    ]) {
      expect(await readPostingLocationNearby(page(''), 'https://jobs.lever.co/palantir/abc/apply', { fetch: fetchImpl, timeoutMs: 50 })).toBe('');
    }
  });

  /**
   * 2026-09-24 测试台 jobs.lever.co/shieldai/30df7ce0-…：详情页 73 万字符，head 里两段各 35 万的内联样式，
   * JobPosting 在第 716,813 个字符处——从前只读前 40 万，于是地点读不出，「需不需要担保」落成「取决于这个岗位」，
   * 而岗位写明了 Seattle, Washington。
   */
  it('JobPosting 排在几十万字符的内联样式后面：照样读得出', async () => {
    const lever = `<html><head><style>${'.a{b:c}'.repeat(50_000)}</style><style>${'.d{e:f}'.repeat(50_000)}</style></head>`
      + `<body><div>posting</div>${ld({
        '@type': 'JobPosting',
        title: 'Aerostructures Design Engineer II',
        jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Seattle, Washington', addressRegion: null, addressCountry: null } },
      })}</body></html>`;
    expect(lever.indexOf('application/ld+json')).toBeGreaterThan(700_000);
    const location = await readPostingLocationNearby(page(''), 'https://jobs.lever.co/shieldai/30df7ce0/apply', {
      fetch: fetchReturning(() => html(lever)),
    });
    expect(location).toBe('Seattle, Washington');
  });

  it('详情页过大：只读前面一截，读不到 JobPosting 就当没有，不会卡住', async () => {
    const huge = `<html><head></head><body>${'x'.repeat(300_000)}</body></html>${JOBVITE_DETAIL}`;
    const location = await readPostingLocationNearby(page(''), 'https://jobs.jobvite.com/uplight/job/o6UHAfw1/apply', {
      fetch: fetchReturning(() => html(huge)),
      maxChars: 100_000,
    });
    expect(location).toBe('');
  });
});

/**
 * 没有 JobPosting 的职位页（2026-09-24）：Greenhouse 的 job-boards 页连 ld+json 都没有，地点只写在两处——
 * Open Graph 的 og:description（「Remote - Estonia」「Warsaw, Poland」）与标题下面那一行字。别家的
 * og:description 是一段 JD（Ashby、Lever、Workable、BambooHR、Rippling 2026-09-24 实测都是），所以它只在
 * 「看起来是一个地名、而且页面上单独写着同一句」时才算岗位地点：短、不是一句话、页面正文里有一段文字恰好就是它。
 * 读出来的只拿去推国家，不进卡片（卡片仍只认 JobPosting，见上）。
 */
describe('没有 JobPosting 的职位页：页面上单独写着的 og:description 就是岗位地点', () => {
  const pageWith = (head: string, body: string): Document => {
    const doc = document.implementation.createHTMLDocument();
    doc.head.innerHTML = head;
    doc.body.innerHTML = body;
    return doc;
  };
  const og = (text: string) => `<meta property="og:title" content="Compliance Operations Specialist"><meta property="og:description" content="${text}">`;
  const noFetch = (async () => { throw new Error('must not fetch'); }) as typeof fetch;

  it('Greenhouse：标题下面单独写着「Remote - Estonia」', async () => {
    const doc = pageWith(og('Remote - Estonia'), `
      <div class="job__title"><h1>Compliance Operations Specialist</h1>
        <div class="job__location"><svg></svg><div>Remote - Estonia</div></div></div>
      <div class="job__description"><p>Twilio is growing rapidly and seeking a Compliance Operations Specialist…</p></div>`);
    expect(await readPostingLocationNearby(doc, 'https://job-boards.greenhouse.io/twilio/jobs/8185918', { fetch: noFetch }))
      .toBe('Remote - Estonia');
    expect(readJobCardFromPage(doc).location, '卡片仍只认 JobPosting').toBe('');
  });

  it('页面上没有单独写着同一句：不算', async () => {
    const doc = pageWith(og('Warsaw, Poland'), '<p>Our offices are in Warsaw, Poland and Boston.</p>');
    expect(await readPostingLocationNearby(doc, 'https://job-boards.greenhouse.io/starburst/jobs/5119301008', { fetch: noFetch }))
      .toBe('');
  });

  it('一段 JD、一句话、太长：就算页面上也有同一段，也不算地点', async () => {
    for (const text of [
      'At Skroutz Last Mile, we believe that great decisions start with great insights across Greece',
      'We are hiring in Poland.',
      'Job Description: Shield AI is seeking an Aerostructures Design Engineer II to support the development',
    ]) {
      const doc = pageWith(og(text), `<div>${text}</div>`);
      expect(await readPostingLocationNearby(doc, 'https://example.test/jobs/1', { fetch: noFetch }), text).toBe('');
    }
  });

  it('JobPosting 在的时候照旧以它为准', async () => {
    const doc = pageWith(`${ASHBY}${og('Remote - Estonia')}`, '<div>Remote - Estonia</div>');
    expect(await readPostingLocationNearby(doc, 'https://jobs.ashbyhq.com/notion/x/application', { fetch: noFetch }))
      .toBe('San Francisco, California, United States');
  });
});

/**
 * 首页的岗位摘要卡（2026-09-24 负责人要首页的岗位卡照设计展开）：地点、办公方式、雇佣类型、薪资、一段简介、
 * 发布日期，全部只从 JobPosting 的结构化字段读。夹具是 2026-09-24 测试台上两页的形状（Ramp 在 Ashby 的
 * /application 页自己带着；LearnWorlds 在 Workable 的 /apply 页没有，详情页才有），正文换成了虚构的。
 */
describe('首页岗位卡：JobPosting 的摘要', () => {
  const RAMP = ld({
    '@type': 'JobPosting',
    title: 'Mobile Engineer, Android',
    datePosted: '2026-09-21',
    employmentType: 'FULL_TIME',
    jobLocationType: 'TELECOMMUTE',
    hiringOrganization: { '@type': 'Organization', name: 'Ramp' },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'New York City', addressRegion: 'NY', addressCountry: 'USA' } },
    baseSalary: { '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', minValue: 189000, maxValue: 330000, unitText: 'YEAR' } },
    description: '<h1><strong>About Ramp</strong></h1><p>Ramp builds the finance tools &amp; automation that save teams time &mdash; every day, for thousands of companies.</p><p>What you&#39;ll do:</p><ul><li>Ship things</li></ul>',
  });
  const LEARNWORLDS = ld({
    '@type': 'JobPosting',
    title: 'Software Engineer in Test (Remote, Greece or Cyprus)',
    datePosted: '2026-09-16',
    employmentType: 'full-time',
    jobLocationType: 'TELECOMMUTE',
    hiringOrganization: { '@type': 'Organization', name: 'LearnWorlds' },
    applicantLocationRequirements: [{ '@type': 'Country', name: 'Greece' }, { '@type': 'Country', name: 'Greece' }, { '@type': 'Country', name: 'Cyprus' }],
    description: '<p>We are hiring.</p><p>LearnWorlds is an online course platform used by creators and companies to sell and teach online.</p>',
  });

  it('Ramp：薪资区间、远程、全职、结构化地址、发布日期，简介跳过小标题取第一段正文、实体还原', () => {
    const summary = readJobSummaryFromPage(page(RAMP));
    expect(summary.title).toBe('Mobile Engineer, Android');
    expect(summary.company).toBe('Ramp');
    expect(summary.facts).toEqual({
      location: 'New York City, NY, USA',
      workMode: 'REMOTE',
      employment: 'FULL_TIME',
      salary: { min: 189000, max: 330000, currency: 'USD', unit: 'YEAR' },
      description: 'Ramp builds the finance tools & automation that save teams time — every day, for thousands of companies.',
      datePosted: '2026-09-21',
    });
  });

  it('LearnWorlds：小写连字符的 full-time 也认；没有地址时地点退到申请人所在国家（去重）', () => {
    const facts = readJobSummaryFromPage(page(LEARNWORLDS)).facts;
    expect(facts?.employment).toBe('FULL_TIME');
    expect(facts?.location).toBe('Greece, Cyprus');
    expect(facts?.workMode).toBe('REMOTE');
    expect(facts?.salary).toBeNull();
    expect(facts?.description).toBe('LearnWorlds is an online course platform used by creators and companies to sell and teach online.');
    // 国家只给卡片看：推工作授权用的地点照旧只认结构化地址。
    expect(readJobCardFromPage(page(LEARNWORLDS)).location).toBe('');
  });

  it('薪资的几种写法：单个数、数字字符串、按月按小时；币种不对或金额不是正数就没有', () => {
    const salary = (baseSalary: unknown) => readJobSummaryFromPage(page(ld({ '@type': 'JobPosting', title: 'T', baseSalary }))).facts?.salary;
    expect(salary({ currency: 'eur', value: { value: '8,500', unitText: 'MONTH' } })).toEqual({ min: 8500, max: 8500, currency: 'EUR', unit: 'MONTH' });
    expect(salary({ currency: 'USD', value: 52, unitText: 'HOUR' })).toEqual({ min: 52, max: 52, currency: 'USD', unit: 'HOUR' });
    expect(salary({ currency: 'USD', value: { minValue: 175000, maxValue: 140000 } })).toEqual({ min: 140000, max: 175000, currency: 'USD', unit: null });
    expect(salary({ currency: 'US Dollars', value: 100000 })).toBeNull();
    expect(salary({ currency: 'USD', value: { minValue: -1, maxValue: 'lots' } })).toBeNull();
    expect(salary(undefined)).toBeNull();
  });

  it('办公方式：TELECOMMUTE 是远程；否则看地点那一行写没写 hybrid / remote / on-site；都没写就没有', () => {
    const mode = (extra: Record<string, unknown>) => readJobSummaryFromPage(page(ld({ '@type': 'JobPosting', title: 'T', ...extra }))).facts?.workMode;
    expect(mode({ jobLocation: { address: { addressLocality: 'Hybrid - London' } } })).toBe('HYBRID');
    expect(mode({ jobLocation: { address: { addressLocality: 'Remote (US)' } } })).toBe('REMOTE');
    expect(mode({ jobLocation: { address: { addressLocality: 'On-site, Austin' } } })).toBe('ONSITE');
    expect(mode({ jobLocation: { address: { addressLocality: 'Austin', addressRegion: 'TX' } } })).toBeNull();
  });

  it('雇佣类型只认四种：数组取第一个认得的；TEMPORARY、VOLUNTEER 不摆', () => {
    const type = (employmentType: unknown) => readJobSummaryFromPage(page(ld({ '@type': 'JobPosting', title: 'T', employmentType }))).facts?.employment;
    expect(type(['VOLUNTEER', 'INTERN'])).toBe('INTERNSHIP');
    expect(type('Part-time')).toBe('PART_TIME');
    expect(type('CONTRACTOR')).toBe('CONTRACT');
    expect(type('TEMPORARY')).toBeNull();
  });

  it('简介：转义过一次的 HTML 也还原；太长的截到 280 字以内；纯文本按空行分段', () => {
    const description = (value: unknown) => readJobSummaryFromPage(page(ld({ '@type': 'JobPosting', title: 'T', description: value }))).facts?.description;
    expect(description('&lt;p&gt;Short&lt;/p&gt;&lt;p&gt;We build tools that help support teams answer customers faster and with more care.&lt;/p&gt;'))
      .toBe('We build tools that help support teams answer customers faster and with more care.');
    const long = description(`<p>${'word '.repeat(200)}</p>`) ?? '';
    expect(long.length).toBeLessThanOrEqual(281);
    expect(long.endsWith('…')).toBe(true);
    expect(description('Title\n\nThis is a plain text description of the role that is long enough to count.')).toBe('This is a plain text description of the role that is long enough to count.');
    expect(description(42)).toBe('');
  });

  /**
   * 2026-10-04（bench-1003 第八节）：Brex 官网嵌 Greenhouse，那一页的 JobPosting 简介转义了**两次**
   * （`&amp;lt;div class=&amp;quot;content-intro&amp;quot;&amp;gt;…`），岗位卡上显示的是「&lt;div class=…」原文。
   */
  it('简介：转义过两次的 HTML 也一层一层还原成干净的字；正文里真有的「<」照旧是字', () => {
    const description = (value: unknown) => readJobSummaryFromPage(page(ld({ '@type': 'JobPosting', title: 'T', description: value }))).facts?.description;
    const brex = '&amp;lt;div class=&amp;quot;content-intro&amp;quot;&amp;gt;&amp;lt;p&amp;gt;&amp;lt;strong&amp;gt;Why join us&amp;lt;/strong&amp;gt;&amp;lt;/p&amp;gt;\n'
      + '&amp;lt;p&amp;gt;Brex is the intelligent finance platform that enables companies to spend smarter and move faster.&amp;lt;/p&amp;gt;&amp;lt;/div&amp;gt;';
    const shown = description(brex) ?? '';
    expect(shown).toBe('Brex is the intelligent finance platform that enables companies to spend smarter and move faster.');
    expect(shown).not.toMatch(/&lt;|&amp;|&quot;|<div/u);
    expect(description('&lt;p&gt;Revenue grew 3 &amp;lt; 5 times while the team stayed small enough to keep shipping weekly.&lt;/p&gt;'))
      .toBe('Revenue grew 3 < 5 times while the team stayed small enough to keep shipping weekly.');
  });

  /**
   * 2026-10-04（bench-1003 的截图）：Lever 的 JobPosting 把岗位名写成「Aerodynamics &amp;amp; Performance Engineer」（JSON 字符串里
   * 放着 HTML 实体），岗位卡上显示的就是「Aerodynamics &amp;amp; Performance …」。名字、公司、地点都是纯文字：实体还原成字。
   */
  it('岗位名、公司、地点里的 HTML 实体还原成字（Lever shieldai：「Aerodynamics &amp; Performance」）', () => {
    const doc = page(ld({
      '@type': 'JobPosting',
      title: 'Aerodynamics &amp; Performance Engineer (R57)',
      hiringOrganization: { '@type': 'Organization', name: 'Shield AI &amp;amp; Friends' },
      jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Dallas', addressRegion: 'Texas &#38; Co' } },
    }));
    expect(readJobCardFromPage(doc)).toEqual({
      title: 'Aerodynamics & Performance Engineer (R57)',
      company: 'Shield AI & Friends',
      location: 'Dallas, Texas & Co',
    });
    expect(readJobSummaryFromPage(doc).title).toBe('Aerodynamics & Performance Engineer (R57)');
    // 本来就是字的「&」「<」照旧是字。
    expect(readJobCardFromPage(page(ld({ '@type': 'JobPosting', title: 'R&D Engineer <Platform>' }))).title).toBe('R&D Engineer <Platform>');
  });

  it('发布日期只收 YYYY-MM-DD 开头的；没有 JobPosting 的页面只有 og:title、没有摘要', () => {
    expect(readJobSummaryFromPage(page(ld({ '@type': 'JobPosting', title: 'T', datePosted: '2026-09-16T08:00:00Z' }))).facts?.datePosted).toBe('2026-09-16');
    expect(readJobSummaryFromPage(page(ld({ '@type': 'JobPosting', title: 'T', datePosted: 'yesterday' }))).facts?.datePosted).toBe('');
    expect(readJobSummaryFromPage(page(GREENHOUSE))).toEqual({ title: 'Senior Software Engineer, Data Platform', company: '', facts: null });
  });
});

describe('职位详情页：申请页地址去掉 /apply 或 /application', () => {
  it('Workable、Ashby、Lever 的申请页都算得出；别的地址与只剩站点首页的不算', () => {
    expect(detailPageUrl('https://apply.workable.com/learnworlds/j/F36A3D8DAB/apply/')).toBe('https://apply.workable.com/learnworlds/j/F36A3D8DAB');
    expect(detailPageUrl('https://jobs.ashbyhq.com/ramp/f564dcf9/application?utm=x#top')).toBe('https://jobs.ashbyhq.com/ramp/f564dcf9');
    expect(detailPageUrl('https://jobs.lever.co/palantir/abc/apply')).toBe('https://jobs.lever.co/palantir/abc');
    expect(detailPageUrl('https://job-boards.greenhouse.io/discord/jobs/123')).toBeNull();
    expect(detailPageUrl('https://example.com/apply')).toBeNull();
    expect(detailPageUrl('javascript:alert(1)//apply')).toBeNull();
    expect(detailPageUrl('not a url')).toBeNull();
  });

  /**
   * 2026-09-24 负责人：Workday 上浮层的岗位卡没有 JD，AI 代答也拿不到岗位描述。Workday 的申请页是
   * `…/job/<地点>/<职位>_<编号>/apply`，选了怎么申请之后多一段（applyManually、autofillWithResume、
   * useMyLastApplication）；详情页 `…/job/<地点>/<职位>_<编号>` 的 HTML 带着完整的 JobPosting（当天实测 NVIDIA）。
   */
  it('/apply 后面再跟一段只由字母组成的「申请流程里的一步」也算得出（Workday 的 applyManually 等）', () => {
    const detail = 'https://acme.wd5.myworkdayjobs.com/en-US/External/job/US-CA-Santa-Clara/Senior-Engineer_JR2001234';
    for (const step of ['', '/', '/applyManually', '/autofillWithResume', '/useMyLastApplication', '/useMyLastApplication/']) {
      expect(detailPageUrl(`${detail}/apply${step}?source=LinkedIn#top`), step).toBe(detail);
    }
    expect(detailPageUrl('https://jobs.ashbyhq.com/ramp/f564dcf9/application/review')).toBe('https://jobs.ashbyhq.com/ramp/f564dcf9');
  });

  it('/apply 后面那一段带数字、带点、不止一段：不是「申请流程里的一步」，不猜', () => {
    const detail = 'https://acme.wd5.myworkdayjobs.com/en-US/External/job/US-CA-Santa-Clara/Senior-Engineer_JR2001234';
    expect(detailPageUrl('https://careers.example.com/jobs/apply/12345')).toBeNull();
    expect(detailPageUrl(`${detail}/apply/step2`)).toBeNull();
    expect(detailPageUrl(`${detail}/apply/review.html`)).toBeNull();
    expect(detailPageUrl(`${detail}/apply/step/two`)).toBeNull();
    expect(detailPageUrl('https://example.com/apply/applyManually')).toBeNull();
  });
});

describe('Workday：申请页上读详情页的 JobPosting（岗位卡的 JD、送给 AI 的 job）', () => {
  const DETAIL_URL = 'https://acme.wd5.myworkdayjobs.com/en-US/External/job/US-CA-Santa-Clara/Senior-Engineer_JR2001234';
  const DESCRIPTION = '<p><b>What you will be doing:</b></p><p>Build the libraries that customers use to ship accelerated products, working with research and product teams every week.</p><ul><li>Own the roadmap</li></ul>';
  const DETAIL = `<html><head><title>Senior Engineer</title>${ld({
    '@type': 'JobPosting',
    title: 'Senior Engineer',
    hiringOrganization: { '@type': 'Organization', name: 'Acme' },
    employmentType: 'FULL_TIME',
    datePosted: '2026-09-20',
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Santa Clara', addressCountry: 'US' } },
    description: DESCRIPTION,
  })}</head><body><div id="root"></div></body></html>`;

  it('在 …/apply/applyManually 上：取一次同源的详情页，岗位卡有简介、job 有整篇描述的纯文本', async () => {
    const calls: string[] = [];
    const reader = createNearbyPostingReader({
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(DETAIL, { status: 200, headers: { 'content-type': 'text/html;charset=UTF-8' } });
      }) as typeof fetch,
    });
    const apply = `${DETAIL_URL}/apply/applyManually`;
    const summary = await reader.summary(page(''), apply);
    expect(summary?.title).toBe('Senior Engineer');
    expect(summary?.facts?.description).toBe('Build the libraries that customers use to ship accelerated products, working with research and product teams every week.');
    const job = await reader.job(page(''), apply);
    expect(job).toEqual({
      title: 'Senior Engineer',
      company: 'Acme',
      location: 'Santa Clara, US',
      description: 'What you will be doing:\nBuild the libraries that customers use to ship accelerated products, working with research and product teams every week.\nOwn the roadmap',
    });
    expect(await reader.location(page(''), apply)).toBe('Santa Clara, US');
    expect(calls).toEqual([DETAIL_URL]);
  });
});

describe('同一页只取一次详情页：岗位卡与工作授权推国家共用', () => {
  const DETAIL = `<html><head>${ld({
    '@type': 'JobPosting',
    title: 'Business Development Associate',
    hiringOrganization: { name: 'Uplight' },
    employmentType: 'FULL_TIME',
    jobLocation: [{ '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: 'United States' } }],
  })}</head><body></body></html>`;
  const APPLY = 'https://jobs.jobvite.com/uplight/job/o6UHAfw1/apply';
  const ok = () => new Response(DETAIL, { status: 200, headers: { 'content-type': 'text/html' } });

  it('面板打开时读摘要、按下自动填写时读地点：只取一次', async () => {
    let calls = 0;
    const reader = createNearbyPostingReader({ fetch: (async () => { calls += 1; return ok(); }) as typeof fetch });
    const summary = await reader.summary(page(''), APPLY);
    expect(summary?.company).toBe('Uplight');
    expect(summary?.facts?.employment).toBe('FULL_TIME');
    expect(await reader.location(page(''), APPLY)).toBe('United States');
    expect(calls).toBe(1);
  });

  it('超时、断网这种一时的失败不记住：下一次要的时候再取', async () => {
    let calls = 0;
    const reader = createNearbyPostingReader({
      fetch: (async () => {
        calls += 1;
        if (calls === 1) throw new TypeError('network');
        return ok();
      }) as typeof fetch,
    });
    expect(await reader.summary(page(''), APPLY)).toBeNull();
    expect((await reader.summary(page(''), APPLY))?.company).toBe('Uplight');
    expect(calls).toBe(2);
  });

  it('这一页自己带着 JobPosting：不取别的页', async () => {
    let calls = 0;
    const reader = createNearbyPostingReader({ fetch: (async () => { calls += 1; return new Response(''); }) as typeof fetch });
    expect((await reader.summary(page(ASHBY), 'https://jobs.ashbyhq.com/notion/x/application'))?.company).toBe('Notion');
    expect(calls).toBe(0);
  });
});
