/**
 * 日期值的写入形态（CAP-AF-002）。
 *
 * ## 原设计的四条路线实测一条也用不上
 *
 * 设计里写的是「日期四条路线（禁止合成 ArrowUp）」——那是按 `<input type="date">`
 * 的原生日期选择器设想的。实测四家没有一家长这样：
 *
 *  · **Workable** 的 `start_date` / `end_date` 是**纯文本框**，两个都没有 id，只能靠 name 认；
 *  · **Greenhouse** 是 `input[type=number]` 的「年」（`end-year--0`，label `End date year*`）；
 *  · **Workday / Taleo** 是**月和年两个独立 `<select>`**。
 *
 * 所以真正要做的不是驱动日期选择器，是**按目标控件的真实形态把日期格式化成正确字符串**。
 * 「一个起止日期投射成 month + year 两个控件」那一半已由 `collectionProjection.ts`
 * （CAP-AF-020）完成；本模块补的是「这一个控件该收什么格式的字符串」。
 *
 * ## 为什么按 input type 分而不是按厂商分
 *
 * `<input type="date">` 只接受 `YYYY-MM-DD`、`type="month"` 只接受 `YYYY-MM`——
 * 这是 HTML 规范，不是某一家 ATS 的偏好。写错格式的后果是**静默不生效**：
 * 赋值被浏览器丢弃，`value` 读回来是空串，而我们的回读判决会正确地报失败，
 * 但用户看到的是「这一栏没填上」而不知道为什么。
 *
 * 厂商差异只体现在**自由文本框用哪种人读格式**，那一路照 CAP-AF-020 的做法
 * 产出有序候选，交给写入期去试——kernel 不替任何厂商选一种。
 */

import type { ConfirmedDatePart } from './profileCollections.ts';

/**
 * `<input type="date">` 需要一个日。我们的 `ConfirmedDatePart` 只有年月——
 * 求职经历的粒度本来就到月，没有人记得自己哪一天入职。
 *
 * 补 `01` 是唯一安全的选择：它在每个月都存在（`31` 会在二月变成非法日期，
 * 浏览器直接丢弃赋值）。这个补值**只影响那一个控件的显示**，不进档案。
 */
const ASSUMED_DAY = '01';

/** 月缺失时 `type=date` / `type=month` 都写不出合法值——两者都要求月份。 */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 目标控件的形态。`text` 是自由文本框（Workable 那种），其余按 HTML 规范取值。
 *
 * `number` 单列一档而不是并进 `text`：它只在**年份**栏出现（Greenhouse 实测），
 * 写月份进去会被宿主当成 1–12 的裸数字而丢掉年份信息。调用方必须自己知道
 * 这一栏是年还是月——那个知识来自 `CollectionFieldRole`，不在本模块。
 */
export type DateInputShape = 'date' | 'month' | 'number' | 'text';

/**
 * 自由文本框里的日期写法候选，按「歧义最小 → 最常见」排序。
 *
 * `2022-06` 放第一位是因为它**无歧义**：`06/2022` 与 `2022/06` 在不同 locale 下
 * 读法相反，而 ISO 形态全世界只有一种读法。宿主若有格式校验，它也最可能被接受。
 * 后面几种是实测见过的人读写法，留给校验宽松的文本框。
 */
function freeTextCandidates(part: ConfirmedDatePart): readonly string[] {
  const year = String(part.year);
  if (part.month === null) return [year];
  const mm = pad2(part.month);
  return [`${year}-${mm}`, `${mm}/${year}`, `${part.month}/${part.year}`];
}

/**
 * 把一个年月投射成某个控件形态可接受的字符串候选。
 *
 * 返回空数组表示**这一栏填不了**（例如只有年份却要写 `type=month`）——
 * 调用方按既有的 `NO_VALUE` 语义处理，不猜、不补。
 * 补一个假月份会让用户在自己的申请表上看到一个他没填过的日期。
 */
export function dateCandidatesForShape(
  part: ConfirmedDatePart | null,
  shape: DateInputShape,
): readonly string[] {
  if (part === null) return [];

  switch (shape) {
    case 'date':
      // 规范要求 YYYY-MM-DD；缺月就拼不出合法值，宁可不填。
      return part.month === null ? [] : [`${part.year}-${pad2(part.month)}-${ASSUMED_DAY}`];

    case 'month':
      return part.month === null ? [] : [`${part.year}-${pad2(part.month)}`];

    case 'number':
      // 只用于年份栏——月份写进来会丢掉年份信息，见 DateInputShape 注释。
      return [String(part.year)];

    case 'text':
      return freeTextCandidates(part);

    default:
      return [];
  }
}

/**
 * 从一个 `<input>` 的 `type` 推出它的日期形态。
 *
 * 只认三种原生形态，其余一律当自由文本——包括 `type` 缺失或写了浏览器不认的值
 * （HTML 规范下未知 type 回落成 text，这里与浏览器行为保持一致，
 * 否则我们判成"不可写"而浏览器判成"可写"，两边会不一致）。
 */
export function dateShapeOfInputType(inputType: string | null | undefined): DateInputShape {
  switch (inputType) {
    case 'date': return 'date';
    case 'month': return 'month';
    case 'number': return 'number';
    default: return 'text';
  }
}

/**
 * 一个自由文本日期的归一化伴生值。
 *
 * 设计里要求「为每个自由文本日期存一份归一化 ISO 伴生值（startDateIso 等），
 * 因为 ISO 才是驱动 Workday/Taleo 月+年 select 的东西」。
 *
 * 本仓的做法比那个更进一步：档案里存的**本来就是** `{year, month|null}`
 * （见 `profileCollections.ts` 的说明），已经是归一化形态，不需要再存一份 ISO
 * 然后在写入期又拆一次。本函数只在**需要把结构化日期显示成 ISO 串**时用
 * （诊断、审计面板的 diff 视图），不参与写入。
 */
export function toIsoDatePart(part: ConfirmedDatePart | null): string | null {
  if (part === null) return null;
  return part.month === null ? String(part.year) : `${part.year}-${pad2(part.month)}`;
}
