/**
 * LinkedIn 个人页的规范地址：`https://www.linkedin.com/in/…`。
 *
 * LinkedIn 把 `linkedin.com`、`m.linkedin.com`、国家子域（`uk.linkedin.com`）和 http 一律跳转到
 * 这里——同一个人、同一个地址，只是写法不同。有的申请系统只认规范写法：2026-09-22 nvidia.wd5
 * 第 2 步，档案里的地址是 https、带 /in/，只差 www，Workday 就判「Invalid LinkedIn URL」，
 * 整页翻不过去。
 *
 * 只换开头（协议与主机），路径、查询、片段逐字保留。认不出是个人页的——公司页、旧式 /pub/、
 * 短链、别的主机、带用户名或端口——返回 null，由调用方原样写。
 */
const PROFILE_PREFIX = /^https?:\/\/(?:(?:www|m|[a-z]{2})\.)?linkedin\.com(?=\/in\/[^/?#\s])/iu;

export function canonicalLinkedInProfileUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!PROFILE_PREFIX.test(trimmed)) return null;
  return trimmed.replace(PROFILE_PREFIX, 'https://www.linkedin.com');
}
