/**
 * 「简历标题最多往上找几层」这一个设定，和它自己。
 *
 * ## 为什么它单独是一个模块
 *
 * 这是**规则声明的一个数字**，由解释器在编译一份规则时装进来，由文件写入原语
 * 在找标题时读出去。它本身不碰 DOM。
 *
 * 但它原先住在 `write/setFile.ts` 里，于是 `rules/interpreter.ts` 为了装这一个
 * 数字，要 import 整个文件写入原语——而那条链往下是 `undo.ts`、`policy.ts`、
 * `write/mainWorldBridge.ts`，全是浏览器里的东西。
 *
 * 这条边不是理论问题：argoland 的服务端签发规则包之前要**校验并编译**每一份
 * 规则（`createRuntimeApplyRegistry`），它 vendored 的正是解释器这一支。于是
 * 「解释器 → setFile」这一根线，把 `import.meta.env` 和 WebExtension 的
 * `browser` 全局拖进了一个 Node 进程里，服务端编译不过
 * （2026-09-17 实测 TS2304 `Cannot find name 'browser'`）。
 *
 * 一个数字不该有这样的代价。
 */

/** 缺省深度：与本机制不存在时逐字一致。 */
export const FILE_CONTEXT_MAX_DEPTH = 4;

/**
 * 厂商可以把上下文深度抬高到这个上限内的某个值。
 *
 * 为什么需要：有的厂商把简历标题挂得很高。BambooHR（2026-09-16 于
 * nomadgcs.bamboohr.com 抓 DOM 实测）的祖先链是
 * `Resume*` → Flex → FileUpload → FileUploadInput → FileUploadToggle → input，
 * 标题在第 4 层之外；Workday 的 `Resume/CV` 是往上约 7 层的一个 `<h4>`。两家的
 * 标题**都存在**，只是够不着。2026-09-16 全量批测里 126 个必填简历框卡在这里
 * （workable 48 / bamboohr 40 / ashby 38）。
 *
 * 为什么是抬深度而不是让规则直接声明「这个就是简历」：BambooHR 有的版式里有
 * **两个** file 框（一个 `Resume*`、一个自定义附件题），唯一的区分就是各自上方
 * 那段文字——一条「这个 input 就是简历」的声明会把两个都认成简历（本仓
 * `apply-bamboohr-adapter` 那条测试当场抓到了）。抬深度保留了「文案必须说
 * Resume」这条判据：每个框仍各自往上找最近的标题，第二个框找到的是它自己的题干，
 * 照样被拒。
 *
 * 上限 8：再深就会够到整个表单的段落，那时读到的不是这一栏的标签。
 */
export const FILE_CONTEXT_MAX_DEPTH_CEILING = 8;

let current: number = FILE_CONTEXT_MAX_DEPTH;

/** 解释器编译一份规则时调用；换规则即换设定，不累积。 */
export function installFileContextMaxDepth(depth: number | null): void {
  current = depth === null
    ? FILE_CONTEXT_MAX_DEPTH
    : Math.min(Math.max(depth, FILE_CONTEXT_MAX_DEPTH), FILE_CONTEXT_MAX_DEPTH_CEILING);
}

/** 此刻生效的深度。 */
export function fileContextMaxDepth(): number {
  return current;
}
