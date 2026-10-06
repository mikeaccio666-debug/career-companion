/**
 * 电话设备类型：有 cell / mobile 就选（产品决定，2026-09-22）。
 *
 * Workday「My Information」的 Phone Device Type 是必填，而档案里没有「电话类型」这一项。
 * 它空着，「Save and Continue」就过不去——整个向导卡在第一步。档案里留的电话几乎都是
 * 手机，所以：选项里有 cell / mobile 那一类就选它；没有就留给用户。
 *
 * 这不是档案值，是一条**按题定的默认**，所以只在两个条件同时成立时才用：
 *  · 题目问的是设备类型（`isPhoneDeviceTypeField`）；
 *  · 档案里**有**电话——没有号码就谈不上它是什么设备。
 */

/**
 * 题目问的是「这个号码是什么设备」。
 *
 * 「Phone Device Type」「Phone Type」「Device Type」「Type of phone」。不认「Country Phone
 * Code」「Phone Extension」——那两个是号码的另外两部分，不是设备。
 */
const PHONE_DEVICE_TYPE = /\b(?:phone\s+)?device\s+type\b|\bphone\s+type\b|\btype\s+of\s+(?:phone|number)\b/i;

export function isPhoneDeviceTypeField(label: string): boolean {
  return PHONE_DEVICE_TYPE.test(label);
}

/**
 * 各家对「手机」的写法，按共用候选阶梯（精确 → 规范化 → 词边界前缀）逐个去撞。
 *
 * 2026-09-22 NVIDIA 的真实选项是「Home」与「Home Cellular」——连「Mobile」这个词都没有，
 * 所以清单要把整条写法列出来：阶梯里没有「包含某个词」这一档，「Cellular」撞不中
 * 「Home Cellular」。
 *
 * 只列**个人**手机的写法。「Work Mobile」「Business Cell」不在里面：档案里的电话是用户自己
 * 的，把它标成工作手机是错答。「Mobile - Personal」与「Mobile - Work」同时在时，「Mobile」
 * 的前缀命中两条、阶梯判歧义并就此停下——留给用户，不替他挑。
 */
export const PHONE_DEVICE_TYPE_CANDIDATES: readonly string[] = Object.freeze([
  'Mobile',
  'Cell',
  'Cellular',
  'Cellphone',
  'Mobile Phone',
  'Cell Phone',
  'Home Cellular',
  'Personal Mobile',
  'Personal Cell',
  'Personal Cellular',
  'Home Mobile',
]);
