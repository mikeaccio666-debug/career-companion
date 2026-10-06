import { EASE, EASE_OUT, SPRING } from './css';
import { animate, el, wait } from './dom';
import { icon } from './icons';

/**
 * 「提交」变成一只信封（2026-09-23；负责人对设计稿的修改：要**像信封展开**，颜色仍是提交按钮的深蓝）。
 *
 * 结构取真信封：上沿一片 V 形翻盖，向上翻开时露出里衬；下面是两侧与底边折起来的口袋，折边在深蓝上
 * 用一道细高光勾出来。**比例仍是那颗按钮**（负责人第二次修改：不要真信封的比例）：宽度不变、底边不动，
 * 只往上长高一截，成一只又长又扁的信封。颜色全部取自主按钮的 token（`#1B2542 → #0A1128` 渐变、
 * 顶部 1px 内高光、同一组投影、12px 圆角），里衬与背板只是同一族深蓝提亮一档。
 *
 * 节拍：
 *  1. 按钮变信封（520ms）：底栏里那颗「提交」原地往上长高一截，字淡出，折边与翻盖长出来；
 *  2. 翻盖掀开（600ms）：绕上沿向后翻到 180°，露出里衬，信封口张开；
 *  3. 卡片装进去（每张约 820ms，间隔 160ms）：主卡、需要你、代填各自缩到信封内宽，
 *     从口子上方落进口袋——被前面的口袋挡住，像真的把一封信塞进去；
 *  4. 合上（560ms，带一点回弹）：翻盖盖回来，信封轻轻一顿——**这一刻**才替用户按网站的提交；
 *  5. 等网站给结论：信封轻轻呼吸；
 *  6. 成功：像按钮上的字一样居中弹出绿色的勾，逐字打出「提交成功」；
 *  7. 回到首页：信封升到主卡的位置、变回「自动填写」那颗按钮。
 *  失败：信封轻轻摇一下，变回底栏的按钮，卡片淡回原处。
 *
 * 全部在一个独立的叠层里做（原件隐藏、克隆出来动），滚动区的裁切管不到它。叠层只在我们的 shadow 里。
 */

/** 信封与飞回首页的那颗按钮上写的几个字（跟着浮层的界面语言）。 */
export interface EnvelopeWords {
  /** 底栏那颗「提交」。 */
  readonly submit: string;
  /** 成功后逐字打出来的那一句（「提交成功」）。 */
  readonly submitted: string;
  /** 落回首页时变成的那颗「自动填写」。 */
  readonly autofill: string;
}

export interface EnvelopeInput {
  readonly doc: Document;
  readonly words: EnvelopeWords;
  /** 面板里的内容层（页头以下都归它）；叠层挂在这里。 */
  readonly layer: HTMLElement;
  /** 底栏那颗「提交」。 */
  readonly button: HTMLElement;
  /** 要装进信封的卡片（主卡、需要你、代填……），从上到下。 */
  readonly cards: readonly HTMLElement[];
  /** 装信封时先淡出的小标题与脚注。 */
  readonly fades: readonly HTMLElement[];
  readonly reduced: boolean;
  /** 翻盖合上的那一刻。 */
  readonly onPress: () => void;
  /** 信封一出现就是封好的（整页跳到确认页之后接着播收尾）：跳过变形、掀盖、装信、合盖。 */
  readonly sealed?: boolean;
}

export interface EnvelopeRun {
  /** 网站确认提交成功：打勾、打字，然后飞回首页的「自动填写」。`land` 在飞之前把首页摆好并交回落点。 */
  readonly succeed: (land: () => Promise<HTMLElement | null>, scroller: HTMLElement) => Promise<void>;
  /** 没提交成功：信封摇一下，变回按钮，卡片回到原处。 */
  readonly fail: () => Promise<void>;
  /** 立刻收掉一切（面板被拆、页面离开）。 */
  readonly cancel: () => void;
}

const NAVY = 'linear-gradient(180deg,#1B2542,#0A1128)';
const NAVY_SH = 'inset 0 1px 0 rgba(255,255,255,.12),0 1px 2px rgba(10,17,40,.25),0 10px 20px -12px rgba(10,17,40,.6)';
const ENVELOPE_SH = 'inset 0 1px 0 rgba(255,255,255,.12),0 2px 4px rgba(10,17,40,.18),0 22px 44px -18px rgba(10,17,40,.62)';
const CARD_SH = '0 0 0 .5px rgba(10,17,40,.06),0 1px 2px rgba(10,17,40,.04)';
/**
 * 信封有多高：那颗按钮的 1.9 倍（至少 76px）。宽度不变——又长又扁，一眼还是那颗「提交」，
 * 不是一只真实比例的信封（负责人 2026-09-23 第二次修改）。
 */
const envelopeHeight = (buttonH: number): number => Math.round(Math.max(buttonH * 1.9, 76));

export function startEnvelope(input: EnvelopeInput): EnvelopeRun {
  const { doc, layer, button, reduced, words: say } = input;
  const h = <K extends keyof HTMLElementTagNameMap>(tag: K, css: string, parent?: HTMLElement) => {
    const node = el(doc, tag);
    node.style.cssText = css;
    (parent ?? fx).append(node);
    return node;
  };
  const hiddenNodes: HTMLElement[] = [];
  const running: Animation[] = [];
  const keep = (anim: Animation | null): Animation | null => { if (anim !== null) running.push(anim); return anim; };
  let cancelled = false;

  const L = layer.getBoundingClientRect();
  const local = (rect: DOMRect) => ({ x: rect.left - L.left, y: rect.top - L.top, w: rect.width, h: rect.height });
  const btn = local(button.getBoundingClientRect());

  // 叠层：盖住整个内容层，不接指针。
  const fx = el(doc, 'div');
  fx.dataset.subfx = '1';
  // 纯装饰：里面是卡片的克隆（带着按钮），不能让读屏念两遍、也不能 Tab 进去。
  fx.setAttribute('aria-hidden', 'true');
  fx.toggleAttribute('inert', true);
  fx.style.cssText = 'position:absolute;inset:0;overflow:hidden;z-index:6;pointer-events:none';
  layer.append(fx);

  // 信封的目标尺寸：就是那颗按钮——宽度不变、底边不动，往上长高一截。
  const envW = Math.round(btn.w);
  const envH = envelopeHeight(btn.h);
  const envX = Math.round(btn.x);
  const envY = Math.round(btn.y + btn.h - envH);

  // 结构（从后到前）：背板（里面那一面）→ 信纸层（卡片在这里，只在口袋以上可见）→ 口袋（两侧与底边折起）→ 翻盖。
  const env = h('div', `position:absolute;left:${btn.x}px;top:${btn.y}px;width:${btn.w}px;height:${btn.h}px;perspective:760px;transform-origin:50% 100%`);
  const body = h('div', `position:absolute;inset:0;border-radius:12px;background:${NAVY};box-shadow:${NAVY_SH}`, env);
  const back = h('div', 'position:absolute;inset:0;border-radius:inherit;overflow:hidden;opacity:0;'
    + 'background:linear-gradient(180deg,#2B3760 0%,#222D51 55%,#1B2542 100%);box-shadow:inset 0 2px 8px rgba(0,0,0,.34),inset 0 -1px 0 rgba(255,255,255,.04)', body);
  // 信纸层：上面不封口（卡片从口子上方进来），下面到信封底。
  const letters = h('div', 'position:absolute;left:-800px;right:-800px;top:-3000px;bottom:0;overflow:hidden;z-index:10', env);
  // 口袋：底边一片、两侧各一片；上沿是一道浅浅的 V。
  const pocket = h('div', 'position:absolute;inset:0;z-index:30;border-radius:12px;overflow:hidden;opacity:0', env);
  const side = (from: 'left' | 'right') => h('div', `position:absolute;inset:0;background:linear-gradient(${from === 'left' ? '100deg' : '260deg'},#1E2847 0%,#141D38 70%);`
    + `clip-path:polygon(${from === 'left' ? '0 0,50% 44%,0 100%' : '100% 0,50% 44%,100% 100%'})`, pocket);
  side('left');
  side('right');
  h('div', 'position:absolute;inset:0;background:linear-gradient(0deg,#0C1530 0%,#18223F 100%);clip-path:polygon(0 100%,50% 44%,100% 100%)', pocket);
  // 折边的细高光：四条线交于一点（两个下角、两个上角各一条），像真信封背面那个 X。
  const seams = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  seams.setAttribute('viewBox', '0 0 100 100');
  seams.setAttribute('preserveAspectRatio', 'none');
  seams.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible';
  for (const d of ['M0 100 L50 44 L100 100', 'M0 0 L50 44', 'M100 0 L50 44']) {
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'rgba(255,255,255,.12)');
    path.setAttribute('stroke-width', '.9');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    seams.append(path);
  }
  pocket.append(seams);
  // 信封正面上的字：「提交」→ 对勾 + 逐字「提交成功」→「自动填写」。
  const face = h('div', 'position:absolute;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;color:#fff;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;pointer-events:none', env);
  const l1 = h('span', 'position:absolute', face);
  l1.textContent = say.submit;
  // 成功的那一行：绿色的勾 + 逐字打出「提交成功」，像按钮上的字一样居中。没打出来的字先透明占着位，
  // 打字时整行不左右挪。
  const l2 = h('span', 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:9px;opacity:0;letter-spacing:.3px;text-shadow:0 1px 1px rgba(0,0,0,.25)', face);
  const seal = h('span', 'flex:none;width:20px;height:20px;border-radius:50%;background:#2E8A63;'
    + 'box-shadow:0 0 0 2px rgba(10,17,40,.45),0 4px 10px -2px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;transform:scale(0)', l2);
  seal.append(icon(doc, 'check', 11, { stroke: 3.4, color: '#fff' }));
  const words = h('span', 'display:inline-flex;align-items:center;white-space:nowrap', l2);
  const typed = h('span', '', words);
  const caret = h('span', 'display:inline-block;width:1.5px;height:15px;margin:0 1px 0 2px;background:#fff;animation:aBlink 1s steps(1) infinite', words);
  const ghost = h('span', 'color:transparent;text-shadow:none', words);
  ghost.textContent = say.submitted;
  const l3 = h('span', 'position:absolute;display:flex;align-items:center;gap:8px;opacity:0;letter-spacing:.2px;font-size:var(--fs-body);line-height:var(--lh-body)', face);
  l3.append(icon(doc, 'spark', 17, { stroke: 1.7 }), doc.createTextNode(say.autofill));
  // 翻盖：一片 V 形，外面与按钮同色，里面是里衬；绕上沿翻。
  // 淡入淡出与前后层级都放在外面这一层：翻盖自己身上不能有透明度动画——Chrome 见到它就把 preserve-3d
  // 压平，掀开时翻过去的是外面那片的镜像，里衬永远露不出来。透视也挂在这一层（它是翻盖的直接父级）。
  const flapH = Math.round(envH * 0.56);
  const flapWrap = h('div', 'position:absolute;inset:0;z-index:40;perspective:760px;pointer-events:none;opacity:0', env);
  const flap = h('div', `position:absolute;left:0;right:0;top:0;height:${flapH}px;transform-origin:50% 0;transform-style:preserve-3d;transform:rotateX(0deg)`, flapWrap);
  // 合上时翻盖投在口袋上的那道影子：单独一层（投影与裁切放在同一个元素上会被裁掉）；翻过去就看不见。
  const shade = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  shade.setAttribute('viewBox', '0 0 100 100');
  shade.setAttribute('preserveAspectRatio', 'none');
  shade.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;transform:translateY(2.5px);'
    + 'filter:blur(2.4px);backface-visibility:hidden;-webkit-backface-visibility:hidden';
  const shadePath = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  shadePath.setAttribute('d', 'M3 0 L50 100 L97 0 Z');
  shadePath.setAttribute('fill', 'rgba(3,7,20,.42)');
  shade.append(shadePath);
  flap.append(shade);
  const flapOut = h('div', `position:absolute;inset:0;background:linear-gradient(180deg,#232E52 0%,#141D39 100%);clip-path:polygon(0 0,100% 0,50% 100%);`
    + 'border-radius:12px 12px 0 0;overflow:hidden;backface-visibility:hidden;-webkit-backface-visibility:hidden', flap);
  const flapEdge = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  flapEdge.setAttribute('viewBox', '0 0 100 100');
  flapEdge.setAttribute('preserveAspectRatio', 'none');
  flapEdge.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible';
  const edge = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  edge.setAttribute('d', 'M0 0 L50 100 L100 0');
  edge.setAttribute('fill', 'none');
  edge.setAttribute('stroke', 'rgba(255,255,255,.2)');
  edge.setAttribute('stroke-width', '.9');
  edge.setAttribute('vector-effect', 'non-scaling-stroke');
  flapEdge.append(edge);
  flapOut.append(flapEdge);
  // 里衬：它自己先翻了 180°，所以本地坐标里尖朝上、底边在下——翻开以后才是底边贴着信封口、尖朝上。
  // 光从上面来：尖上亮一档，折痕那里压暗一点。
  h('div', 'position:absolute;inset:0;background:linear-gradient(180deg,#3D4A7A 0%,#2E3A66 58%,#243058 100%);clip-path:polygon(50% 0,100% 100%,0 100%);'
    + 'border-radius:0 0 12px 12px;overflow:hidden;transform:rotateX(180deg);backface-visibility:hidden;-webkit-backface-visibility:hidden;'
    + 'box-shadow:inset 0 -5px 9px -2px rgba(0,0,0,.34)', flap);

  button.style.visibility = 'hidden';
  hiddenNodes.push(button);

  let settle: Promise<void>;
  const run = async (): Promise<void> => {
    if (reduced || input.sealed === true) {
      back.style.opacity = '1';
      pocket.style.opacity = '1';
      flapWrap.style.opacity = '1';
      env.style.left = `${envX}px`; env.style.top = `${envY}px`; env.style.width = `${envW}px`; env.style.height = `${envH}px`;
      body.style.boxShadow = ENVELOPE_SH;
      l1.style.opacity = '0';
      for (const card of input.cards) if (visible(card)) { card.style.visibility = 'hidden'; hiddenNodes.push(card); }
      input.onPress();
      return;
    }
    // 1 · 按钮变信封
    keep(animate(env, [
      { left: `${btn.x}px`, top: `${btn.y}px`, width: `${btn.w}px`, height: `${btn.h}px` },
      { left: `${envX}px`, top: `${envY}px`, width: `${envW}px`, height: `${envH}px` },
    ], { duration: 520, easing: EASE, fill: 'forwards' }));
    keep(animate(body, [{ boxShadow: NAVY_SH }, { boxShadow: ENVELOPE_SH }], { duration: 520, easing: EASE, fill: 'forwards' }));
    keep(animate(l1, [{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' }));
    keep(animate(pocket, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 240, fill: 'forwards' }));
    keep(animate(flapWrap, [{ opacity: 0 }, { opacity: 1 }], { duration: 320, delay: 220, easing: EASE_OUT, fill: 'forwards' }));
    keep(animate(flap, [{ transform: 'rotateX(0deg) scaleY(.2)' }, { transform: 'rotateX(0deg) scaleY(1)' }], { duration: 320, delay: 220, easing: EASE_OUT, fill: 'forwards' }));
    await wait(560, false);
    if (cancelled) return;

    // 2 · 翻盖向上掀开，露出里衬
    keep(animate(back, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'forwards' }));
    keep(animate(flap, [{ transform: 'rotateX(0deg)' }, { transform: 'rotateX(180deg)' }], { duration: 600, easing: EASE, fill: 'forwards' }));
    setTimeout(() => { flapWrap.style.zIndex = '5'; }, 300);
    await wait(560, false);
    if (cancelled) return;

    // 3 · 卡片一张一张装进去
    for (const node of input.fades) keep(animate(node, [{ opacity: 1 }, { opacity: 0 }], { duration: 280, fill: 'forwards' }));
    const E = { x: envX, y: envY };
    const deck = input.cards.filter(visible);
    const clones = deck.map((card, index) => {
      const r = local(card.getBoundingClientRect());
      const clone = card.cloneNode(true) as HTMLElement;
      clone.removeAttribute('data-deck');
      clone.removeAttribute('data-hero');
      clone.style.cssText += `;position:absolute;margin:0;z-index:${10 + index};left:${r.x - E.x + 800}px;top:${r.y - E.y + 3000}px;width:${r.w}px;height:${r.h}px;`
        + `box-sizing:border-box;transform-origin:50% 0;overflow:hidden;box-shadow:${CARD_SH};transition:none;pointer-events:none`;
      letters.append(clone);
      card.style.visibility = 'hidden';
      hiddenNodes.push(card);
      return { clone, r };
    });
    const innerW = envW - 26;
    const STEP = 160;
    const DUR = 820;
    clones.forEach(({ clone, r }, index) => {
      const scale = innerW / r.w;
      const dx = (envW / 2) - ((r.x - E.x) + r.w / 2);
      const liftTop = -(r.y - E.y) - Math.round(r.h * scale) - 12;
      const into = -(r.y - E.y) + Math.round(envH * 0.18);
      keep(animate(clone, [
        { transform: 'translate(0px,0px) scale(1) rotate(0deg)', opacity: 1, boxShadow: CARD_SH },
        { transform: `translate(${dx * 0.6}px,${liftTop}px) scale(${scale}) rotate(-1.6deg)`, opacity: 1, boxShadow: '0 18px 36px -16px rgba(10,17,40,.45)', offset: 0.55 },
        { transform: `translate(${dx}px,${into}px) scale(${scale}) rotate(0deg)`, opacity: 1, boxShadow: CARD_SH },
      ], { duration: DUR, easing: 'cubic-bezier(.45,0,.2,1)', delay: index * STEP, fill: 'forwards' }));
    });
    await wait((Math.max(clones.length, 1) - 1) * STEP + DUR + 120, false);
    if (cancelled) return;

    // 4 · 合上，轻轻一顿——这一刻按网站的提交
    flapWrap.style.zIndex = '40';
    keep(animate(flap, [{ transform: 'rotateX(180deg)' }, { transform: 'rotateX(0deg)' }], { duration: 560, easing: 'cubic-bezier(.34,1.12,.64,1)', fill: 'forwards' }));
    await wait(430, false);
    if (cancelled) return;
    letters.style.display = 'none';
    keep(animate(env, [{ transform: 'scale(1)' }, { transform: 'scale(1.03)' }, { transform: 'scale(1)' }], { duration: 420, easing: SPRING }));
    input.onPress();
    await wait(420, false);
    if (cancelled) return;
    // 5 · 等网站：轻轻呼吸
    env.style.animation = 'aBreathe 1.8s ease-in-out infinite';
  };
  settle = run().catch(() => {});

  const restore = (): void => {
    for (const node of hiddenNodes) node.style.visibility = '';
    hiddenNodes.length = 0;
    for (const node of input.fades) for (const anim of node.getAnimations?.() ?? []) anim.cancel();
  };
  const cleanup = (): void => {
    for (const anim of running) { try { anim.cancel(); } catch { /* 已结束 */ } }
    running.length = 0;
    restore();
    fx.remove();
  };

  return {
    cancel: () => { cancelled = true; cleanup(); },
    fail: async () => {
      await settle;
      if (cancelled) return;
      env.style.animation = '';
      if (!reduced) {
        await animate(env, [
          { transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' },
          { transform: 'translateX(-4px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(0)' },
        ], { duration: 420, easing: 'ease-in-out' })?.finished.catch(() => {});
        const now = local(env.getBoundingClientRect());
        keep(animate(flapWrap, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }));
        keep(animate(pocket, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }));
        keep(animate(back, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }));
        keep(animate(env, [
          { left: `${now.x}px`, top: `${now.y}px`, width: `${now.w}px`, height: `${now.h}px` },
          { left: `${btn.x}px`, top: `${btn.y}px`, width: `${btn.w}px`, height: `${btn.h}px` },
        ], { duration: 480, easing: EASE, fill: 'forwards' }));
        keep(animate(body, [{ boxShadow: ENVELOPE_SH }, { boxShadow: NAVY_SH }], { duration: 480, easing: EASE, fill: 'forwards' }));
        keep(animate(l1, [{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 260, fill: 'forwards' }));
        await wait(500, false);
      }
      const back2 = hiddenNodes.slice();
      cleanup();
      if (!reduced) for (const node of back2) animate(node, [{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: EASE_OUT });
    },
    succeed: async (land, scroller) => {
      await settle;
      if (cancelled) return;
      env.style.animation = '';
      // 6 · 封印变成绿色的勾，逐字打出「提交成功」
      if (!reduced) {
        keep(animate(seal, [{ transform: 'scale(0)' }, { transform: 'scale(1.12)', offset: 0.7 }, { transform: 'scale(1)' }], { duration: 420, easing: SPRING, fill: 'forwards' }));
        keep(animate(l2, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'forwards' }));
        await wait(320, false);
        const text = say.submitted;
        // 一个字 150ms（「提交成功」四个字 600ms）；字多的语言（英文 Submitted）把同样的 600ms 摊开，不拖长这一段。
        const step = Math.min(150, Math.round(600 / Math.max(1, text.length)));
        for (let i = 1; i <= text.length; i += 1) {
          await wait(step, false);
          if (cancelled) return;
          typed.textContent = text.slice(0, i);
          ghost.textContent = text.slice(i);
        }
        await wait(900, false);
        caret.style.visibility = 'hidden';
      } else {
        seal.style.transform = 'scale(1)';
        l2.style.opacity = '1';
        typed.textContent = say.submitted;
        ghost.textContent = '';
        caret.style.visibility = 'hidden';
      }
      if (cancelled) return;
      // 7 · 回到首页：信封升到「自动填写」的位置，变回那颗按钮
      const target = await land();
      scroller.scrollTop = 0;
      restore();
      if (target === null || reduced) { cleanup(); return; }
      const heroNode = target.closest<HTMLElement>('[data-hero]') ?? target;
      // 主卡此刻多半还在从「总结」变回「按钮」的高度过渡里、它上面的岗位卡在从一行长回展开的样子：先让首页里这些
      // 过渡都走到终点再量，否则信封落在半途的位置上、落定时再跳一下。它们在落地期间是藏着或透明的，跳过看不出来。
      for (const anim of [...(scroller.getAnimations?.({ subtree: true }) ?? []), ...(heroNode.getAnimations?.() ?? [])]) {
        try {
          anim.finish();
        } catch {
          // 无限循环的动画（转圈）不能 finish；它们不影响量尺寸。
        }
      }
      const to = local(heroNode.getBoundingClientRect());
      heroNode.style.visibility = 'hidden';
      hiddenNodes.push(heroNode);
      const from = local(env.getBoundingClientRect());
      keep(animate(env, [
        { left: `${from.x}px`, top: `${from.y}px`, width: `${from.w}px`, height: `${from.h}px`, transform: 'none' },
        { left: `${to.x}px`, top: `${to.y}px`, width: `${to.w}px`, height: `${to.h}px`, transform: 'none' },
      ], { duration: 860, easing: EASE, fill: 'forwards' }));
      keep(animate(body, [
        { borderRadius: '12px', boxShadow: ENVELOPE_SH },
        { borderRadius: '16px', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.1),0 1px 2px rgba(10,17,40,.2),0 12px 26px -14px rgba(10,17,40,.7)' },
      ], { duration: 860, easing: EASE, fill: 'forwards' }));
      for (const part of [flapWrap, pocket, back, seal]) keep(animate(part, [{ opacity: 1 }, { opacity: 0 }], { duration: 320, easing: 'ease', fill: 'forwards' }));
      keep(animate(l2, [{ opacity: 1 }, { opacity: 0 }], { duration: 280, fill: 'forwards' }));
      keep(animate(l3, [{ opacity: 0 }, { opacity: 1 }], { duration: 340, delay: 480, fill: 'forwards' }));
      const items = Array.from(scroller.querySelectorAll<HTMLElement>('[data-home-item]'));
      items.forEach((item, index) => animate(item, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], {
        duration: 480, easing: EASE_OUT, delay: 520 + index * 80, fill: 'backwards',
      }));
      await wait(880, false);
      cleanup();
    },
  };
}

function visible(node: HTMLElement): boolean {
  const rect = node.getBoundingClientRect();
  if (rect.height <= 4) return false;
  const clip = node.closest<HTMLElement>('[data-clip]');
  return clip === null || clip.getBoundingClientRect().height > 4;
}

/** 主卡是「自动填写」那颗按钮时的样子（css.ts 的 DARK_SH）：飞回去的那一块落地时换成它。 */
const HERO_SH = 'inset 0 1px 0 rgba(255,255,255,.1),0 1px 2px rgba(10,17,40,.2),0 12px 26px -14px rgba(10,17,40,.7)';
/** 飞回首页那一段（信封第 7 段）：飞多久、首页各块从第几毫秒起依次淡入、间隔多少。 */
const HOME_FLIGHT_MS = 860;
const HOME_ITEMS_DELAY_MS = 520;
const HOME_ITEMS_STEP_MS = 80;

export interface HomeFlightInput {
  readonly doc: Document;
  readonly words: EnvelopeWords;
  /** 面板里的内容层（页头以下都归它）；叠层挂在这里。 */
  readonly layer: HTMLElement;
  /** 底栏那颗深蓝的主按钮（逐项处理 / 提交 / 继续到下一页）：飞回去的就是它。 */
  readonly button: HTMLElement;
  /** 填完那一幕里看得见的几块（滚动区、底栏）：克隆一份摆在原处淡出，真的那几块马上换成首页。 */
  readonly snapshot: readonly HTMLElement[];
  readonly reduced: boolean;
  /** 把浮层换成首页，交回落点（「自动填写」所在的主卡）与要依次淡入的几块（岗位卡、你的资料……）。 */
  readonly land: () => { readonly anchor: HTMLElement | null; readonly items: readonly HTMLElement[] };
}

export interface HomeFlight {
  /** 落地、收拾干净之后。 */
  readonly done: Promise<void>;
  /** 立刻收掉一切（面板被拆、又开了别的动作）。 */
  readonly cancel: () => void;
}

/**
 * 「回到主页」（⋯ 菜单，2026-09-24 负责人）：没有提交，所以没有信封——底栏那颗深蓝的按钮直接飞到首页
 * 「自动填写」的位置、变回那颗按钮（FLIP；时长与缓动照信封第 7 段：860ms、浮层的 EASE，字在 280ms 里淡出、
 * 480ms 起淡入「自动填写」），然后首页一块一块淡进来（520ms 起、每块间隔 80ms）。填完那一幕的内容是克隆的，
 * 在原处淡出；真的节点当场就换成了首页，动画只在我们自己的叠层里。减少动态时直接换。
 */
export function flyHome(input: HomeFlightInput): HomeFlight {
  const { doc, layer, button } = input;
  if (input.reduced) {
    input.land();
    return { done: Promise.resolve(), cancel: () => {} };
  }
  const L = layer.getBoundingClientRect();
  const local = (rect: DOMRect) => ({ x: rect.left - L.left, y: rect.top - L.top, w: rect.width, h: rect.height });
  const from = local(button.getBoundingClientRect());
  const label = (button.textContent ?? '').trim();
  const running: Animation[] = [];
  const keep = (anim: Animation | null): void => { if (anim !== null) running.push(anim); };
  const hidden: HTMLElement[] = [];
  const hide = (node: HTMLElement): void => { node.style.visibility = 'hidden'; hidden.push(node); };

  const fx = el(doc, 'div');
  fx.dataset.homeFlight = '1';
  fx.setAttribute('aria-hidden', 'true');
  fx.toggleAttribute('inert', true);
  fx.style.cssText = 'position:absolute;inset:0;overflow:hidden;z-index:6;pointer-events:none';
  layer.append(fx);
  hide(button);
  // 填完那一幕：克隆一份摆在原处（滚动到哪就停在哪），等会儿淡出。
  const ghosts = input.snapshot.filter((node) => node.isConnected && node.getBoundingClientRect().height > 4).map((node) => {
    const at = local(node.getBoundingClientRect());
    const clone = node.cloneNode(true) as HTMLElement;
    for (const marked of [clone, ...Array.from(clone.querySelectorAll<HTMLElement>('[data-in],[data-hero],[data-deck]'))]) {
      marked.removeAttribute('data-in');
      marked.removeAttribute('data-hero');
      marked.removeAttribute('data-deck');
    }
    clone.style.cssText += `;position:absolute;left:${at.x}px;top:${at.y}px;right:auto;bottom:auto;width:${at.w}px;height:${at.h}px;`
      + 'margin:0;transform:none;opacity:1;transition:none;overflow:hidden;visibility:visible';
    fx.append(clone);
    clone.scrollTop = node.scrollTop;
    return clone;
  });
  // 那颗按钮：同样的深蓝、圆角与投影，字写着它原来的字。
  const block = el(doc, 'div');
  block.style.cssText = `position:absolute;left:${from.x}px;top:${from.y}px;width:${from.w}px;height:${from.h}px;border-radius:12px;`
    + `background:${NAVY};box-shadow:${NAVY_SH};color:#fff;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600`;
  const was = el(doc, 'span');
  was.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center';
  was.textContent = label;
  const next = el(doc, 'span');
  next.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;letter-spacing:.2px;opacity:0';
  next.append(icon(doc, 'spark', 17, { stroke: 1.7 }), doc.createTextNode(input.words.autofill));
  block.append(was, next);
  fx.append(block);

  // 换成首页。主卡此刻多半还在从「总结」变回「按钮」的高度过渡里、岗位卡在从一行长回展开的样子：先让它们走到
  // 终点再量落点（它们在落地前是藏着或透明的，跳过这几段过渡看不出来）。
  const { anchor, items } = input.land();
  const hero = anchor?.closest<HTMLElement>('[data-hero]') ?? anchor;
  for (const node of [...(hero === null || hero === undefined ? [] : [hero]), ...items]) {
    for (const anim of node.getAnimations?.({ subtree: true }) ?? []) {
      try {
        anim.finish();
      } catch {
        // 无限循环的动画（转圈）不能 finish；它们不影响量尺寸。
      }
    }
  }
  const to = hero !== null && hero !== undefined && hero.isConnected ? local(hero.getBoundingClientRect()) : null;
  if (hero !== null && hero !== undefined) hide(hero);

  for (const ghost of ghosts) keep(animate(ghost, [{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: 'ease', fill: 'forwards' }));
  if (to !== null && to.w > 0 && to.h > 0) {
    keep(animate(block, [
      { left: `${from.x}px`, top: `${from.y}px`, width: `${from.w}px`, height: `${from.h}px` },
      { left: `${to.x}px`, top: `${to.y}px`, width: `${to.w}px`, height: `${to.h}px` },
    ], { duration: HOME_FLIGHT_MS, easing: EASE, fill: 'forwards' }));
    keep(animate(block, [
      { borderRadius: '12px', boxShadow: NAVY_SH },
      { borderRadius: '16px', boxShadow: HERO_SH },
    ], { duration: HOME_FLIGHT_MS, easing: EASE, fill: 'forwards' }));
    keep(animate(was, [{ opacity: 1 }, { opacity: 0 }], { duration: 280, fill: 'forwards' }));
    keep(animate(next, [{ opacity: 0 }, { opacity: 1 }], { duration: 340, delay: 480, fill: 'forwards' }));
  } else {
    keep(animate(block, [{ opacity: 1 }, { opacity: 0 }], { duration: 240, fill: 'forwards' }));
  }
  items.forEach((item, index) => keep(animate(item, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], {
    duration: 480, easing: EASE_OUT, delay: HOME_ITEMS_DELAY_MS + index * HOME_ITEMS_STEP_MS, fill: 'backwards',
  })));

  let finished = false;
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => { settle = resolve; });
  const cleanup = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    fx.remove();
    for (const node of hidden) node.style.visibility = '';
    hidden.length = 0;
    settle();
  };
  const timer = setTimeout(cleanup, HOME_FLIGHT_MS + 20);
  return {
    done,
    cancel: () => {
      // 走到终点而不是 cancel：首页那几块立刻出来；也不让 finished 以 AbortError 拒绝、成了没人接的拒绝。
      for (const anim of running) {
        try {
          anim.finish();
        } catch {
          // 已经结束、或已随叠层一起拿掉的动画：用不着再收。
        }
      }
      cleanup();
    },
  };
}

/**
 * 网站整页跳到了确认页：上一页的浮层没来得及把收尾播完。新一页挂上浮层时，信封已经封好，
 * 直接从封口那一刻接着播——封印变成绿色的勾、逐字打出「提交成功」，再落到「自动填写」上。
 */
export async function arriveEnvelope(input: {
  readonly doc: Document;
  readonly words: EnvelopeWords;
  readonly layer: HTMLElement;
  readonly anchor: HTMLElement;
  readonly reduced: boolean;
  readonly land: () => Promise<HTMLElement | null>;
  readonly scroller: HTMLElement;
}): Promise<void> {
  const L = input.layer.getBoundingClientRect();
  const a = input.anchor.getBoundingClientRect();
  // 和同一页里一样：是一颗按钮（主卡的宽度）往上长高一截，不是一只真实比例的信封。
  const width = Math.round(a.width);
  const height = envelopeHeight(46);
  const left = Math.round(a.left - L.left);
  // 放在面板中间偏上、主卡下面：落回「自动填写」时有一段看得见的上升，和同一页里提交成功时一样。
  const top = Math.round(Math.max(a.bottom - L.top + 36, (L.height - height) * 0.42));
  // 借同一套结构：先在按钮的位置搭一只信封（封好），跳过装信的那几段，直接收尾。
  const button = el(input.doc, 'div');
  button.style.cssText = `position:absolute;left:${left}px;top:${top + height - 46}px;width:${width}px;height:46px;visibility:hidden`;
  input.layer.append(button);
  // 首页（主卡与「你的资料」）先藏起来：信封落到主卡上的那一刻它们才淡进来，不让信封压在一页字上。
  const home = [input.anchor, ...Array.from(input.scroller.querySelectorAll<HTMLElement>('[data-home-item]'))];
  const run = startEnvelope({
    doc: input.doc,
    words: input.words,
    layer: input.layer,
    button,
    cards: home,
    fades: [],
    reduced: input.reduced,
    sealed: true,
    onPress: () => {},
  });
  const env = input.layer.querySelector<HTMLElement>('[data-subfx] > div');
  if (env !== null && !input.reduced) {
    env.style.left = `${left}px`;
    env.style.top = `${top}px`;
    animate(env, [{ opacity: 0, transform: 'translateY(10px) scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: SPRING });
    await wait(360, false);
  }
  button.remove();
  await run.succeed(input.land, input.scroller);
}
