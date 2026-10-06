import { Fragment } from 'react';
import { CountUp } from './CountUp';
import type { SceneProps } from '../app/view-types';

/** Layout ported from the accepted Fable design; behavior is supplied by the controller. */
export function DeckScene({ view, events }: SceneProps) {
  const { ats, deck } = view;
  return <>
    <div data-scene={"deck"} style={{ "flex": "1", "minHeight": "0", "display": "flex", "flexDirection": "column", "padding": "0 20px 16px" }}>
      <div data-enter={"1"} style={{ "flexShrink": "0", "display": "flex", "alignItems": "center", "justifyContent": "space-between", "padding": "6px 4px 10px" }}>
        <div>
          <div style={{ "fontSize": "11px", "letterSpacing": "2.4px", "color": "var(--argo-faint)", "fontWeight": "600", "whiteSpace": "nowrap" }}>
            {"TODAY'S FINDS "}
            <span style={{ "marginLeft": "8px", "color": "var(--argo-ink)", "fontVariantNumeric": "tabular-nums" }}>
              {deck.counter}
            </span>
          </div>
          <div style={{ "fontSize": "12px", "color": "var(--argo-muted)", "marginTop": "3px" }}>
            {deck.groupNote}
          </div>
        </div>
        <div data-bin={"1"} aria-label={view.t("跳过收集区")} style={{ "display": "flex", "alignItems": "center", "gap": "6px", "height": "32px", "padding": "0 10px 0 8px", "borderRadius": "11px", "background": "var(--argo-grey)", "border": "1px solid var(--argo-line)", "fontSize": "12px", "color": "var(--argo-muted)" }}>
          <svg width={"14"} height={"14"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"1.8"} strokeLinecap={"round"} strokeLinejoin={"round"}>
            <path d={"M4 6h16M9 3h6l1 3M6 6l1 15h10l1-15M10 10v7m4-7v7"}>
            </path>
          </svg>
          {view.t("跳过 ")}{deck.skipped}
        </div>
      </div>
      <div style={{ "position": "relative", "flex": "1", "minHeight": "0" }}>
        <div style={{ "position": "absolute", "left": "14px", "right": "14px", "top": "16px", "bottom": "-8px", "borderRadius": "22px", "background": "#fff", "border": "1px solid var(--argo-line)", "opacity": ".55" }}>
        </div>
        <div data-under-card={"1"} style={{ "position": "absolute", "left": "7px", "right": "7px", "top": "8px", "bottom": "-4px", "borderRadius": "22px", "background": "#fff", "border": "1px solid var(--argo-line)", "boxShadow": "0 10px 24px -20px rgba(10,17,40,.3)", "opacity": ".9" }}>
        </div>
        {deck.hasCard && <>
          <article data-job-card={"1"} data-scroll={"1"} aria-label={view.t("岗位卡片")} style={{ "position": "absolute", "inset": "0", "borderRadius": "22px", "background": "#fff", "border": "1px solid var(--argo-line)", "boxShadow": "0 1px 2px rgba(10,17,40,.05),0 20px 40px -24px rgba(10,17,40,.35)", "padding": "18px 18px 14px", "overflow": "auto", "display": "flex", "flexDirection": "column", "gap": "12px" }}>
            <div style={{ "display": "flex", "alignItems": "center", "gap": "10px" }}>
              <span style={{ "width": "38px", "height": "38px", "borderRadius": "12px", "background": deck.job.markBg, "color": "var(--argo-ink)", "display": "flex", "alignItems": "center", "justifyContent": "center", "fontWeight": "700", "fontSize": "15px" }}>
                {deck.job.initial}
              </span>
              <span style={{ "flex": "1", "minWidth": "0" }}>
                <b style={{ "display": "block", "fontWeight": "600", "fontSize": "14px" }}>
                  {deck.job.company}
                </b>
                <span style={{ "fontSize": "11px", "color": "var(--argo-faint)" }}>
                  {deck.sourceLine}
                </span>
              </span>
              {deck.job.closed && <>
                <span style={{ "fontSize": "11px", "fontWeight": "600", "padding": "4px 8px", "borderRadius": "999px", "background": "var(--argo-rose)", "color": "#B4483A" }}>
                  {view.t("岗位已关闭")}
                </span>
              </>}
            </div>
            <div>
              <h2 style={{ "margin": "0", "fontSize": "20px", "lineHeight": "1.3", "fontWeight": "600", "letterSpacing": "-.3px" }}>
                {deck.job.title}
              </h2>
              <div style={{ "display": "flex", "flexWrap": "wrap", "gap": "6px", "marginTop": "8px" }}>
                <span style={{ "fontSize": "12px", "padding": "4px 9px", "borderRadius": "999px", "background": "var(--argo-grey)", "color": "var(--argo-ink-2)" }}>
                  {deck.job.location}
                </span>
                <span style={{ "fontSize": "12px", "padding": "4px 9px", "borderRadius": "999px", "background": "var(--argo-grey)", "color": "var(--argo-ink-2)" }}>
                  {deck.job.mode}
                </span>
                <span style={{ "fontSize": "12px", "padding": "4px 9px", "borderRadius": "999px", "background": "var(--argo-grey)", "color": "var(--argo-ink-2)" }}>
                  {deck.job.type}
                </span>
              </div>
            </div>
            <div style={{ "display": "flex", "alignItems": "baseline", "gap": "8px" }}>
              <b style={{ "fontSize": "17px", "fontWeight": "600", "letterSpacing": "-.2px", "color": deck.job.salaryColor }}>
                {deck.job.salary}
              </b>
              <span style={{ "fontSize": "12px", "color": "var(--argo-faint)" }}>
                {deck.job.salaryUnit}
              </span>
            </div>
            {deck.job.summary && <p style={{ "margin": "0", "fontSize": "13px", "lineHeight": "1.65", "color": "#4F5B73" }}>
              {deck.job.summary}
            </p>}
            <div data-ats={"1"} style={{ "borderRadius": "16px", "background": ats.bg, "border": `1px solid ${ats.border}`, "padding": "12px 14px", "display": "grid", "gap": "8px", "transition": "background .3s" }}>
              <div style={{ "display": "flex", "alignItems": "center", "gap": "12px" }}>
                {ats.showScore && <>
                  <div style={{ "display": "flex", "alignItems": "baseline", "gap": "2px" }}>
                    <b data-ats-total={ats.total} style={{ "fontSize": "30px", "fontWeight": "700", "letterSpacing": "-1px", "lineHeight": "1", "fontVariantNumeric": "tabular-nums" }}>
                      {typeof ats.total === 'number' ? <CountUp value={ats.total} reduced={events.reduced} active={events.active} /> : ats.total}
                    </b>
                    <span style={{ "fontSize": "12px", "color": "var(--argo-faint)" }}>
                      {"/ "}{ats.max}
                    </span>
                  </div>
                </>}
                {ats.showSpinner && <>
                  <span data-motion={"1"} style={{ "width": "30px", "height": "30px", "borderRadius": "50%", "border": "2.5px solid #DCE4EE", "borderTopColor": "var(--argo-ink)", "animation": "argoSpin .9s linear infinite", "flex": "0 0 auto" }}>
                  </span>
                </>}
                {ats.showLock && <>
                  <span style={{ "width": "34px", "height": "34px", "borderRadius": "11px", "background": "#fff", "display": "flex", "alignItems": "center", "justifyContent": "center", "color": "var(--argo-ink)", "flex": "0 0 auto", "boxShadow": "0 1px 2px rgba(10,17,40,.08)" }}>
                    <svg width={"16"} height={"16"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"1.8"} strokeLinecap={"round"} strokeLinejoin={"round"}>
                      <rect x={"5"} y={"11"} width={"14"} height={"10"} rx={"2"}>
                      </rect>
                      <path d={"M8 11V7a4 4 0 0 1 8 0v4"}>
                      </path>
                    </svg>
                  </span>
                </>}
                {ats.showWarn && <>
                  <span style={{ "width": "34px", "height": "34px", "borderRadius": "11px", "background": "#fff", "display": "flex", "alignItems": "center", "justifyContent": "center", "color": ats.warnColor, "flex": "0 0 auto", "fontWeight": "700" }}>
                    {"!"}
                  </span>
                </>}
                <div style={{ "flex": "1", "minWidth": "0" }}>
                  <b style={{ "display": "block", "fontSize": "13px", "fontWeight": "600" }}>
                    {ats.title}
                  </b>
                  <span style={{ "fontSize": "12px", "color": "var(--argo-muted)", "lineHeight": "1.5", "display": "block" }}>
                    {ats.caption}
                  </span>
                </div>
              </div>
              {ats.showBars && <>
                <div style={{ "display": "flex", "gap": "3px", "height": "6px" }}>
                  {ats.mini.map((d, dIndex) => <Fragment key={dIndex}>
                    <span title={d.label} style={{ "flex": d.max, "borderRadius": "3px", "background": "var(--argo-line)", "overflow": "hidden", "position": "relative" }}>
                      <span style={{ "position": "absolute", "left": "0", "top": "0", "bottom": "0", "width": `${d.pct}%`, "background": d.color, "borderRadius": "3px" }}>
                      </span>
                    </span>
                  </Fragment>)}
                </div>
              </>}
              {ats.hasActions && <>
                <div style={{ "display": "flex", "gap": "8px", "alignItems": "center", "flexWrap": "wrap" }}>
                  {ats.actions.map((a, aIndex) => <Fragment key={aIndex}>
                    <button data-act={a.act} data-arg={a.arg} style={{ "height": "32px", "padding": "0 12px", "borderRadius": "10px", "border": `1px solid ${a.border}`, "background": a.bg, "color": a.color, "fontSize": "12px", "fontWeight": "600", "transition": "transform .16s" }} className="argo-interaction-6cf058f9">
                      {a.label}
                    </button>
                  </Fragment>)}
                  <span style={{ "fontSize": "11px", "color": "var(--argo-faint)", "marginLeft": "auto" }}>
                    {ats.usage}
                  </span>
                </div>
              </>}
            </div>
            <div style={{ "display": "grid", "gap": "6px", "fontSize": "13px", "lineHeight": "1.55" }}>
              {deck.job.matches.map((mt, mtIndex) => <Fragment key={mtIndex}>
                <div style={{ "display": "flex", "gap": "8px", "color": "#1F2A44" }}>
                  <span style={{ "width": "18px", "height": "18px", "borderRadius": "50%", "background": "var(--argo-mint)", "color": "var(--argo-green)", "display": "flex", "alignItems": "center", "justifyContent": "center", "fontSize": "11px", "flex": "0 0 auto", "marginTop": "2px" }}>
                    {"✓"}
                  </span>
                  <span>
                    {mt.text}
                  </span>
                </div>
              </Fragment>)}
              {deck.job.gap && <div style={{ "display": "flex", "gap": "8px", "color": "#1F2A44" }}>
                <span style={{ "width": "18px", "height": "18px", "borderRadius": "50%", "background": "var(--argo-peach)", "color": "#B86A2B", "display": "flex", "alignItems": "center", "justifyContent": "center", "fontSize": "11px", "flex": "0 0 auto", "marginTop": "2px" }}>
                  {"·"}
                </span>
                <span>
                  {deck.job.gap}
                </span>
              </div>}
            </div>
            <button data-act={"open-jd"} data-arg={deck.job.id} style={{ "alignSelf": "flex-start", "border": "0", "background": "transparent", "padding": "4px 0", "fontSize": "13px", "fontWeight": "600", "color": "var(--argo-ink)", "textDecoration": "underline", "textDecorationColor": "#C9D2DF", "textUnderlineOffset": "3px" }}>
              {view.t("查看完整岗位详情")}
            </button>
          </article>
        </>}
      </div>
      <div data-enter={"1"} style={{ "flexShrink": "0", "display": "grid", "gridTemplateColumns": "1fr 1fr", "gap": "10px", "marginTop": "20px" }}>
        <button data-act={"deck-accept"} disabled={deck.busy} aria-label={view.t("想申请，加入待确认清单")} style={{ "height": "52px", "borderRadius": "16px", "border": "0", "background": "linear-gradient(180deg,#1B2542,var(--argo-ink))", "color": "#fff", "fontWeight": "600", "fontSize": "14px", "display": "flex", "alignItems": "center", "justifyContent": "center", "gap": "8px", "boxShadow": "inset 0 1px 0 rgba(255,255,255,.16),0 1px 2px rgba(10,17,40,.3),0 12px 24px -12px rgba(10,17,40,.55)", "transition": "transform .16s cubic-bezier(.32,.72,0,1)" }} className="argo-interaction-6cf058f9">
          <span style={{ "width": "22px", "height": "22px", "borderRadius": "50%", "background": "rgba(255,255,255,.14)", "display": "flex", "alignItems": "center", "justifyContent": "center" }}>
            <svg width={"13"} height={"13"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"2.6"} strokeLinecap={"round"} strokeLinejoin={"round"}>
              <path d={"m5 12 4 4L19 6"}>
              </path>
            </svg>
          </span>
          {view.t("想申请")}
        </button>
        <button data-act={"deck-skip"} disabled={deck.busy} aria-label={view.t("这次先跳过")} style={{ "height": "52px", "borderRadius": "16px", "border": "1px solid var(--argo-line)", "background": "#fff", "color": "var(--argo-ink)", "fontWeight": "600", "fontSize": "14px", "display": "flex", "alignItems": "center", "justifyContent": "center", "gap": "8px", "boxShadow": "0 1px 2px rgba(10,17,40,.04)", "transition": "transform .16s cubic-bezier(.32,.72,0,1),background .2s" }} className="argo-interaction-7b62346d argo-interaction-6cf058f9">
          <span style={{ "width": "22px", "height": "22px", "borderRadius": "50%", "background": "var(--argo-grey)", "display": "flex", "alignItems": "center", "justifyContent": "center", "color": "var(--argo-muted)" }}>
            <svg width={"12"} height={"12"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"2.4"} strokeLinecap={"round"}>
              <path d={"m6 6 12 12M6 18 18 6"}>
              </path>
            </svg>
          </span>
          {view.t("先跳过")}
        </button>
      </div>
      <div data-enter={"1"} style={{ "flexShrink": "0", "display": "flex", "alignItems": "center", "justifyContent": "space-between", "marginTop": "10px" }}>
        <button data-act={"deck-undo"} disabled={deck.undoDisabled} style={{ "height": "34px", "padding": "0 10px", "border": "0", "background": "transparent", "color": "#4F5B73", "fontSize": "13px", "borderRadius": "10px" }} className="argo-interaction-4c615124">
          {view.t("↶ 撤回上一张")}
        </button>
        <span style={{ "fontSize": "11px", "color": "#98A2B5" }}>
          {view.t("← 跳过 · → 想申请 · Z 撤回")}
        </span>
        <button data-act={"open-shortlist"} style={{ "height": "34px", "padding": "0 10px", "border": "0", "background": "transparent", "color": "var(--argo-ink)", "fontSize": "13px", "fontWeight": "600", "borderRadius": "10px", "display": "flex", "alignItems": "center", "gap": "4px" }} className="argo-interaction-4c615124">
          {view.t("已选 ")}
          <span data-shortlist-count={"1"}>
            {deck.selectedCount}
          </span>
          <svg width={"14"} height={"14"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"2"} strokeLinecap={"round"} strokeLinejoin={"round"}>
            <path d={"m9 5 7 7-7 7"}>
            </path>
          </svg>
        </button>
      </div>
    </div>
  </>;
}
