import type { KernelAiAnswersOutcome } from './aiAnswers';
import type { AutofillDockHandle } from './autofillDock';

/**
 * 手势填写一轮在浮层上怎么收尾（2026-09-24）。
 *
 * 负责人在 Workday 第 2 页看到：规则那几遍一写完，浮层就换成「这一页填好了」、摆出「继续到下一页」，AI 代答的答案
 * 过几秒才默默填上；他以为填完了去点继续，答案还在路上，网站没有翻页。他的话：「ai 如果在启用的话，就代表正在填写，
 * 那个黑色的进度框应该还显示着，显示 ai 在填写，除非 ai 也写不出来」。所以：
 *
 *  · 没有送题给 AI：当场收尾，与从前一样——写成了一项以上是「填好了」，一项都没写成就报那一条真实的拒绝理由；
 *  · 送了：进度卡留着（调用方在把规则那几遍的终局单子交给浮层之前已经说了 `AI_DRAFTING`），等 AI 的结局再收尾：
 *    写上了几项就算进「填好了」；回来晚了（摆「填入 AI 答案」）、没写出来、被拒、次数用完，都与没有 AI 时一样；
 *  · 2026-09-24 起答案是一条流（`plan/stream`）：AI 的结局就是**流结束**。流还开着，进度卡就留着（先到的选择题
 *    已经一批批写上、单子一批批换过）；流结束时写上的总数算进「填好了」——晚到的改成按钮（READY）时，早到、已经
 *    写上的那几项也算；按「停止」，调用方同一个信号把流关掉，之后到的一个字不写；
 *  · 等的时候用户按了「停止」：不再等，当场照「已停止」收尾。写入那一侧收到同一个停止信号就不再往下写；按下的那一刻
 *    正写到一半的，已经写上网页的那几项照实画上去、标成 AI 代答（网页上有 AI 写的字，浮层不能不认），别的不画；
 *  · 这一轮已经作废（新的一轮、翻页、撤销、浮层换了）：什么都不做——浮层上已经不是这一轮了。
 *
 * 等多久不在这里定：AI 的请求自己有时限（内容脚本 95 秒、worker 80 秒），30 秒的点击凭证也照旧。写什么、凭什么写，
 * 这里一概不碰——只决定浮层什么时候、怎么收尾。
 *
 * 连填（2026-09-28 负责人：按一下「自动填写」，一页一页填到检查页）：这一页有了结局（AI 与求职信都有了）之后先问 `next`
 * 往不往下翻。它接手了（替他按网站的下一步，浮层交给它），这里就不收尾；它说停下，照常收尾——等它回话的那一会儿他按了
 * 「停止」，照「已停止」收尾。
 */

/** 收尾要用的那几样。内容脚本里是此刻的浮层（它会换：换脸、让给助手），所以每次现取。 */
export type GestureRunDock = Pick<AutofillDockHandle, 'setAiAnswers' | 'finishRun' | 'reportBlocked'>;

export interface GestureRunClose {
  readonly dock: () => GestureRunDock | null;
  /** 规则那几遍写成了几项。 */
  readonly filled: number;
  /** 一项都没写成时的第一条拒绝理由（稳定码）；没有就是「这一页没有我们能用你资料填的」。 */
  readonly refused?: string | undefined;
  /** 这一轮的 AI 代答；没有送题就没有。 */
  readonly ai?: Readonly<{ outcome: Promise<KernelAiAnswersOutcome> }> | undefined;
  /**
   * 这一轮开填时还在写的求职信（2026-09-28 负责人：信在写，进度框就该还在）：附上了、要再点一下、附不了都算有了结局，
   * `settled` 交回写上了几栏。开填时就有信（随这一轮写了）、或者表上没有求职信栏，就没有这一项。
   */
  readonly letter?: Readonly<{ settled: Promise<number> }> | undefined;
  /** 这一轮的「停止」（进度卡上那颗按钮；新的一轮开始时也会按下它）。 */
  readonly stop: AbortSignal;
  /** 这一轮还算不算数：没开新的一轮、没翻页、没撤销、浮层上还是它。 */
  readonly current: () => boolean;
  /**
   * AI 的结局到了、这一轮还算数：调用方把它画上去（换单子、摆「填入 AI 答案」、说次数用完、「用 AI 写」）。按过「停止」
   * 之后只会为写上了的那几项再叫一次（`APPLIED`）。
   */
  readonly onAiOutcome?: ((outcome: KernelAiAnswersOutcome) => void) | undefined;
  /**
   * 连填（2026-09-28）：这一页有了结局，交这一页写成了几项（规则、AI、求职信合计）。交回 true：连填接手了浮层（往下翻），
   * 不在这里收尾；false：照常收尾。没有连填就没有这一项。
   */
  readonly next?: ((written: number) => Promise<boolean>) | undefined;
}

export function closeGestureRun(input: GestureRunClose): Promise<void> {
  const end = (aiWritten: number): void => {
    const dock = input.dock();
    if (input.filled + aiWritten > 0) {
      dock?.finishRun({ started: true, outcome: 'FILLED' });
      return;
    }
    dock?.reportBlocked(input.refused ?? 'NOTHING_FILLED');
  };
  /** 这一页有了结局：连填要往下翻就交给它，否则照常收尾（问它的那一会儿按了「停止」就照「已停止」收尾）。 */
  const settle = (aiWritten: number): Promise<void> => {
    const next = input.next;
    if (next === undefined) {
      end(aiWritten);
      return Promise.resolve();
    }
    const finish = (continued: boolean): void => {
      if (continued || !input.current()) return;
      if (input.stop.aborted) {
        const dock = input.dock();
        dock?.setAiAnswers({ kind: 'IDLE' });
        dock?.finishRun({ started: true, outcome: 'STOPPED' });
        return;
      }
      end(aiWritten);
    };
    return next(input.filled + aiWritten).then(finish, (error: unknown) => {
      // 连填那一侧出了错：照常收尾，别让进度卡一直转；错误照旧抛给调用方。
      finish(false);
      throw error;
    });
  };
  const ai = input.ai;
  const letter = input.letter;
  if (ai === undefined && letter === undefined) return settle(0);
  let unhook = (): void => {};
  const stopped = new Promise<null>((resolve) => {
    if (input.stop.aborted) {
      resolve(null);
      return;
    }
    const onAbort = (): void => resolve(null);
    input.stop.addEventListener('abort', onAbort, { once: true });
    unhook = () => input.stop.removeEventListener('abort', onAbort);
  });
  // AI 的结局一到就画（不等信）；画的那一段出了错也不拦着收尾，错误等收尾之后照旧抛给调用方。
  let drawError: unknown = null;
  const aiWritten: Promise<number> = ai === undefined ? Promise.resolve(0) : ai.outcome.then((outcome) => {
    if (input.stop.aborted || !input.current()) return 0;
    try {
      input.onAiOutcome?.(outcome);
    } catch (error) {
      drawError ??= error;
    }
    // 流上早到、已经写上网页的也算（READY：晚到的那几题改成按钮，早到的留在页面上，2026-09-24）。
    return outcome.kind === 'APPLIED' || outcome.kind === 'READY' ? outcome.written : 0;
  });
  const letterWritten: Promise<number> = letter === undefined ? Promise.resolve(0) : letter.settled.catch(() => 0);
  return Promise.race([Promise.all([aiWritten, letterWritten]), stopped]).then((written) => {
    unhook();
    if (!input.current()) return;
    if (written === null) {
      const dock = input.dock();
      dock?.setAiAnswers({ kind: 'IDLE' });
      dock?.finishRun({ started: true, outcome: 'STOPPED' });
      if (ai !== undefined) {
        void ai.outcome.then((late) => {
          if (late.kind === 'APPLIED' && input.current()) input.onAiOutcome?.(late);
        });
      }
      return;
    }
    const closing = settle(written[0] + written[1]);
    if (drawError !== null) {
      const error = drawError;
      return closing.then(() => { throw error; });
    }
    return closing;
  });
}
