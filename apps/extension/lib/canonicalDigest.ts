/**
 * 契约 §1.2 的 digest 约定：allowlisted JSON object → RFC 8785 canonical
 * JSON（JCS）→ UTF-8 → SHA-256 → `sha256:<64 位小写 hex>`。
 *
 * 这里实现的是 JCS 在本项目值域（string/number/boolean/null/数组/普通对象）
 * 上的严格子集：键按 UTF-16 码元排序（JS 默认 sort 即是），数字沿用
 * JSON.stringify 的 ECMAScript 序列化（与 RFC 8785 一致），非有限数与
 * 值域外类型直接抛错——digest 输入 schema 由代码定义（§1.2），
 * 出现意料外的形状宁可炸在本地也不能产出一个"看起来像"的摘要。
 */

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

export async function sha256CanonicalJson(payload: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

/** SHA-256 of a UTF-8 string, in the same `sha256:<hex>` shape as the JCS digest. */
export async function sha256Utf8(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}
