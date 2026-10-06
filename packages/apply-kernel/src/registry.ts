/**
 * Vendor adapter registry.
 *
 * This is the only bridge from a detected vendor to host-page parsing. A total
 * record turns an added `APPLY_VENDOR` into a compiler error until it is
 * explicitly either wired to an adapter or kept unavailable with `null`.
 */

import {
  APPLY_VENDORS,
  type AccountWallStep,
  type EmailCodePrompt,
  type EmailVerificationMail,
  type ApplyFieldDescriptor,
  type ApplyFormDescriptor,
  type ApplyPathOptions,
  type ApplyVendor,
  type VendorAdapter,
  ScanRootOptions,
} from './contracts';
import { resolveEmailCodePrompt } from './rules/emailVerification';
import { sealScanRootMutationPolicy } from './scanRoot';

/**
 * Vendors without a parser stay explicit nulls: they can be detected for
 * diagnostics, but are never injected or treated as an application surface
 * before their adapter exists. Adding one here is what puts its hosts into the
 * manifest — `applyHostMatchPatterns()` derives from this record.
 */
/**
 * 运行时的适配器来源。
 *
 * 空表是有意的默认值：没装上之前一切识别 fail closed。内容脚本注入后向
 * background 要一次当前运行时包里的规则、编译好装进来；background 持有的是
 * 后端下发的权威版本，所以内容脚本不再需要自带一份站点知识的拷贝。
 *
 * 构建期工具、实验室与测试要的是随包内置那份，从 `./bundledAdapters` 取。
 */
let installed: Readonly<Partial<Record<ApplyVendor, VendorAdapter | null>>> = Object.freeze({});

/** 装入本次会话可用的适配器；重复调用以最后一次为准。 */
export function installApplyAdapters(
  adapters: Readonly<Partial<Record<ApplyVendor, VendorAdapter | null>>>,
): void {
  installed = Object.freeze({ ...adapters });
}

/** 已装入的厂商，诊断用。 */
export function installedApplyVendors(): ApplyVendor[] {
  return APPLY_VENDORS.filter((vendor) => installed[vendor] != null);
}

/** `true` exactly when this vendor has a parser that can prove a form root. */
export function hasApplyAdapter(vendor: ApplyVendor): boolean {
  return installed[vendor] != null;
}

/** URL prefilter delegated to the vendor adapter; absent adapters fail closed. */
export function isApplyFormPath(
  vendor: ApplyVendor,
  pathname: string = location.pathname,
  options?: ApplyPathOptions,
): boolean {
  return installed[vendor]?.isApplyPath(pathname, options) ?? false;
}

/** 这一家的规则声明了账号墙（2026-09-28，`accountSteps`）。没装这家规则就是没有。 */
export function declaresAccountSteps(vendor: ApplyVendor): boolean {
  return installed[vendor]?.declaresAccountSteps === true;
}

/** 这条路径是这一家只有账号墙、没有申请表的那一页（iCIMS 的 …/login）。没装、没声明都答否。 */
export function isAccountFormPath(vendor: ApplyVendor, pathname: string): boolean {
  return installed[vendor]?.isAccountPath?.(pathname) === true;
}

/**
 * 只读探测：这一页上此刻有没有这一家规则声明的账号墙、是哪一步（浮层据此把主按钮写成「注册并自动填写」或
 * 「登录并自动填写」）。不写、不点、不留状态；真动手时由运行时授权那一侧（`readRuntimeAccountWall`）再解析一次。
 */
export function probeAccountWall(
  vendor: ApplyVendor,
  page: ParentNode = document,
  options?: ScanRootOptions,
): AccountWallStep | null {
  return installed[vendor]?.resolveAccountWall?.(page, options) ?? null;
}

/** 这一家的规则声明了「网站要邮件里的验证码」时页面长什么样（2026-10-04，`emailVerification.codePrompts`）。 */
export function declaresEmailCodePrompts(vendor: ApplyVendor): boolean {
  return installed[vendor]?.declaresEmailCodePrompts === true;
}

/** 这一家的验证邮件长什么样（发件地址、标题开头；只给人看）。没装、没声明都是 null。 */
export function emailVerificationMailOf(vendor: ApplyVendor): EmailVerificationMail | null {
  return installed[vendor]?.emailVerificationMail ?? null;
}

/**
 * 只读探测：此刻网站是不是在要邮件里的验证码（2026-10-04）。不写、不点、不留状态；写之前由运行时授权那一侧
 * （`readRuntimeEmailCodePrompt`）再解析一次。没装、没声明、说不清都是 null。
 */
export function probeEmailCodePrompt(
  vendor: ApplyVendor,
  page: ParentNode,
  isVisible: (element: Element) => boolean,
): EmailCodePrompt | null {
  const rule = installed[vendor]?.emailVerification ?? null;
  return rule === null ? null : resolveEmailCodePrompt(rule, page, isVisible);
}

/**
 * 只读探测：这家规则在这一页上找不找得到那一张表（`resolveRoot`）；找得到就交回它扫出来的字段。
 *
 * 给「这一页该不该露面」用（2026-09-24，商店包开全网：没认出厂商的页面只有真找到一张表才挂浮层；2026-09-25 起还要看
 * 表里有没有求职才问的栏）。不封存、不留状态；真正动手仍走 `readApplyForm` 的全套。没装这家规则或找不到表 → null。
 */
export function probeApplyFormFields(
  vendor: ApplyVendor,
  page: ParentNode = document,
  options?: ScanRootOptions,
): readonly ApplyFieldDescriptor[] | null {
  const adapter = installed[vendor];
  if (!adapter) return null;
  const root = adapter.resolveRoot(page, options);
  if (!root) return null;
  return [...adapter.scan(root, options)];
}

/**
 * Read an explicitly anchored application form. The registry—not the parser—
 * injects `vendor` and retains the ScanRoot used to obtain the descriptors.
 */
export function readApplyForm(
  vendor: ApplyVendor,
  page: ParentNode = document,
  options?: ScanRootOptions,
): ApplyFormDescriptor | null {
  const adapter = installed[vendor];
  if (!adapter) return null;

  const root = adapter.resolveRoot(page, options);
  if (!root) return null;

  const fields = [...adapter.scan(root, options)];
  // A verified container with no canonical field is not enough to show UI.
  // It could be a future Greenhouse layout we do not understand, so stay shut.
  if (!fields.some((field: ApplyFieldDescriptor) => field.key !== null)) return null;
  // Seal in the same synchronous segment that produced the descriptors. The
  // caller may await a digest next; no later resolver is allowed to rebaseline.
  if (sealScanRootMutationPolicy(root, {
    fields,
    rescan: () => adapter.scan(root, options),
  }) === null) return null;
  return {
    vendor,
    root,
    fields,
    finalSubmitControl: adapter.resolveFinalSubmitControl(root, fields),
    resolveFinalSubmitControl: () => adapter.resolveFinalSubmitControl(root, fields),
    rowScopes: adapter.rowScopes ?? [],
  };
}
