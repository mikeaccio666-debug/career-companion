/**
 * 内容脚本注入后向 worker 要一次站点知识（规则）。站点知识不随包内置（2026-09-15 起整个移出产物），这条消息只取规则，不带
 * 任何授权——拿到它也只能「看懂页面」，动手仍要走完整的意向链。
 *
 * 2026-10-04（体检 10-6、吞掉的错第 1 条）：从前要不到就什么都不做、也不再要。页面加载那一刻后端抖一下，白标与公司自建的表
 * 这一整次加载都认不出、浮层不挂，后台一个码都没有。现在没要到（发信被拒、worker 还没有规则、答复不像样）就隔一会儿再要
 * **一次**，记 `SITE_KNOWLEDGE_RETRIED`；两次都没要到记 `SITE_KNOWLEDGE_UNAVAILABLE`。装规则照旧：要到了装要到的，
 * 没要到装空表（识别随之 fail closed）。整个过程不抛：调用方在 document_start，一个逃出去的异常就绕过外层的收尾。
 */
const RETRY_AFTER_MS = 1_500;

export interface SiteKnowledgeDeps {
  /** 问 worker（`apply-site-knowledge/get`）。 */
  readonly ask: () => Promise<unknown>;
  /** 编译好装进识别路径；null 是空表。 */
  readonly install: (rules: unknown) => Promise<void>;
  readonly onDiagnostic: (code: 'SITE_KNOWLEDGE_RETRIED' | 'SITE_KNOWLEDGE_UNAVAILABLE') => void;
  readonly wait?: (ms: number) => Promise<void>;
}

/** 交回装上的是不是要到的那一份规则。 */
export async function loadSiteKnowledge(deps: SiteKnowledgeDeps): Promise<boolean> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const rulesOf = async (): Promise<unknown> => {
    try {
      const reply = await deps.ask();
      const rules = typeof reply === 'object' && reply !== null ? (reply as { rules?: unknown }).rules : undefined;
      return rules === undefined ? null : rules;
    } catch {
      return null;
    }
  };
  let rules = await rulesOf();
  if (rules === null) {
    deps.onDiagnostic('SITE_KNOWLEDGE_RETRIED');
    await wait(RETRY_AFTER_MS);
    rules = await rulesOf();
  }
  try {
    await deps.install(rules);
  } catch {
    deps.onDiagnostic('SITE_KNOWLEDGE_UNAVAILABLE');
    return false;
  }
  if (rules === null) {
    deps.onDiagnostic('SITE_KNOWLEDGE_UNAVAILABLE');
    return false;
  }
  return true;
}
