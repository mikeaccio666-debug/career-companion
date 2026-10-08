import { createHash } from 'node:crypto';
import { careerRecordObject, careerRecordId, careerLibraryTime, CAREER_ROLE_FAMILIES } from '@companion/platform-contracts';
import { parseOrgP0Asset, ORG_P0_ASSET_CLASSES, ORG_QUESTION_TYPES, orgArray, orgText, orgChoice, orgInteger, orgAssetBody, assertOrgAssetText, type OrgP0AssetClass } from '@companion/career-core';
import { ApiError } from './errors.ts';
export const orgInvalid = () => new ApiError(400, 'ORG_CONTENT_INPUT_INVALID', '请核对授权和审核后的内容。');
export const orgUnavailable = () => new ApiError(503, 'ORG_CONTENT_STORAGE_UNAVAILABLE', '内容来源暂时无法核对。');
export const orgDenied = () => new ApiError(403, 'NOT_ENTITLED', '这份内容目前不可访问。');
export const orgStale = () => new ApiError(409, 'STALE_REVISION', '来源版本已变化或撤回。');
export const orgDigest = (v: unknown): string => createHash('sha256').update(JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x)).digest('hex');
export const ORG_LICENSE_USES = ['retrieve', 'model_context', 'display_excerpt', 'display_full', 'aggregate'] as const;
export const ORG_AUDIENCES = ['all_users', 'cohort', 'entitled', 'staff_only'] as const;
export const uniq = <T>(values: readonly T[]) => { if (new Set(values).size !== values.length) throw orgInvalid(); return values; };
const email = (v: unknown) => { const s = orgText(v, 254); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s !== s.toLowerCase()) throw orgInvalid(); return s; };
export function parseOrgLicenseInput(value: unknown) {
  const v = careerRecordObject(value, ['operationId', 'assetClass', 'agreementRef', 'allowedUses', 'audience', 'validFrom', 'validUntil']);
  const validFrom = careerLibraryTime(v.validFrom), validUntil = careerLibraryTime(v.validUntil);
  if (validUntil <= validFrom) throw orgInvalid();
  return Object.freeze({ operationId: careerRecordId(v.operationId), assetClass: orgChoice(v.assetClass, ORG_P0_ASSET_CLASSES), agreementRef: careerRecordId(v.agreementRef),
    allowedUses: uniq(orgArray(v.allowedUses, x => orgChoice(x, ORG_LICENSE_USES), 5, 1)), audience: orgChoice(v.audience, ORG_AUDIENCES), validFrom, validUntil });
}
export function parseOrgImport(value: unknown) {
  const v = careerRecordObject(value, ['operationId', 'licenseId', 'sources']);
  const sources = orgArray(v.sources, raw => {
    const r = careerRecordObject(raw, ['assetClass', 'title', 'structured', 'language', 'roleFamilies', 'tags', 'editor', 'reviewer', 'validUntil', 'reviewConfirmed', 'deidentified']);
    if (r.reviewConfirmed !== true || r.deidentified !== true) throw orgInvalid();
    const assetClass = orgChoice(r.assetClass, ORG_P0_ASSET_CLASSES), structured = parseOrgP0Asset(assetClass, r.structured), body = orgAssetBody(structured);
    const title = orgText(r.title, 120), editor = email(r.editor), reviewer = email(r.reviewer);
    if (editor === reviewer) throw orgInvalid();
    const roleFamilies = uniq(orgArray(r.roleFamilies, x => orgChoice(x, CAREER_ROLE_FAMILIES), 7, 1));
    const assetRoles = (structured as { role_families?: readonly string[]; applies_to?: { role_families: readonly string[] } }).role_families ??
      (structured as { applies_to?: { role_families: readonly string[] } }).applies_to?.role_families;
    if (assetRoles && orgDigest([...assetRoles].sort()) !== orgDigest([...roleFamilies].sort())) throw orgInvalid();
    assertOrgAssetText(assetClass, title + '\n' + body);
    return Object.freeze({ assetClass, title, structured, body, language: orgChoice(r.language, ['en', 'zh', 'mixed'] as const), roleFamilies,
      tags: uniq(orgArray(r.tags, x => { const s = orgText(x, 100); if (!/^[a-z][a-z0-9_.-]*$/.test(s)) throw orgInvalid(); return s; }, 50)),
      editor, reviewer, validUntil: careerLibraryTime(r.validUntil) });
  }, 150, 1);
  const identities = sources.map(r => r.assetClass + ':' + ((r.structured as any).question_ref ?? (r.structured as any).method_id ?? (r.structured as any).pattern_id));
  uniq(identities);
  return Object.freeze({ operationId: careerRecordId(v.operationId), licenseId: careerRecordId(v.licenseId), sources });
}
export function parseOrgSearch(value: unknown) {
  const v = careerRecordObject(value, ['assetClass'], ['roleFamily', 'questionType', 'difficulty', 'topics', 'limit']);
  return Object.freeze({ assetClass: orgChoice(v.assetClass, ORG_P0_ASSET_CLASSES),
    roleFamily: v.roleFamily === undefined ? null : orgChoice(v.roleFamily, CAREER_ROLE_FAMILIES),
    questionType: v.questionType === undefined ? null : orgChoice(v.questionType, ORG_QUESTION_TYPES),
    difficulty: v.difficulty === undefined ? null : orgInteger(v.difficulty, 1, 4),
    topics: v.topics === undefined ? [] : uniq(orgArray(v.topics, x => orgText(x, 100), 50)),
    limit: v.limit === undefined ? 8 : orgInteger(v.limit, 1, 8) });
}
export function orgSourceContent(row: any) {
  return { assetClass: row.asset_class as OrgP0AssetClass, title: row.title, body: row.body, structured: row.structured,
    language: row.language, roleFamilies: row.role_families, tags: row.tags };
}
