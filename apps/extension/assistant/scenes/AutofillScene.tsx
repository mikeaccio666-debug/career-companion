import { Fragment } from 'react';
import type { SceneProps } from '../app/view-types';

/** Layout ported from the accepted Fable design; behavior is supplied by the controller. */
export function AutofillScene({ view, events }: SceneProps) {
  const { fill } = view;
  return <>
    <div data-scene={"autofill"} style={{ "flex": "1", "minHeight": "0", "display": "flex", "flexDirection": "column" }}>
      <div data-scroll={"1"} style={{ "flex": "1", "minHeight": "0", "overflow": "auto", "padding": "0 20px 12px", "display": "grid", "gridAutoRows": "max-content", "gap": "12px", "alignContent": "start" }}>
        <div data-enter={"1"} style={{ "flexShrink": "0", "display": "flex", "alignItems": "center", "gap": "10px", "paddingTop": "4px" }}>
          <span style={{ "width": "38px", "height": "38px", "borderRadius": "12px", "background": fill.markBg, "display": "flex", "alignItems": "center", "justifyContent": "center", "fontWeight": "700" }}>
            {fill.initial}
          </span>
          <span style={{ "flex": "1", "minWidth": "0" }}>
            <b style={{ "display": "block", "fontSize": "15px", "fontWeight": "600", "overflow": "hidden", "textOverflow": "ellipsis", "whiteSpace": "nowrap" }}>
              {fill.title}
            </b>
            <span style={{ "fontSize": "12px", "color": "var(--argo-muted)" }}>
              {fill.company} · {fill.pageLabel} · {fill.resumeLabel}
            </span>
          </span>
        </div>
        <div data-enter={"1"} style={{ "flexShrink": "0", "display": "flex", "alignItems": "center", "justifyContent": "space-between", "padding": "10px 14px", "borderRadius": "14px", "background": "var(--argo-grey)", "fontSize": "12px", "color": "#4F5B73" }}>
          <span>
            {fill.stateLabel}
          </span>
          <span style={{ "fontWeight": "600", "color": "var(--argo-ink)", "fontVariantNumeric": "tabular-nums" }}>
            {fill.progress}
          </span>
        </div>
        <div data-enter={"1"} style={{ "flexShrink": "0", "border": "1px solid var(--argo-line)", "borderRadius": "18px", "background": "#fff", "overflow": "hidden", "boxShadow": "0 1px 2px rgba(10,17,40,.04)" }}>
          {fill.rows.map((r, rIndex) => <Fragment key={rIndex}>
            <div data-fill-row={r.key} style={{ "display": "grid", "gridTemplateColumns": "22px minmax(0, 1fr) minmax(0, 46%)", "alignItems": "center", "columnGap": "12px", "rowGap": "4px", "padding": "11px 14px", "borderBottom": "1px solid #EEF2F7", "background": r.bg, "transition": "background .35s" }}>
              <span style={{ "width": "22px", "height": "22px", "borderRadius": "50%", "background": r.iconBg, "color": r.iconColor, "display": "flex", "alignItems": "center", "justifyContent": "center", "fontSize": "11px", "fontWeight": "700", "flex": "0 0 auto", "transition": "background .3s" }}>
                {r.spinning && <>
                  <span data-motion={"1"} style={{ "width": "12px", "height": "12px", "borderRadius": "50%", "border": "2px solid #DCE4EE", "borderTopColor": "var(--argo-ink)", "animation": "argoSpin .9s linear infinite" }}>
                  </span>
                </>}
                {r.notSpinning && <>
                  {r.mark}
                </>}
              </span>
              <span style={{ "flex": "1", "minWidth": "0" }}>
                <b style={{ "display": "block", "fontSize": "13px", "fontWeight": "600" }}>
                  {r.label}
                </b>
              </span>
              <span style={{ "fontSize": "12px", "color": r.statusColor, "textAlign": "right", "lineHeight": "1.4", "overflowWrap": "anywhere", "fontWeight": r.statusWeight }}>
                {r.status}
              </span>
              {r.sub && <span style={{gridColumn:'2 / -1',fontSize:11,color:'var(--argo-faint)',lineHeight:1.5,overflowWrap:'anywhere'}}>{r.sub}</span>}
            </div>
          </Fragment>)}
        </div>
        {fill.showSummary && <>
          <div data-enter={"1"} style={{ "flexShrink": "0", "borderRadius": "16px", "background": fill.summaryBg, "padding": "14px 16px", "display": "grid", "gap": "6px" }}>
            <b style={{ "fontSize": "14px", "fontWeight": "600" }}>
              {fill.summaryTitle}
            </b>
            <span style={{ "fontSize": "13px", "lineHeight": "1.65", "color": "#1F2A44", "whiteSpace": "pre-line" }}>
              {fill.summaryText}
            </span>
          </div>
        </>}
      </div>
      <div data-enter={"1"} style={{ "flexShrink": "0", "flex": "0 0 auto", "padding": "10px 20px 18px", "display": "grid", "gap": "8px", "borderTop": "1px solid #EEF2F7", "background": "rgba(255,255,255,.7)" }}>
        {fill.showOpenTarget && <button data-act="fill-open-target" style={{height:44,borderRadius:12,border:'1px solid var(--argo-line)',background:'#fff'}}>{view.t('打开已验证的申请页')}</button>}
        {fill.showStop && <button data-act="fill-stop" style={{height:44,borderRadius:12,border:'1px solid var(--argo-line)',background:'#fff'}}>{view.t('停止后续填写')}</button>}
        {fill.showStart && <>
          <button data-act={"fill-start"} disabled={fill.running} style={{ "height": "50px", "borderRadius": "15px", "border": "0", "background": "linear-gradient(180deg,#1B2542,var(--argo-ink))", "color": "#fff", "fontWeight": "600", "fontSize": "15px", "display": "flex", "alignItems": "center", "justifyContent": "center", "gap": "8px", "boxShadow": "inset 0 1px 0 rgba(255,255,255,.16),0 1px 2px rgba(10,17,40,.3),0 12px 24px -12px rgba(10,17,40,.55)", "transition": "transform .16s cubic-bezier(.32,.72,0,1)" }} className="argo-interaction-afb2bbd2">
            <svg width={"16"} height={"16"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"1.8"} strokeLinecap={"round"} strokeLinejoin={"round"}>
              <path d={"m12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8Z"}>
              </path>
            </svg>
            {fill.startLabel}
          </button>
          <div style={{ "textAlign": "center", "fontSize": "11px", "color": "var(--argo-faint)" }}>
            {fill.startNote}
          </div>
        </>}
        {fill.showDone && <>
          <button data-act={"fill-handoff"} style={{ "height": "50px", "borderRadius": "15px", "border": "0", "background": "linear-gradient(180deg,#1B2542,var(--argo-ink))", "color": "#fff", "fontWeight": "600", "fontSize": "15px", "display": "flex", "alignItems": "center", "justifyContent": "center", "gap": "8px", "boxShadow": "inset 0 1px 0 rgba(255,255,255,.16),0 1px 2px rgba(10,17,40,.3),0 12px 24px -12px rgba(10,17,40,.55)", "transition": "transform .16s cubic-bezier(.32,.72,0,1)" }} className="argo-interaction-afb2bbd2">
            {view.t("回到网站核对并提交")}
            <svg width={"14"} height={"14"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"2.2"} strokeLinecap={"round"} strokeLinejoin={"round"}>
              <path d={"M14 3h7v7M21 3l-9 9M10 5H3v16h16v-7"}>
              </path>
            </svg>
          </button>
          <div style={{ "display": "flex", "gap": "8px" }}>
            <button data-act={"fill-rerun"} style={{ "flex": "1", "height": "40px", "borderRadius": "12px", "border": "1px solid var(--argo-line)", "background": "#fff", "fontSize": "13px", "fontWeight": "600" }}>
              {view.t("重新检查此页")}
            </button>
            <button data-act={"open-shortlist"} style={{ "flex": "1", "height": "40px", "borderRadius": "12px", "border": "1px solid var(--argo-line)", "background": "#fff", "fontSize": "13px" }}>
              {view.t("返回申请清单")}
            </button>
          </div>
          <div style={{ "textAlign": "center", "fontSize": "11px", "color": "var(--argo-faint)", "lineHeight": "1.5" }}>
            {view.t("插件不会替你点击网站的 Submit。剩余问题与最终提交由你在网站上完成。")}
          </div>
        </>}
      </div>
    </div>
  </>;
}
