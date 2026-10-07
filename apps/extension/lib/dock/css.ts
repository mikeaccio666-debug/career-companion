/**
 * 浮层的样式（2026-09-23 设计交接：`ArgoAI Autofill.dc.html` 的内联样式、
 * `handoff/02-视觉变量与尺寸.md` 与 `handoff/dock-theme.css` 的变量，逐项照搬）。
 *
 * 位置与尺寸（面板的 top/right/width/height/圆角、逐项处理小卡的高度）随视口与状态变化，
 * 由 `dock.ts` 按设计里 `renderVals` 的同一套算式写到元素上；这里只放不随状态变的部分。
 *
 * 字号只有四档（2026-09-24 负责人：大字都一个字号，全片字号种类不要太多），定义一次在 `.root` 上，
 * 浮层里每一处（包括 AI 标记与卡片、信封上的字）只用这四个变量，字号与行高成对写：
 *  · `--fs-title` 20/28，600：一幕里最多一处——总结那一句、首页展开的岗位名、资料页的页名（没法填的几张脸与失败卡的那一句也算这一幕的总结）；
 *  · `--fs-body` 15/22：主文字——行的题目、卡片标题、收起的岗位卡标题、列表与菜单项、按钮（标题与按钮 600，正文 400）；
 *  · `--fs-meta` 13/18：次要——行下面的原因、「Ramp · Ashby」一类的说明行、胶囊、描述、次数、Toast；
 *  · `--fs-caption` 11/14，600，字距 .02em：分组小标题（需要你 2 / AI 代答 3 / 其余已填好 1）、计数、角标、小标签。
 * `tests/dock-type-scale.test.ts` 钉着：出现第五档字号就失败。
 */

export const EASE = 'cubic-bezier(.32,.72,0,1)';
export const EASE_OUT = 'cubic-bezier(.16,1,.3,1)';
export const SPRING = 'cubic-bezier(.34,1.45,.64,1)';

export const CARD_SH = '0 0 0 .5px rgba(10,17,40,.06),0 1px 2px rgba(10,17,40,.04)';
export const DARK_SH = 'inset 0 1px 0 rgba(255,255,255,.1),0 1px 2px rgba(10,17,40,.2),0 12px 26px -14px rgba(10,17,40,.7)';

export const DOCK_CSS = `
.acct-sites{display:grid;gap:12px}.acct-site{display:grid;gap:4px;padding:12px 0;border-top:1px solid var(--argo-line)}.acct-site-title{font-size:var(--fs-body);line-height:var(--lh-body);overflow-wrap:anywhere}.acct-sites .acct-sub{font-size:var(--fs-meta);line-height:var(--lh-meta)}
:host{all:initial}
.root{position:fixed;inset:0;pointer-events:none;z-index:2147483646;
  --argo-ink:#0A1128;--argo-ink-2:#3B4762;--argo-muted:#6B778C;--argo-faint:#8A94A8;
  --argo-activity:#111A33;--argo-primary:linear-gradient(180deg,#1B2542,#0A1128);
  --argo-green:#25795A;--argo-green-seg:#2E8A63;--argo-warm:#FF9D4D;--argo-warm-ink:#A3521B;
  --argo-coral:#FF7A6B;--argo-coral-ink:#B4483A;--argo-peach:#FFF3E8;--argo-rose:#FDECEA;--argo-mint:#EAF5F0;
  --argo-lilac:#F3F1FC;--argo-ice:#EEF4FA;
  --argo-ease:${EASE};--argo-ease-out:${EASE_OUT};--argo-spring:${SPRING};
  ${'' /* 字号只有这四档（见文件头）：层级靠字重与 ink / 次级 / 三级三种颜色，不靠再多一档字号。 */}
  --fs-title:20px;--lh-title:28px;--fs-body:15px;--lh-body:22px;--fs-meta:13px;--lh-meta:18px;--fs-caption:11px;--lh-caption:14px;
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",sans-serif;
  font-size:var(--fs-meta);line-height:var(--lh-meta);color:#0A1128;letter-spacing:normal;text-align:left;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
:where(.root) *,:where(.root) *::before,:where(.root) *::after{box-sizing:border-box}
:where(.root) button,:where(.root) input,:where(.root) select,:where(.root) textarea{font:inherit;color:inherit;margin:0;letter-spacing:inherit}
:where(.root) button{cursor:pointer;-webkit-tap-highlight-color:transparent}
:where(.root) button:disabled{cursor:default}
.root :focus-visible{outline:2px solid #A8C0DC;outline-offset:2px}
.root [data-scroll]{scrollbar-width:thin;scrollbar-color:rgba(10,17,40,.16) transparent}
:where(.root) svg{display:block;flex:0 0 auto}
:where(.root) b{font-weight:600}
@keyframes aSpin{to{transform:rotate(360deg)}}
@keyframes aPulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
@keyframes aBlink{0%,100%{opacity:1}50%{opacity:0}}
@keyframes aShimmer{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}
@keyframes aBreathe{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
@media (prefers-reduced-motion:reduce){.root *,.root *::before,.root *::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}}

/* ── 收起时的圆形按钮 ───────────────────────────────────────── */
.launcher{position:fixed;right:12px;display:flex;flex-direction:row-reverse;align-items:center;gap:6px;
  transition:transform .42s cubic-bezier(.34,1.4,.64,1),opacity .24s ease;touch-action:none;user-select:none;-webkit-user-select:none;pointer-events:auto}
.launcher[data-show='false']{transform:translateX(16px) scale(.6);opacity:0;pointer-events:none}
.l-btn{position:relative;z-index:1;height:44px;min-width:44px;max-width:44px;border-radius:22px;border:0;padding:0;display:flex;flex-direction:row-reverse;align-items:center;overflow:hidden;
  background:rgba(255,255,255,.92);-webkit-backdrop-filter:blur(20px) saturate(1.6);backdrop-filter:blur(20px) saturate(1.6);
  box-shadow:0 0 0 .5px rgba(10,17,40,.12),0 10px 26px -10px rgba(10,17,40,.4);transition:max-width .42s ${EASE};cursor:grab}
.launcher[data-expanded='true'] .l-btn{max-width:260px}
.launcher[data-dragging='true'] .l-btn{cursor:grabbing}
.l-icon{position:relative;width:44px;height:44px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;color:#0A1128}
.l-ring{position:absolute;inset:4px;border-radius:50%;
  -webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 2.5px),#000 0);mask:radial-gradient(farthest-side,transparent calc(100% - 2.5px),#000 0);transition:background .3s}
${'' /*
  数字角标（2026-09-24）：挂在收起按钮那一整条（.launcher）上，不在圆按钮里——按钮是 overflow:hidden 的圆（悬停时是胶囊），
  从前角标在方框右上角、正好落在圆外被切掉，又往里挪了 2px 压在帆船上。现在圆心落在帆船右上方的圆边上
  （离按钮中心约 22.6px），按钮往左长成胶囊时它不动；z-index 高过按钮（连同它的焦点框），不挡点击。 */}
.l-badge{position:absolute;top:-2px;right:-2px;z-index:2;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#FF9D4D;color:#fff;
  font-size:var(--fs-caption);line-height:var(--lh-caption);letter-spacing:.02em;font-weight:700;
  display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 2px #fff;font-variant-numeric:tabular-nums;pointer-events:none}
.l-label{padding:0 2px 0 16px;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;color:#0A1128;white-space:nowrap;font-variant-numeric:tabular-nums}
.l-hide{width:22px;height:22px;border-radius:50%;border:0;background:rgba(255,255,255,.96);box-shadow:0 0 0 .5px rgba(10,17,40,.14),0 2px 6px -2px rgba(10,17,40,.2);
  color:#6B778C;display:flex;align-items:center;justify-content:center;padding:0}

/* ── 面板 ─────────────────────────────────────────────────── */
.panel{position:fixed;background:rgba(244,246,249,.95);-webkit-backdrop-filter:blur(30px) saturate(1.7);backdrop-filter:blur(30px) saturate(1.7);
  box-shadow:0 0 0 .5px rgba(10,17,40,.1),0 2px 6px -2px rgba(10,17,40,.08),0 24px 60px -20px rgba(10,17,40,.38);overflow:hidden;outline:none}
.pbody{position:absolute;inset:0;display:flex;flex-direction:column}
.head{flex:0 0 auto;height:52px;display:flex;align-items:center;gap:8px;padding:0 10px 0 14px;position:relative;z-index:3}
.brand{display:flex;align-items:center;gap:9px;flex:1;min-width:0}
.brand-mark{width:26px;height:26px;display:flex;align-items:center;justify-content:center}
.brand-name{font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;letter-spacing:-.1px}
.head-back{display:flex;align-items:center;gap:6px;flex:1;min-width:0;margin-left:-6px}
.back{height:32px;padding:0 8px 0 2px;border:0;background:transparent;border-radius:8px;display:flex;align-items:center;color:#0A1128;font-size:var(--fs-body);line-height:var(--lh-body)}
.back:hover{background:rgba(10,17,40,.05)}
.head-title{font-size:var(--fs-title);line-height:var(--lh-title);font-weight:600;letter-spacing:-.3px}
.avatar{width:30px;height:30px;border-radius:50%;border:0;padding:0;background:linear-gradient(150deg,#CDD1F4,#B9CDE5);color:#0A1128;font-size:var(--fs-caption);line-height:var(--lh-caption);letter-spacing:.02em;font-weight:600;
  box-shadow:0 0 0 .5px rgba(10,17,40,.08);display:flex;align-items:center;justify-content:center}
.collapse{width:30px;height:30px;border-radius:50%;border:0;padding:0;background:transparent;color:#4F5B73;display:flex;align-items:center;justify-content:center;transition:background-color .2s}
.collapse:hover{background:rgba(10,17,40,.06);color:#0A1128}
.routes{position:relative;flex:1;min-height:0}
.route-main{position:absolute;top:0;bottom:0;right:0;overflow:auto;padding:2px 12px 22px}
.route-profile{position:absolute;top:0;bottom:0;right:0;display:flex;flex-direction:column}

/* ── 岗位卡 ───────────────────────────────────────────────── */
.job{position:relative;background:#fff;border-radius:16px;box-shadow:${CARD_SH};overflow:hidden}
.job[data-size='compact']{padding:12px}
.job[data-size='full']{padding:16px}
.job[data-size='compact']>.job-row>.job-id,.job[data-size='compact']>.job-title-lg,.job[data-size='compact']>.job-more,.job[data-size='full']>.job-row>.job-text{display:none}
${'' /* 按下「自动填写」时展开的那一面收成一行：旧的几块克隆一份摆在原处淡出（见 dock.ts 的 morphJob）。 */}
.job-ghost{position:absolute;inset:0;pointer-events:none;z-index:1}
.job-ghost>*{position:absolute;margin:0}
.job-row{display:flex;align-items:center;gap:12px;min-width:0}
.job-mark{width:38px;height:38px;border-radius:10px;background:#EEF1F7;color:#0A1128;font-weight:700;font-size:var(--fs-body);line-height:var(--lh-body);display:flex;align-items:center;justify-content:center;flex:0 0 auto}
.job-text,.job-id{min-width:0;flex:1}
.job-title,.job-co{display:block;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.job-sub,.job-meta{display:block;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.job-title-lg{margin-top:14px;font-size:var(--fs-title);line-height:var(--lh-title);font-weight:600;letter-spacing:-.3px;color:#0A1128;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-wrap:pretty}
.job-more{display:grid;gap:12px;margin-top:12px}
.job-chips{display:flex;flex-wrap:wrap;gap:8px}
.job-chip{display:inline-block;max-width:100%;padding:4px 10px;border-radius:13px;background:#F1F3F7;color:#3B4762;font-size:var(--fs-meta);line-height:var(--lh-meta);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.job-pay{display:flex;align-items:baseline;flex-wrap:wrap;gap:0 8px}
.job-pay-amount{font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;color:#0A1128;font-variant-numeric:tabular-nums}
.job-pay-unit{font-size:var(--fs-meta);line-height:var(--lh-meta);color:#8A94A8}
.job-desc{margin:0;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.job-hl{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.job-hl-item{display:grid;grid-template-columns:20px minmax(0,1fr);gap:10px;align-items:start;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#3B4762}
.job-hl-mark{width:20px;height:20px;margin-top:-1px;border-radius:50%;display:flex;align-items:center;justify-content:center}
.job-hl-item[data-tone='strength'] .job-hl-mark{background:#EAF5F0;color:#25795A}
.job-hl-item[data-tone='gap'] .job-hl-mark{background:#FFF3E8}
.job-hl-dot{width:5px;height:5px;border-radius:50%;background:#FF9D4D}
.job-link{justify-self:start;font-size:var(--fs-meta);line-height:var(--lh-meta);font-weight:600;color:#0A1128;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px;border-radius:4px}
.job-link:hover{color:#3B4762}

/* ── 主卡（连续变形）─────────────────────────────────────────── */
.hero{margin-top:10px;border-radius:16px;overflow:hidden;background:#fff;color:#0A1128;box-shadow:${CARD_SH};
  transition:background-color .6s ${EASE},box-shadow .6s ease,color .4s ease,transform .14s ease}
.hero[data-dark='true']{background:#111A33;color:#fff;box-shadow:${DARK_SH}}
.hero-btn{width:100%;height:50px;border:0;background:transparent;color:#fff;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;display:flex;align-items:center;justify-content:center;gap:8px;letter-spacing:.2px;padding:0}
.hero-btn-in{display:flex;align-items:center;gap:8px}
.done-dot{width:18px;height:18px;border-radius:50%;background:#2E8A63;display:flex;align-items:center;justify-content:center}
.act{padding:14px 16px 12px}
.act-status{display:flex;align-items:center;gap:8px;font-size:var(--fs-meta);line-height:var(--lh-meta);font-weight:600;color:rgba(255,255,255,.66)}
.spin-light{width:13px;height:13px;border-radius:50%;border:1.8px solid rgba(255,255,255,.22);border-top-color:#fff;animation:aSpin .8s linear infinite;flex:0 0 auto}
.act-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.act-count{margin-left:auto;padding-left:8px;flex:0 0 auto;font-variant-numeric:tabular-nums;color:#fff}
.ticker{margin-top:10px;min-height:42px}
.ticker-q{font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ticker-v{font-size:var(--fs-meta);line-height:var(--lh-meta);color:rgba(255,255,255,.55);margin-top:2px;min-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sum{padding:16px 16px 12px}
.sum-title{font-size:var(--fs-title);line-height:var(--lh-title);font-weight:600;letter-spacing:-.3px}
.sum-sub{font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C;margin-top:4px;text-wrap:pretty}
.sum-notes{display:grid;gap:4px;margin-top:6px}
.sum-notes:empty{display:none}
.sum-note{font-size:var(--fs-meta);line-height:var(--lh-meta);color:#8A94A8}
.hbar{padding:0 16px}
.shimmer{position:relative;height:5px;border-radius:3px;background:rgba(255,255,255,.14);overflow:hidden}
.shimmer>span{position:absolute;top:0;bottom:0;left:0;width:34%;border-radius:3px;background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.65),rgba(255,255,255,0));
  animation:aShimmer 1.3s cubic-bezier(.45,0,.55,1) infinite}
.segs{display:flex;gap:2px;height:5px}
.seg{flex:1;border-radius:2px;background:#E3E9F1;transition:background-color .45s ease}
.legend{display:flex;align-items:center;padding:10px 10px 10px 16px;font-size:var(--fs-meta);line-height:var(--lh-meta);color:rgba(255,255,255,.58)}
.legend-n{font-variant-numeric:tabular-nums}
.stop{margin-left:auto;height:26px;padding:0 11px;border-radius:13px;border:0;background:rgba(255,255,255,.1);color:rgba(255,255,255,.88);font-size:var(--fs-meta);line-height:var(--lh-meta);font-weight:600;transition:background-color .2s}
.stop:hover{background:rgba(255,255,255,.18)}
.sum-gap{height:14px}
.face,.failed{padding:18px 16px 16px;display:grid;gap:14px}
.failed{padding-bottom:14px}
.face-icon{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center}
.face-title{font-size:var(--fs-title);line-height:var(--lh-title);font-weight:600;letter-spacing:-.25px;text-wrap:pretty}
.face-sub{margin-top:6px;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C;text-wrap:pretty}
.waiting{display:flex;align-items:center;gap:8px;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C}
.waiting-dot{width:8px;height:8px;border-radius:50%;background:#FF9D4D;animation:aPulse 1.6s ease-in-out infinite}
.spin-dark{width:18px;height:18px;border-radius:50%;border:2px solid rgba(10,17,40,.14);border-top-color:#0A1128;animation:aSpin .8s linear infinite}
.btn-primary{height:46px;border-radius:12px;border:0;background:linear-gradient(180deg,#1B2542,#0A1128);color:#fff;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;
  display:flex;align-items:center;justify-content:center;gap:6px;padding:0 14px;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 1px 2px rgba(10,17,40,.25),0 10px 20px -12px rgba(10,17,40,.6);transition:transform .14s ease}
.btn-primary:active{transform:scale(.98)}
.btn-secondary{height:44px;border-radius:12px;border:0;background:#fff;box-shadow:0 0 0 .5px rgba(10,17,40,.16),0 1px 2px rgba(10,17,40,.05);color:#0A1128;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;
  padding:0 14px;transition:transform .14s ease}
.btn-secondary:active{transform:scale(.98)}
.btn-ghost{height:36px;border-radius:10px;border:0;background:transparent;color:#4F5B73;font-size:var(--fs-body);line-height:var(--lh-body);justify-self:start;padding:0 10px;margin-left:-10px}
.btn-ghost:hover{background:rgba(10,17,40,.05)}
.tech{border-top:.5px solid rgba(10,17,40,.1);padding-top:10px}
.tech-toggle{border:0;background:transparent;padding:2px 0;display:flex;align-items:center;gap:4px;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#8A94A8}
.tech-chev{display:flex;transition:transform .36s ${EASE}}
.tech[data-open='true'] .tech-chev{transform:rotate(180deg)}
.tech-body{display:grid;grid-template-rows:0fr;transition:grid-template-rows .4s ${EASE}}
.tech[data-open='true'] .tech-body{grid-template-rows:1fr}
.clip{overflow:hidden;min-height:0}
.tech-code{margin-top:8px;padding:10px 11px;border-radius:10px;background:#F3F6FA;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#3B4762;word-break:break-all}
.tech-copy{margin-top:8px;height:30px;padding:0 11px;border-radius:8px;border:0;background:#fff;box-shadow:0 0 0 .5px rgba(10,17,40,.16);font-size:var(--fs-meta);line-height:var(--lh-meta);font-weight:600;display:flex;align-items:center;gap:6px}

/* ── 横幅 ─────────────────────────────────────────────────── */
.banner{margin-top:10px;display:grid;grid-template-columns:22px minmax(0,1fr);gap:10px;padding:12px;border-radius:14px;background:#FDECEA;transition:background-color .4s}
.banner[data-ok='true']{background:#EAF5F0}
.banner-mark{width:22px;height:22px;border-radius:50%;background:#fff;color:#B4483A;display:flex;align-items:center;justify-content:center;font-size:var(--fs-caption);line-height:var(--lh-caption);letter-spacing:.02em;font-weight:700}
.banner[data-ok='true'] .banner-mark{color:#25795A}
.banner-title{display:block;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600}
.banner-text{display:block;margin-top:2px;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#3B4762}

/* ── 代填授权的一键同意（2026-09-28）：一张卡、照登那一句、一键同意 ─────────────── */
.consent-offer{margin-top:10px;display:grid;gap:6px;padding:12px;border-radius:14px;background:#F3F6FA}
.consent-offer-title{font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;color:#0A1128}
.consent-offer-lead{font-size:var(--fs-meta);line-height:var(--lh-meta);color:#3B4762}
.consent-offer-text{margin:0;padding:8px 10px;border-radius:10px;background:#fff;box-shadow:0 0 0 .5px rgba(10,17,40,.12);font-size:var(--fs-meta);line-height:var(--lh-meta);color:#3B4762}
.consent-offer-link{display:inline;padding:0;border:0;background:transparent;font:inherit;color:#1F4FD1;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.consent-offer-actions{display:flex;gap:8px;margin-top:4px}
.consent-offer-actions button{flex:1;height:38px;display:flex;align-items:center;justify-content:center;gap:7px}
.consent-offer-spin{width:14px;height:14px;border-color:rgba(255,255,255,.3);border-top-color:#fff}

/* ── 招聘网站账号（2026-09-28）：账号墙那一行、账户菜单里那一块 ─────────────── */
.acct-note{margin-top:8px;padding:0 4px;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C;text-wrap:pretty}
.acct-menu{display:grid;gap:3px;padding:0 10px 8px 34px}
.acct-label{margin-top:6px;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#8A94A8}
.acct-value{font-size:var(--fs-body);line-height:var(--lh-body);color:#0A1128;overflow-wrap:anywhere}
.acct-value[data-revealed='true']{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--fs-meta)}
.acct-sub{font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C;text-wrap:pretty}
.acct-error{font-size:var(--fs-meta);line-height:var(--lh-meta);color:#B4483A}
.acct-row{display:flex;flex-wrap:wrap;gap:2px 12px}
.acct-link{border:0;background:transparent;padding:2px 0;font-size:var(--fs-meta);line-height:var(--lh-meta);font-weight:600;color:#2A5BD7;cursor:pointer}
.acct-link:disabled{opacity:.45;cursor:default}
.acct-input{height:32px}

/* ── 列表 ─────────────────────────────────────────────────── */
.fold{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .5s ${EASE},opacity .3s ease}
.fold[data-open='true']{grid-template-rows:1fr;opacity:1}
.fold-rest{display:grid;grid-template-rows:0fr;transition:grid-template-rows .5s ${EASE}}
.fold-rest[data-open='true']{grid-template-rows:1fr}
.grp{padding-top:18px}
.grp-head{display:flex;align-items:center;gap:6px;padding:0 6px 8px;font-size:var(--fs-caption);line-height:var(--lh-caption);letter-spacing:.02em;font-weight:600;color:#3B4762}
.grp-count{color:#8A94A8;font-variant-numeric:tabular-nums}
.card{background:#fff;border-radius:14px;overflow:hidden;box-shadow:${CARD_SH}}
.nrow{width:100%;display:grid;grid-template-columns:22px minmax(0,1fr) 20px;gap:10px;align-items:start;padding:12px;border:0;border-top:.5px solid rgba(10,17,40,.08);
  background:transparent;text-align:left;transition:background-color .2s}
.nrow:first-child{border-top:0}
.nrow:not(:disabled):hover{background:#F7F9FC}
.nrow:disabled{cursor:default}
.glyph{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;transition:background-color .35s,color .35s}
.glyph[data-kind='pen']{background:#FFF3E8;color:#A3521B}
.glyph[data-kind='x']{background:#FDECEA;color:#B4483A}
.glyph[data-kind='check']{background:#EAF5F0;color:#25795A}
.glyph[data-kind='sign']{background:#F3F1FC;color:#3B4762}
.ntext{min-width:0}
.nq{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;color:#0A1128}
.nr{display:block;margin-top:2px;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C;transition:color .3s}
.nr[data-done='true']{color:#25795A}
.nsign{display:block;margin-top:2px;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#3B4762;font-weight:500}
.nloc{color:#A5AFC0;display:flex;justify-content:center;padding-top:3px;transition:opacity .3s}
.nrow:disabled .nloc{opacity:0}
.foot-note{padding:7px 6px 0;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#8A94A8}
.rest-toggle{width:100%;display:flex;align-items:center;gap:6px;padding:2px 6px 7px;border:0;background:transparent;font-size:var(--fs-caption);line-height:var(--lh-caption);letter-spacing:.02em;font-weight:600;color:#3B4762;text-align:left}
.rest-chev{margin-left:auto;display:flex;color:#8A94A8;transition:transform .4s ${EASE}}
.rest-toggle[aria-expanded='true'] .rest-chev{transform:rotate(180deg)}
.rrow{display:grid;grid-template-columns:18px minmax(0,1fr);gap:10px;align-items:start;padding:9px 12px;border-top:.5px solid rgba(10,17,40,.08)}
.rrow:first-child{border-top:0}
.rcheck{width:18px;height:18px;border-radius:50%;background:#EAF5F0;color:#25795A;display:flex;align-items:center;justify-content:center;margin-top:2px}
.rtext{min-width:0}
.rq-line{display:flex;gap:6px;align-items:baseline;min-width:0}
.rq{font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ropt{font-size:var(--fs-caption);line-height:var(--lh-caption);letter-spacing:.02em;font-weight:600;color:#8A94A8;flex:0 0 auto}
.rv{display:block;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 填写途中进度卡下面那一条列表（2026-09-28，liveFeed.ts）：一栏一行，停在最新那一行；放不下自己滚，顶上淡出。 */
.grp[data-feed='live']{padding-top:12px}
.grp[data-feed] .card{overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none}
.grp[data-feed] .card::-webkit-scrollbar{display:none}
.grp[data-feed] .card[data-overflow='true']{-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 30px);mask-image:linear-gradient(to bottom,transparent 0,#000 30px)}
.frow{display:flex;align-items:center;gap:8px;min-width:0;padding:6px 12px;border-top:.5px solid rgba(10,17,40,.06)}
.frow:first-child{border-top:0;padding-top:9px}
.frow:last-child{padding-bottom:9px}
.fglyph{flex:0 0 auto;width:16px;height:16px;border-radius:50%;background:#EAF5F0;color:#25795A;display:flex;align-items:center;justify-content:center}
.frow[data-kind='ai'] .fglyph{background:#EAF1FE;color:#1F4FB8}
.frow[data-kind='signed'] .fglyph{background:#F3F1FC;color:#3B4762}
.fq{flex:0 1 auto;min-width:0;max-width:62%;font-size:var(--fs-meta);line-height:var(--lh-meta);font-weight:600;color:#0A1128;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fv{flex:1 1 0;min-width:0;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fv::before{content:'· ';color:#A5AFC0}
.frow[data-empty='true'] .fv{display:none}
.drow{width:100%;display:grid;grid-template-columns:30px minmax(0,1fr) 16px;gap:12px;align-items:center;padding:10px 12px;border:0;border-top:.5px solid rgba(10,17,40,.08);background:transparent;text-align:left}
.drow:first-child{border-top:0}
.drow:hover{background:#F7F9FC}
.dicon{width:30px;height:30px;border-radius:9px;background:#EEF4FA;display:flex;align-items:center;justify-content:center;color:#0A1128}
.dtext{min-width:0}
.dtitle{display:block;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600}
.dsub{display:block;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dend{color:#A5AFC0;display:flex;justify-content:center}

/* ── 需要你（2026-09-28）：按要做的事分组，每一行一个动作；办好了收起、淡出 ─────────── */
.need-fold{display:grid;grid-template-rows:1fr;opacity:1;transition:grid-template-rows .42s ${EASE},opacity .26s ease}
.need-fold[data-open='false']{grid-template-rows:0fr;opacity:0}
.need-fold+.need-fold>.clip>.need{border-top:.5px solid rgba(10,17,40,.08)}
.need{padding:12px}
.need-head{width:100%;display:block;padding:0;border:0;background:transparent;text-align:left;border-radius:8px}
.need-head:disabled{cursor:default}
.need-text{min-width:0}
.need-q{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;color:#0A1128}
.need-head:not(:disabled):hover .need-q{text-decoration:underline;text-decoration-color:rgba(10,17,40,.25);text-underline-offset:3px}
.need-why{display:block;margin-top:2px;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C;text-wrap:pretty}
.need-act{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:10px 0 0}
.need-act:empty{display:none}
.need-chip{max-width:100%;height:32px;padding:0 12px;border:0;border-radius:16px;background:#fff;color:#0A1128;display:inline-flex;align-items:center;gap:6px;
  box-shadow:0 0 0 .5px rgba(10,17,40,.18),0 1px 2px rgba(10,17,40,.05);font-size:var(--fs-meta);line-height:var(--lh-meta);font-weight:600;
  transition:background-color .2s ease,color .2s ease,transform .14s ease}
.need-chip:not(:disabled):hover{background:#F3F6FA}
.need-chip:active{transform:scale(.97)}
.need-chip:disabled{cursor:default}
.need-chip[data-busy='true']{background:#111A33;color:#fff;box-shadow:none}
.need-chip[data-busy='true'] .need-spin{border-color:rgba(255,255,255,.3);border-top-color:#fff}
.need-chip-t{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.need-link,.need-go{height:32px;padding:0 10px;border:0;border-radius:16px;background:transparent;color:#3B4762;display:inline-flex;align-items:center;gap:3px;
  font-size:var(--fs-meta);line-height:var(--lh-meta);font-weight:600;transition:background-color .2s ease}
.need-link:hover{background:rgba(10,17,40,.05)}
.need-go{padding:0 10px 0 12px;background:#fff;color:#0A1128;box-shadow:0 0 0 .5px rgba(10,17,40,.16),0 1px 2px rgba(10,17,40,.05)}
.need-go:hover{background:#F3F6FA}
.need-input,.need-select{flex:1;min-width:0;height:34px;padding:0 11px;border:0;border-radius:9px;background:#F3F6FA;color:#0A1128;outline:none;
  font-size:var(--fs-body);line-height:var(--lh-body);transition:background-color .2s,box-shadow .2s}
.need-select{padding:0 8px;font-size:var(--fs-meta);line-height:var(--lh-meta)}
.need-input:focus,.need-select:focus{background:#fff;box-shadow:0 0 0 2px #A8C0DC}
.need-input::placeholder{color:#8A94A8}
.need-area{height:auto;padding:7px 11px;resize:none}
.need-input:disabled,.need-select:disabled{opacity:.6}
.need-fill{height:34px;padding:0 14px;border:0;border-radius:9px;background:#111A33;color:#fff;display:inline-flex;align-items:center;gap:6px;
  font-size:var(--fs-meta);line-height:var(--lh-meta);font-weight:600;transition:background-color .2s,color .2s}
.need-fill:disabled{background:#E3E7ED;color:#8A94A8;cursor:default}
.need-fill .need-spin{border-color:rgba(255,255,255,.3);border-top-color:#fff}
.need-ai{height:34px;padding:0 14px 0 12px;border:0;border-radius:17px;background:#EAF1FE;color:#1F4FB8;display:inline-flex;align-items:center;gap:6px;
  font-size:var(--fs-meta);line-height:var(--lh-meta);font-weight:600;transition:background-color .2s,transform .14s ease}
.need-ai:not(:disabled):hover{background:#DDE8FD}
.need-ai:active{transform:scale(.97)}
.need-ai:disabled{cursor:default}
.need-spin{width:12px;height:12px;border-width:2px}
.glyph[data-kind='review']{background:#FFF3E8;color:#A3521B}
.ai-item+.ai-item{border-top:.5px solid rgba(10,17,40,.08)}
.ai-item>.nrow{border-top:0}
.ai-act{margin:-6px 12px 0 44px;padding-bottom:10px}
.ai-act .need-link{margin-left:-10px;color:#1F4FB8}
.tally{display:flex;flex-wrap:wrap;gap:2px 12px;min-width:0;font-variant-numeric:tabular-nums}
.tally-item{white-space:nowrap;color:rgba(255,255,255,.72);transition:color .3s}
.tally-item[data-zero='true']{color:rgba(255,255,255,.34)}
.tally-item[data-tally='needs'][data-zero='false']{color:#FFB98A}

/* ── 底栏 ─────────────────────────────────────────────────── */
.bar{flex:0 0 auto;padding:10px 12px 12px;border-top:.5px solid rgba(10,17,40,.08);background:rgba(244,246,249,.86);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);
  display:grid;gap:8px;position:relative;z-index:2}
.bar-caption{text-align:center;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#8A94A8}
.bar-row{display:flex;gap:8px}
.bar-row .btn-secondary{flex:1;height:46px}
.bar-row .btn-primary{flex:1;gap:8px}
.spin-btn{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;animation:aSpin .8s linear infinite}
.more-btn{width:46px;height:46px;flex:0 0 auto;border-radius:12px;border:0;padding:0;background:#fff;box-shadow:0 0 0 .5px rgba(10,17,40,.16),0 1px 2px rgba(10,17,40,.05);color:#0A1128;
  display:flex;align-items:center;justify-content:center;transition:opacity .25s ease,transform .14s ease}

/* ── 弹出菜单 ─────────────────────────────────────────────── */
.pop{position:absolute;padding:5px;border-radius:13px;background:rgba(255,255,255,.97);box-shadow:0 0 0 .5px rgba(10,17,40,.1),0 14px 34px -12px rgba(10,17,40,.32);
  transition:transform .24s ${EASE},opacity .18s ease;z-index:8;opacity:0;pointer-events:none}
.pop-account{top:48px;right:44px;width:248px;transform-origin:top right;transform:scale(.94) translateY(-4px)}
.pop-more{right:12px;bottom:66px;width:204px;transform-origin:bottom right;transform:scale(.94) translateY(4px)}
.pop[data-open='true']{opacity:1;pointer-events:auto;transform:none}
.pop-head{padding:8px 10px 9px}
.pop-name{display:block;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600}
.pop-mail{font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C}
.pop-sep{height:.5px;background:rgba(10,17,40,.1);margin:0 6px 4px}
.pop-more .pop-sep{margin:4px 6px}
.pop-item{width:100%;height:34px;display:flex;align-items:center;gap:9px;padding:0 10px;border:0;border-radius:8px;background:transparent;font-size:var(--fs-body);line-height:var(--lh-body);text-align:left;color:#0A1128}
.pop-more .pop-item{height:36px;gap:10px}
.pop-item:hover{background:#F3F6FA}
.pop-item[data-tone='danger']{color:#B4483A}
.pop-item[data-tone='danger']:hover{background:#FDF3F2}
.pop-item:disabled{opacity:.4}
.pop-ext{margin-left:auto;color:#8A94A8}
.pop-lang{cursor:default}
.pop-lang:hover{background:transparent}
.pop-lang-label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pop-lang-choices{flex:0 0 auto;display:flex;gap:2px;padding:2px;border-radius:9px;background:#EEF1F7}
.pop-lang-opt{height:24px;padding:0 8px;white-space:nowrap;border:0;border-radius:7px;background:transparent;font:inherit;font-size:var(--fs-meta);line-height:var(--lh-meta);font-weight:600;color:#3B4762;cursor:pointer}
.pop-lang-opt[aria-pressed='true']{background:#fff;color:#0A1128;box-shadow:0 1px 2px rgba(10,17,40,.12)}
.pop-lang-opt:disabled{opacity:.45;cursor:default}

/* ── 我的资料（宽版编辑器）──────────────────────────────────── */
.pf{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.pf-main{flex:1;min-height:0;display:flex}
.pf-rail{width:212px;flex:0 0 auto;overflow:auto;padding:0 8px 18px 12px}
.pf-rail-head{display:flex;align-items:center;gap:10px;padding:4px 8px 8px}
.pf-avatar{width:36px;height:36px;border-radius:50%;background:linear-gradient(150deg,#CDD1F4,#B9CDE5);display:flex;align-items:center;justify-content:center;font-size:var(--fs-meta);line-height:var(--lh-meta);font-weight:700;flex:0 0 auto}
.pf-rail-text{min-width:0}
.pf-rail-name{display:block;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600}
.pf-rail-mail{display:block;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pf-group{padding:12px 10px 5px;font-size:var(--fs-caption);line-height:var(--lh-caption);letter-spacing:.02em;font-weight:600;color:#8A94A8}
.pf-nav{width:100%;height:34px;display:flex;align-items:center;gap:8px;padding:0 10px;border:0;border-radius:9px;background:transparent;color:#3B4762;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:500;text-align:left;
  transition:background-color .25s ease,color .25s ease}
.pf-nav[data-on='true']{background:rgba(10,17,40,.07);color:#0A1128;font-weight:600}
.pf-nav-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pf-nav-stat{font-size:var(--fs-caption);line-height:var(--lh-caption);letter-spacing:.02em;font-weight:600;font-variant-numeric:tabular-nums}
.pf-dot{width:6px;height:6px;border-radius:50%;background:#FF9D4D;flex:0 0 auto;display:none}
.pf-scroll{position:relative;flex:1;min-width:0;overflow:auto;padding:0 18px 28px 10px}
.pf-sections{display:grid;gap:14px;max-width:760px}
${'' /* 读取中与读不到：摆在右边那一栏本身里，上下左右都居中（不挤在卡片列表的左上角）。 */}
.pf-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;align-content:center;flex-wrap:wrap;gap:8px;padding:24px;text-align:center;
  font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C}
.pf-sec{background:#fff;border-radius:16px;box-shadow:0 0 0 .5px rgba(10,17,40,.06),0 1px 2px rgba(10,17,40,.04);padding:16px 18px}
.pf-sec-head{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.pf-sec-title{font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;letter-spacing:-.15px}
.pf-badge{font-size:var(--fs-caption);line-height:var(--lh-caption);letter-spacing:.02em;font-weight:600;color:#6B778C;background:#F3F6FA;padding:2px 7px;border-radius:6px}
.pf-sec-stat{margin-left:auto;font-size:var(--fs-caption);line-height:var(--lh-caption);letter-spacing:.02em;font-weight:600;font-variant-numeric:tabular-nums}
.pf-cap{margin:-6px 0 10px;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C}
.pf-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 14px}
.pf-field{min-width:0}
.pf-field-row{display:flex;align-items:center;gap:16px;min-height:46px;padding:5px 0}
.pf-field-divided{border-top:.5px solid rgba(10,17,40,.08)}
.pf-label{display:flex;align-items:center;gap:6px;min-width:0;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C;margin-bottom:6px}
.pf-field-row .pf-label{flex:1;font-size:var(--fs-body);line-height:var(--lh-body);color:#0A1128;margin-bottom:0}
.pf-ctrl{width:100%;min-width:0}
.pf-ctrl-row{flex:0 0 auto;width:auto}
.pf-input{width:100%;height:36px;padding:0 11px;border:0;border-radius:9px;background:#F3F6FA;box-shadow:none;font-size:var(--fs-body);line-height:var(--lh-body);color:#0A1128;outline:none;transition:background-color .2s,box-shadow .2s}
.pf-input:focus{background:#fff;box-shadow:0 0 0 2px #A8C0DC}
.pf-input.pf-bad{background:#FDF3F2;box-shadow:0 0 0 1px #F3B7AE}
.pf-input[type='date'],.pf-input[type='month']{padding:0 10px}
.pf-area{height:auto;display:block;padding:9px 11px;line-height:1.55;resize:vertical}
.pf-select{padding:0 8px}
.pf-num{font-variant-numeric:tabular-nums}
.pf-line{display:flex;gap:6px}
.pf-line .pf-input:not(.pf-select){flex:1;min-width:0}
.pf-err{margin-top:5px;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#B4483A;display:none}
.pf-seg{position:relative;display:flex;height:32px;padding:2px;border-radius:9px;background:#EDF0F4}
.pf-seg-thumb{position:absolute;top:2px;bottom:2px;left:2px;border-radius:7px;background:#fff;box-shadow:0 1px 2px rgba(10,17,40,.12),0 0 0 .5px rgba(10,17,40,.06);
  transition:transform .36s ${EASE},opacity .2s ease}
.pf-seg-btn{position:relative;z-index:1;flex:1;min-width:0;border:0;background:transparent;border-radius:7px;padding:0 8px;font-size:var(--fs-meta);line-height:var(--lh-meta);white-space:nowrap;transition:color .2s ease}
.pf-chips{display:flex;flex-wrap:wrap;gap:8px}
.pf-chip{height:32px;padding:0 13px;border-radius:16px;border:0;background:#fff;color:#0A1128;box-shadow:0 0 0 .5px rgba(10,17,40,.16);font-size:var(--fs-meta);line-height:var(--lh-meta);font-weight:600;display:flex;align-items:center;gap:6px;
  transition:background-color .22s ease,color .22s ease,box-shadow .22s ease,transform .14s ease}
.pf-chip[data-on='true']{background:#111A33;color:#fff;box-shadow:0 4px 10px -6px rgba(10,17,40,.6)}
.pf-chip:active{transform:scale(.96)}
.pf-tags{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-height:36px;padding:4px;border-radius:9px;background:#F3F6FA}
.pf-tag{height:28px;display:inline-flex;align-items:center;gap:3px;padding:0 5px 0 10px;border-radius:14px;background:#fff;box-shadow:0 0 0 .5px rgba(10,17,40,.12),0 1px 1px rgba(10,17,40,.04);font-size:var(--fs-meta);line-height:var(--lh-meta);font-weight:500}
.pf-tag-rm{width:18px;height:18px;border-radius:50%;border:0;padding:0;background:transparent;color:#8A94A8;display:flex;align-items:center;justify-content:center}
.pf-tag-rm:hover{background:#EEF1F5;color:#0A1128}
.pf-tag-input{flex:1;min-width:140px;height:28px;border:0;background:transparent;padding:0 6px;font-size:var(--fs-meta);line-height:var(--lh-meta);outline:none}
.pf-toggle{display:block;width:44px;height:26px;border-radius:13px;border:0;padding:2px;background:#D5DBE4;transition:background-color .25s ease}
.pf-toggle[data-on='true']{background:#2E8A63}
.pf-knob{display:block;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(10,17,40,.25);transition:transform .32s cubic-bezier(.34,1.3,.64,1)}
.pf-toggle[data-on='true'] .pf-knob{transform:translateX(18px)}
.pf-stepper{display:inline-flex;align-items:center;height:36px;border-radius:9px;background:#F3F6FA;padding:2px}
.pf-step-btn{width:32px;height:32px;border:0;border-radius:7px;background:transparent;font-size:var(--fs-body);line-height:var(--lh-body);color:#3B4762;padding:0}
.pf-step-btn:hover{background:#fff}
.pf-step-v{min-width:64px;text-align:center;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;font-variant-numeric:tabular-nums}
.pf-resumes{display:grid;gap:8px}
.pf-resume{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:12px;border:0;background:#F7F9FB;box-shadow:0 0 0 .5px rgba(10,17,40,.1);text-align:left;
  transition:background-color .2s ease,box-shadow .25s ease}
.pf-resume[data-on='true']{background:#fff;box-shadow:0 0 0 1.5px #0A1128}
.pf-radio{width:18px;height:18px;border-radius:50%;border:2px solid #C9D1DD;display:flex;align-items:center;justify-content:center;flex:0 0 auto;transition:border-color .2s}
.pf-radio-dot{width:8px;height:8px;border-radius:50%;background:transparent;transition:background-color .2s}
.pf-resume[data-on='true'] .pf-radio{border-color:#0A1128}
.pf-resume[data-on='true'] .pf-radio-dot{background:#0A1128}
.pf-resume-icon{width:30px;height:30px;border-radius:9px;background:#EEF4FA;display:flex;align-items:center;justify-content:center;flex:0 0 auto;color:#0A1128}
.pf-resume-text{flex:1;min-width:0}
.pf-resume-name{display:block;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pf-resume-meta{display:block;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C}
.pf-default{font-size:var(--fs-caption);line-height:var(--lh-caption);letter-spacing:.02em;font-weight:600;color:#25795A;background:#EAF5F0;padding:3px 8px;border-radius:6px;flex:0 0 auto}
.pf-code{flex-basis:100%;font-size:var(--fs-caption);line-height:var(--lh-caption);color:#8A94A8;font-variant-numeric:tabular-nums;user-select:text}
.pf-manage{justify-self:start;height:30px;padding:0 10px;margin-left:-10px;border:0;border-radius:8px;background:transparent;font-size:var(--fs-meta);line-height:var(--lh-meta);font-weight:600;color:#3B4762;display:inline-flex;align-items:center;gap:5px}
.pf-manage:hover{background:rgba(10,17,40,.05)}
.pf-cap-link{display:flex;margin:-8px 0 8px -10px}
.pf-note{font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C}
.pf-entry-divided{border-top:.5px solid rgba(10,17,40,.08)}
.pf-entry-head{width:100%;display:flex;align-items:center;gap:12px;padding:10px 0;border:0;background:transparent;text-align:left}
.pf-entry-initial{width:34px;height:34px;border-radius:10px;background:#EEF1F7;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:var(--fs-meta);line-height:var(--lh-meta);flex:0 0 auto}
.pf-entry-text{flex:1;min-width:0}
.pf-entry-title{display:block;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pf-entry-sub{display:block;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pf-entry-chev{display:flex;color:#8A94A8;transition:transform .4s ${EASE}}
.pf-entry-fold{display:grid;grid-template-rows:0fr;transition:grid-template-rows .5s ${EASE}}
.pf-entry-fold[data-open='true']{grid-template-rows:1fr}
.pf-clip{overflow:hidden;min-height:0}
.pf-entry-fold .pf-grid{padding:2px 0 12px}
.pf-entry-rm{margin:0 0 12px -10px;height:30px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:#B4483A;font-size:var(--fs-meta);line-height:var(--lh-meta);font-weight:500}
.pf-entry-rm:hover{background:#FDF3F2}
.pf-add{margin-top:6px;width:100%;height:38px;border-radius:10px;border:1px dashed #C9D1DD;background:transparent;color:#3B4762;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;display:flex;align-items:center;justify-content:center;gap:6px;
  transition:background-color .2s ease,border-color .2s ease}
.pf-add:hover{background:#F7F9FC;border-color:#A8B3C4}
.pf-bar{flex:0 0 auto;height:60px;display:flex;align-items:center;gap:10px;padding:0 14px 0 20px;border-top:.5px solid rgba(10,17,40,.08);background:rgba(244,246,249,.9);
  -webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px)}
.pf-status{display:flex;align-items:center;gap:8px;font-size:var(--fs-meta);line-height:var(--lh-meta);transition:color .25s}
.pf-status-spin{width:13px;height:13px;border-radius:50%;border:2px solid rgba(10,17,40,.14);border-top-color:#0A1128;animation:aSpin .8s linear infinite;display:inline-block}
.pf-status-dot{width:7px;height:7px;border-radius:50%;background:#FF9D4D}
.pf-status-ok{width:16px;height:16px;border-radius:50%;background:#25795A;color:#fff;display:flex;align-items:center;justify-content:center}
.pf-spacer{flex:1}
.pf-discard{height:38px;padding:0 14px;border-radius:10px;border:0;background:transparent;font-size:var(--fs-body);line-height:var(--lh-body);color:#4F5B73}
.pf-discard:hover{background:rgba(10,17,40,.05)}
.pf-save{height:38px;padding:0 22px;border-radius:10px;border:0;background:#E3E7ED;color:#8A94A8;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;box-shadow:none;
  transition:background-color .25s ease,color .25s ease,box-shadow .25s ease,transform .14s ease}
.pf-save[data-can='true']{background:#111A33;color:#fff;box-shadow:0 6px 16px -8px rgba(10,17,40,.6)}
.pf-save:active{transform:scale(.97)}
.pf-hud{position:absolute;inset:0;z-index:7;display:flex;align-items:center;justify-content:center;background:rgba(246,247,249,.62);
  -webkit-backdrop-filter:blur(2px) saturate(1.1);backdrop-filter:blur(2px) saturate(1.1);opacity:0;pointer-events:none;transition:opacity .36s ease}
.pf-hud[data-show='true']{opacity:1;pointer-events:auto}
.pf-hud-box{width:104px;height:104px;border-radius:24px;background:rgba(255,255,255,.94);box-shadow:0 0 0 .5px rgba(10,17,40,.08),0 20px 44px -18px rgba(10,17,40,.4);
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;transition:transform .46s ${SPRING}}
.pf-hud-spin{width:32px;height:32px;border-radius:50%;border:3px solid rgba(10,17,40,.1);border-top-color:#0A1128;animation:aSpin .75s linear infinite}
.pf-hud-label{font-size:var(--fs-meta);line-height:var(--lh-meta);font-weight:600;color:#3B4762}
.pf-confirm{position:absolute;inset:0;background:rgba(10,17,40,.16);display:none;align-items:center;justify-content:center;z-index:6}
.pf-confirm[data-show='true']{display:flex}
.pf-confirm-box{width:300px;padding:18px;border-radius:16px;background:#fff;box-shadow:0 0 0 .5px rgba(10,17,40,.1),0 24px 60px -18px rgba(10,17,40,.45);display:grid;gap:6px}
.pf-confirm-title{font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600}
.pf-confirm-sub{font-size:var(--fs-meta);line-height:var(--lh-meta);color:#6B778C}
.pf-confirm-row{display:flex;gap:8px;margin-top:10px}
.pf-confirm-discard{flex:1;height:40px;border-radius:10px;border:0;background:#fff;box-shadow:0 0 0 .5px rgba(10,17,40,.16);font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;color:#B4483A}
.pf-confirm-save{flex:1;height:40px;border-radius:10px;border:0;background:#111A33;color:#fff;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600}
.pf-confirm-save:disabled{background:#E3E7ED;color:#8A94A8}
.pf-conflict-box{width:min(360px,calc(100% - 32px));max-height:calc(100% - 32px);overflow:auto}
.pf-conflict-cancel{color:#3B4762}
.pf-conflict-rows{display:grid;gap:12px;margin-top:8px}
.pf-conflict-row{display:grid;gap:6px}
.pf-conflict-label{font-size:var(--fs-meta);line-height:var(--lh-meta);font-weight:600;color:#3B4762}
.pf-conflict-choices{display:grid;gap:6px}
.pf-conflict-pick{min-height:36px;padding:8px 12px;border-radius:10px;border:0;background:#fff;box-shadow:0 0 0 .5px rgba(10,17,40,.16);text-align:left;
  font-size:var(--fs-meta);line-height:var(--lh-meta);color:#0A1128;overflow-wrap:anywhere}
.pf-conflict-pick[data-on='true']{box-shadow:0 0 0 2px #111A33;font-weight:600}
.pf-recheck{height:24px;margin-left:2px;padding:0 8px}

/* ── Toast ────────────────────────────────────────────────── */
.toast-wrap{position:fixed;display:flex;justify-content:center;pointer-events:none;transition:bottom .45s ${EASE}}
.toast{max-width:100%;padding:9px 14px;border-radius:12px;background:rgba(17,24,45,.94);color:#fff;font-size:var(--fs-meta);line-height:var(--lh-meta);box-shadow:0 10px 30px -10px rgba(10,17,40,.5);text-align:center}
`;
