/**
 * 招聘网站账号的密码（2026-09-28，负责人：像 Jobright 那样替用户注册、登录 Workday／iCIMS）。
 *
 * ## 生成（用户没设过、第一次替他注册时）
 *
 * 16 位，四类都有：大写、小写、数字、特殊字符各至少两个，第一个字符是字母。Workday 注册页写明的要求是「特殊字符、至少
 * 8 位、数字、大写、字母、小写」（2026-09-28 nvidia.wd5 只读实测），iCIMS 的常见要求也在这之内。刻意避开：
 *  · 容易看错的字（0／O、1／l／I）——他可能要在别的设备上照着输；
 *  · 引号、反斜杠、尖括号、`&`、空格、逗号、句点——有的网站拒收，有的在表单里转义出错；
 *  · 同一个字连着出现三次——有的网站判弱密码。
 * 随机数只来自 `crypto.getRandomValues`，按拒绝采样取，不取模偏。
 *
 * ## 用户自己设的（账户菜单里「修改」）
 *
 * 与 Jobright 同一条：至少 12 位，大写、小写、数字、特殊字符都要有；只收可打印的 ASCII、不能有空格（换一台设备、
 * 换一种输入法都输得进去）；至多 64 位。这一条密码给所有需要账号的招聘网站共用，所以按最严的那一家收。
 *
 * ## 某一家自己的密码（那一家早就有账号、密码不一样时，他在浮层里输一次）
 *
 * 那是他在那一家已经在用的密码，强不强由那一家说了算，这里只挡明显不是密码的输入：空的、太长的、带控制字符的。
 */

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SPECIALS = '!#$%*+-=?@^_';
const ALL = UPPER + LOWER + DIGITS + SPECIALS;

export const GENERATED_PASSWORD_LENGTH = 16;
export const SHARED_PASSWORD_MIN_LENGTH = 12;
export const SHARED_PASSWORD_MAX_LENGTH = 64;
export const SITE_PASSWORD_MAX_LENGTH = 128;

type RandomSource = (values: Uint32Array) => Uint32Array;

const defaultRandom: RandomSource = (values) => globalThis.crypto.getRandomValues(values);

/** [0, bound) 里的一个均匀随机整数（拒绝采样，不取模偏）。 */
function uniform(bound: number, random: RandomSource): number {
  const limit = Math.floor(0x1_0000_0000 / bound) * bound;
  const buffer = new Uint32Array(1);
  for (;;) {
    const value = random(buffer)[0]!;
    if (value < limit) return value % bound;
  }
}

function pick(alphabet: string, random: RandomSource): string {
  return alphabet[uniform(alphabet.length, random)]!;
}

/** 生成一条合所有目标网站要求的密码。 */
export function generateAccountPassword(random: RandomSource = defaultRandom): string {
  for (;;) {
    const chars = [
      pick(UPPER, random), pick(UPPER, random),
      pick(LOWER, random), pick(LOWER, random),
      pick(DIGITS, random), pick(DIGITS, random),
      pick(SPECIALS, random), pick(SPECIALS, random),
    ];
    while (chars.length < GENERATED_PASSWORD_LENGTH) chars.push(pick(ALL, random));
    // Fisher–Yates 洗牌。
    for (let index = chars.length - 1; index > 0; index -= 1) {
      const other = uniform(index + 1, random);
      [chars[index], chars[other]] = [chars[other]!, chars[index]!];
    }
    const password = chars.join('');
    if (/^[A-Za-z]/u.test(password) && !/(.)\1\1/u.test(password)) return password;
  }
}

export type SharedPasswordProblem = 'TOO_SHORT' | 'TOO_LONG' | 'NEEDS_UPPER' | 'NEEDS_LOWER' | 'NEEDS_DIGIT' | 'NEEDS_SPECIAL' | 'UNSUPPORTED_CHARACTER';

/** 用户自己设的共用密码：合要求就是 null，否则是第一处不合的地方（浮层照着说）。 */
export function sharedPasswordProblem(password: string): SharedPasswordProblem | null {
  if (!/^[\x21-\x7e]*$/u.test(password)) return 'UNSUPPORTED_CHARACTER';
  if (password.length < SHARED_PASSWORD_MIN_LENGTH) return 'TOO_SHORT';
  if (password.length > SHARED_PASSWORD_MAX_LENGTH) return 'TOO_LONG';
  if (!/[A-Z]/u.test(password)) return 'NEEDS_UPPER';
  if (!/[a-z]/u.test(password)) return 'NEEDS_LOWER';
  if (!/[0-9]/u.test(password)) return 'NEEDS_DIGIT';
  if (!/[^A-Za-z0-9]/u.test(password)) return 'NEEDS_SPECIAL';
  return null;
}

/** 某一家自己的密码：只挡明显不是密码的输入。 */
export function isPlausibleSitePassword(password: string): boolean {
  // 控制字符（含换行、制表）与超长的一律不收；别的由那一家自己判。
  return password.length > 0 && password.length <= SITE_PASSWORD_MAX_LENGTH && !/[\u0000-\u001f\u007f]/u.test(password);
}

/** 注册邮箱的形状（与门户资料页同一把尺的宽松版）：只用来挡明显的手误。 */
export function isPlausibleEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email);
}
