import { Fragment } from 'react';
import type { SceneProps } from '../app/view-types';

/** Layout ported from the accepted Fable design; behavior is supplied by the controller. */
export function WelcomeScene({ view, events }: SceneProps) {
  const { ui, welcome, mentors } = view;
  return <>
    <div data-scene={"welcome"} data-scroll={"1"} style={{ "flex": "1", "minHeight": "0", "display": "flex", "flexDirection": "column", "overflow": "auto" }}>
      <div style={{ "padding": "22px 24px 0", "fontSize": "11px", "letterSpacing": "2.8px", "color": "var(--argo-faint)", "fontWeight": "600" }}>
        {"ARGOLAND"}
      </div>
      <div data-hero={"1"} style={{ "position": "relative", "flex": "0 0 auto", "height": `${ui.heroH}px`, "marginTop": "6px" }}>
        <div style={{ "position": "absolute", "left": "50%", "top": "52%", "width": "320px", "height": "220px", "transform": "translate(-50%,-50%)", "background": "radial-gradient(closest-side,rgba(168,192,220,.42),rgba(179,184,234,.18) 55%,rgba(255,255,255,0) 100%)", "filter": "blur(6px)", "pointerEvents": "none" }}>
        </div>
        {mentors.map((p, pIndex) => <Fragment key={pIndex}>
          <div data-mentor={"1"} aria-hidden={"true"} style={{ "position": "absolute", "left": `${p.left}px`, "top": `${p.top}px`, "width": `${p.size}px`, "height": `${p.size}px`, "zIndex": p.z, "transform": `rotate(${p.rot}deg)`, "opacity": p.opacity, "filter": `blur(${p.blur}px)` }}>
            <div style={{ "position": "absolute", "inset": "0", "borderRadius": `${p.radius}px`, "background": "linear-gradient(160deg,#FFFFFF,#DCE6F2)", "boxShadow": `0 1px 0 #fff inset,0 ${p.shadowY}px ${p.shadowBlur}px -8px rgba(10,17,40,.35),0 1px 2px rgba(10,17,40,.08)` }}>
            </div>
            <div role={"img"} aria-hidden={"true"} style={{ "position": "absolute", "inset": "4px", "borderRadius": `${p.innerRadius}px`, "backgroundImage": `url(${p.src})`, "backgroundSize": "cover", "backgroundPosition": "center" }}>
            </div>
            <div style={{ "position": "absolute", "inset": "4px", "borderRadius": `${p.innerRadius}px`, "background": "linear-gradient(160deg,rgba(255,255,255,.55),rgba(255,255,255,0) 40%,rgba(10,17,40,.08))", "pointerEvents": "none" }}>
            </div>
          </div>
        </Fragment>)}
        <div data-hero-label={"1"} style={{ "position": "absolute", "left": "0", "right": "0", "bottom": "2px", "textAlign": "center", "fontSize": "10px", "letterSpacing": "2.4px", "color": "#A5AFC0" }}>
          {"A LITTLE COMPANY · A NEW HORIZON"}
        </div>
      </div>
      <div style={{ "flex": "1 0 auto", "display": "flex", "flexDirection": "column", "justifyContent": "flex-end" }}>
        <div data-enter={"1"} style={{ "flexShrink": "0", "padding": "0 28px" }}>
          <h1 style={{ "margin": "0", "fontSize": "27px", "lineHeight": "1.25", "fontWeight": "600", "letterSpacing": "-.5px", "textWrap": "pretty", "whiteSpace": "pre-line" }}>
            {welcome.title}
          </h1>
          <p style={{ "margin": "12px 0 0", "fontSize": "14px", "lineHeight": "1.75", "color": "#4F5B73", "whiteSpace": "pre-line" }}>
            {welcome.sub}
          </p>
        </div>
        <div data-enter={"1"} style={{ "flexShrink": "0", "padding": "0 24px", "marginTop": "24px", "display": "grid", "gap": "8px" }}>
          {welcome.connecting && <>
            <div style={{ "height": "50px", "borderRadius": "15px", "background": "var(--argo-ice)", "display": "flex", "alignItems": "center", "justifyContent": "center", "gap": "10px", "fontSize": "14px", "color": "var(--argo-ink-2)", "fontWeight": "600" }}>
              <span data-motion={"1"} style={{ "width": "16px", "height": "16px", "borderRadius": "50%", "border": "2px solid var(--argo-steel)", "borderTopColor": "var(--argo-ink)", "animation": "argoSpin .9s linear infinite" }}>
              </span>
              {view.t("正在等待 Portal 确认…")}
            </div>
            <button data-act={"login-cancel"} style={{ "height": "44px", "border": "0", "background": "transparent", "color": "#4F5B73", "fontSize": "14px", "borderRadius": "14px" }} className="argo-interaction-4c615124">
              {view.t("取消登录")}
            </button>
          </>}
          {welcome.notConnecting && <>
            <button data-act={welcome.primaryAct} style={{ "height": "50px", "borderRadius": "15px", "border": "0", "background": "linear-gradient(180deg,#1B2542 0%,var(--argo-ink) 100%)", "color": "#fff", "fontWeight": "600", "fontSize": "15px", "display": "flex", "alignItems": "center", "justifyContent": "center", "gap": "8px", "boxShadow": "inset 0 1px 0 rgba(255,255,255,.16),0 1px 2px rgba(10,17,40,.3),0 12px 24px -12px rgba(10,17,40,.6)", "transition": "transform .18s cubic-bezier(.32,.72,0,1),box-shadow .18s" }} className="argo-interaction-54c675b1 argo-interaction-afb2bbd2">
              {welcome.primaryLabel}
              <svg width={"16"} height={"16"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"2"} strokeLinecap={"round"} strokeLinejoin={"round"}>
                <path d={"M5 12h14m-6-6 6 6-6 6"}>
                </path>
              </svg>
            </button>
            <button data-act={welcome.secondaryAct} style={{ "height": "44px", "border": "0", "background": "transparent", "color": "#4F5B73", "fontSize": "14px", "borderRadius": "14px", "transition": "background .18s" }} className="argo-interaction-48cdfccb">
              {welcome.secondaryLabel}
            </button>
          </>}
        </div>
        <div data-enter={"1"} style={{ "flexShrink": "0", "padding": "14px 24px 20px", "fontSize": "12px", "color": "var(--argo-faint)", "textAlign": "center", "display": "flex", "alignItems": "center", "justifyContent": "center", "gap": "6px" }}>
          <span style={{ "width": "6px", "height": "6px", "borderRadius": "50%", "background": welcome.footDot }}>
          </span>
          <span role="status">{welcome.foot}
            {welcome.diagnostic && <span style={{ display: 'block', fontSize: '10px', marginTop: '4px' }}>{welcome.diagnostic}</span>}
          </span>
        </div>
      </div>
    </div>
  </>;
}
