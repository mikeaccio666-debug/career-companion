import { Fragment } from 'react';
import type { SceneProps } from '../app/view-types';

/** Layout ported from the accepted Fable design; behavior is supplied by the controller. */
export function HomeScene({ view, events }: SceneProps) {
  const { home } = view;
  return <>
    <div data-scene={"home"} data-scroll={"1"} style={{ "flex": "1", "minHeight": "0", "overflow": "auto", "padding": "6px 20px 18px", "display": "flex", "flexDirection": "column", "gap": "10px", "scrollbarGutter": "stable" }}>
      <div data-enter={"1"} style={{ "flexShrink": "0", "padding": "6px 4px 2px" }}>
        <div style={{ "fontSize": "11px", "letterSpacing": "2.4px", "color": "var(--argo-faint)", "fontWeight": "600" }}>
          {"YOUR SPACE"}
        </div>
        <h2 style={{ "margin": "4px 0 0", "fontSize": "20px", "lineHeight": "1.3", "fontWeight": "600", "letterSpacing": "-.4px", "whiteSpace": "pre-line" }}>
          {home.greeting}
        </h2>
      </div>
      <div data-enter={"1"} style={{ "flexShrink": "0", "textAlign": "left", "border": "1px solid var(--argo-line)", "background": "#fff", "borderRadius": "20px", "padding": "16px", "boxShadow": "0 1px 2px rgba(10,17,40,.04),0 10px 24px -16px rgba(10,17,40,.18)", "display": "grid", "gap": "12px" }}>
        <div style={{ "display": "flex", "alignItems": "center", "gap": "12px" }}>
          <span style={{ "width": "40px", "height": "40px", "borderRadius": "13px", "background": "linear-gradient(160deg,var(--argo-peri),var(--argo-steel))", "color": "var(--argo-ink)", "display": "flex", "alignItems": "center", "justifyContent": "center", "fontWeight": "700" }}>
            {home.initial}
          </span>
          <span style={{ "flex": "1", "minWidth": "0" }}>
            <b style={{ "display": "block", "fontWeight": "600", "fontSize": "15px" }}>
              {home.name}
            </b>
            <span style={{ "fontSize": "12px", "color": "var(--argo-muted)" }}>
              {home.roleLine}
            </span>
          </span>
          <span style={{ "fontSize": "11px", "fontWeight": "600", "letterSpacing": ".6px", "color": home.badgeColor, "background": home.badgeBg, "padding": "4px 8px", "borderRadius": "999px" }}>
            {home.badge}
          </span>
        </div>
        <div style={{ "position": "relative", "paddingBottom": `${home.targetStackPad}px` }}>
          {home.targetStacked && <>
            <span style={{ "position": "absolute", "left": "10px", "right": "10px", "bottom": "0", "height": "14px", "borderRadius": "0 0 12px 12px", "background": "#E6ECF4", "border": "1px solid #DCE4EE", "borderTop": "0" }}>
            </span>
            <span style={{ "position": "absolute", "left": "5px", "right": "5px", "bottom": "5px", "height": "14px", "borderRadius": "0 0 12px 12px", "background": "#EEF2F7", "border": "1px solid var(--argo-line)", "borderTop": "0" }}>
            </span>
          </>}
          <button data-act={"open-targets"} data-target-switcher={"1"} style={{ "position": "relative", "width": "100%", "display": "flex", "alignItems": "center", "gap": "10px", "padding": "10px 12px", "borderRadius": "14px", "border": "1px solid #DCE4EE", "background": "linear-gradient(180deg,#FFFFFF,var(--argo-grey))", "textAlign": "left", "boxShadow": "0 1px 2px rgba(10,17,40,.05)", "transition": "transform .18s cubic-bezier(.32,.72,0,1),box-shadow .18s" }} className="argo-interaction-d0e049b6 argo-interaction-39b90613">
            <span style={{ "width": "30px", "height": "30px", "borderRadius": "9px", "background": "#EEF1FB", "display": "flex", "alignItems": "center", "justifyContent": "center", "color": "var(--argo-ink)", "flex": "0 0 auto" }}>
              <svg width={"15"} height={"15"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"1.8"} strokeLinecap={"round"} strokeLinejoin={"round"}>
                <path d={"M3 12 12 4l9 8M6 10v10h12V10"}>
                </path>
              </svg>
            </span>
            <span style={{ "flex": "1", "minWidth": "0" }}>
              <span style={{ "display": "block", "fontSize": "11px", "color": "var(--argo-faint)" }}>
                {view.t("今天的目标岗位")}
              </span>
              <b style={{ "display": "block", "fontSize": "13px", "fontWeight": "600", "overflow": "hidden", "textOverflow": "ellipsis", "whiteSpace": "nowrap" }}>
                {home.targetRole}
              </b>
            </span>
            <span style={{ "fontSize": "11px", "fontWeight": "600", "padding": "4px 9px", "borderRadius": "999px", "background": home.targetChipBg, "color": home.targetChipColor, "whiteSpace": "nowrap" }}>
              {home.targetChip}
            </span>
          </button>
        </div>
        <div style={{ "display": "grid", "gridTemplateColumns": "repeat(3,1fr)", "gap": "6px" }}>
          {home.stages.map((s, sIndex) => <Fragment key={sIndex}>
            <div style={{ "display": "grid", "gap": "6px" }}>
              <span style={{ "height": "4px", "borderRadius": "2px", "background": s.bar }}>
              </span>
              <span style={{ "fontSize": "11px", "color": s.color, "display": "flex", "alignItems": "center", "gap": "4px" }}>
                <span>
                  {s.mark}
                </span>
                {s.title}
              </span>
            </div>
          </Fragment>)}
        </div>
        <button data-act={"open-profile"} style={{ "display": "flex", "alignItems": "center", "justifyContent": "space-between", "gap": "10px", "border": "0", "background": "transparent", "padding": "4px 2px 0", "textAlign": "left", "borderRadius": "10px" }} className="argo-interaction-ed828e38">
          <span style={{ "fontSize": "12px", "color": "var(--argo-muted)" }}>
            {home.profileNote}
          </span>
          <span style={{ "fontSize": "13px", "fontWeight": "600", "color": "var(--argo-ink)", "display": "flex", "alignItems": "center", "gap": "4px", "whiteSpace": "nowrap" }}>
            {view.t("个性化我的资料 ")}
            <svg width={"14"} height={"14"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"2"} strokeLinecap={"round"} strokeLinejoin={"round"}>
              <path d={"m9 5 7 7-7 7"}>
              </path>
            </svg>
          </span>
        </button>
      </div>
      <div data-enter={"1"} style={{ "flexShrink": "0", "border": "1px solid var(--argo-line)", "borderRadius": "20px", "background": "#fff", "overflow": "hidden", "boxShadow": "0 1px 2px rgba(10,17,40,.04)" }}>
        <button data-act={"open-resume"} style={{ "width": "100%", "display": "flex", "alignItems": "center", "gap": "12px", "padding": "11px 16px", "border": "0", "borderBottom": "1px solid #EEF2F7", "background": "#fff", "textAlign": "left" }} className="argo-interaction-7b62346d">
          <span style={{ "width": "36px", "height": "36px", "borderRadius": "11px", "background": "var(--argo-ice)", "display": "flex", "alignItems": "center", "justifyContent": "center", "color": "var(--argo-ink)" }}>
            <svg width={"18"} height={"18"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"1.7"} strokeLinecap={"round"} strokeLinejoin={"round"}>
              <path d={"M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"}>
              </path>
            </svg>
          </span>
          <span style={{ "flex": "1", "minWidth": "0" }}>
            <b style={{ "display": "block", "fontWeight": "600", "fontSize": "14px" }}>
              {view.t("我的简历")}
            </b>
            <span style={{ "fontSize": "12px", "color": "var(--argo-muted)", "display": "block", "overflow": "hidden", "textOverflow": "ellipsis", "whiteSpace": "nowrap" }}>
              {home.resumeLine}
            </span>
          </span>
          <span style={{ "fontSize": "11px", "color": home.resumeTagColor, "background": home.resumeTagBg, "padding": "3px 8px", "borderRadius": "999px", "fontWeight": "600" }}>
            {home.resumeTag}
          </span>
        </button>
        <button data-act={"open-letters"} style={{ "width": "100%", "display": "flex", "alignItems": "center", "gap": "12px", "padding": "11px 16px", "border": "0", "borderBottom": "1px solid #EEF2F7", "background": "#fff", "textAlign": "left" }} className="argo-interaction-7b62346d">
          <span style={{ "width": "36px", "height": "36px", "borderRadius": "11px", "background": "var(--argo-lilac)", "display": "flex", "alignItems": "center", "justifyContent": "center", "color": "var(--argo-ink)" }}>
            <svg width={"18"} height={"18"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"1.7"} strokeLinecap={"round"} strokeLinejoin={"round"}>
              <path d={"m15 4 5 5-10 10-6 1 1-6ZM13 6l5 5"}>
              </path>
            </svg>
          </span>
          <span style={{ "flex": "1", "minWidth": "0" }}>
            <b style={{ "display": "block", "fontWeight": "600", "fontSize": "14px" }}>
              {view.t("求职信")}
            </b>
            <span style={{ "fontSize": "12px", "color": "var(--argo-muted)" }}>
              {view.t("为具体岗位生成专属草稿 · ")}{home.lettersLine}
            </span>
          </span>
          <svg width={"16"} height={"16"} viewBox={"0 0 24 24"} fill={"none"} stroke={"#98A2B5"} strokeWidth={"2"} strokeLinecap={"round"} strokeLinejoin={"round"}>
            <path d={"m9 5 7 7-7 7"}>
            </path>
          </svg>
        </button>
        <button data-act={"open-shortlist"} style={{ "width": "100%", "display": "flex", "alignItems": "center", "gap": "12px", "padding": "11px 16px", "border": "0", "borderBottom": "1px solid #EEF2F7", "background": "#fff", "textAlign": "left" }} className="argo-interaction-7b62346d">
          <span style={{ "width": "36px", "height": "36px", "borderRadius": "11px", "background": "var(--argo-peach)", "display": "flex", "alignItems": "center", "justifyContent": "center", "color": "var(--argo-ink)" }}>
            <svg width={"18"} height={"18"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"1.7"} strokeLinecap={"round"} strokeLinejoin={"round"}>
              <rect x={"3"} y={"7"} width={"18"} height={"14"} rx={"3"}>
              </rect>
              <path d={"M8 7V3h8v4M3 12c6 3 12 3 18 0"}>
              </path>
            </svg>
          </span>
          <span style={{ "flex": "1", "minWidth": "0" }}>
            <b style={{ "display": "block", "fontWeight": "600", "fontSize": "14px" }}>
              {home.shortlistTitle}
            </b>
            <span style={{ "fontSize": "12px", "color": "var(--argo-muted)" }}>
              {home.shortlistLine}
            </span>
          </span>
          <span style={{ "fontSize": "11px", "color": home.shortlistTagColor, "background": home.shortlistTagBg, "padding": "3px 8px", "borderRadius": "999px", "fontWeight": "600" }}>
            {home.shortlistTag}
          </span>
        </button>
        <button data-act={"open-usage"} style={{ "width": "100%", "display": "flex", "alignItems": "center", "gap": "12px", "padding": "11px 16px", "border": "0", "background": "#fff", "textAlign": "left" }} className="argo-interaction-7b62346d">
          <span style={{ "width": "36px", "height": "36px", "borderRadius": "11px", "background": "var(--argo-mint)", "display": "flex", "alignItems": "center", "justifyContent": "center", "color": "var(--argo-ink)" }}>
            <svg width={"18"} height={"18"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"1.7"} strokeLinecap={"round"} strokeLinejoin={"round"}>
              <path d={"m12 2 8 4v7c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"}>
              </path>
            </svg>
          </span>
          <span style={{ "flex": "1", "minWidth": "0" }}>
            <b style={{ "display": "block", "fontWeight": "600", "fontSize": "14px" }}>
              {view.t("权益与用量")}
            </b>
            <span style={{ "fontSize": "12px", "color": "var(--argo-muted)" }}>
              {home.usageLine}
            </span>
          </span>
          <svg width={"16"} height={"16"} viewBox={"0 0 24 24"} fill={"none"} stroke={"#98A2B5"} strokeWidth={"2"} strokeLinecap={"round"} strokeLinejoin={"round"}>
            <path d={"m9 5 7 7-7 7"}>
            </path>
          </svg>
        </button>
      </div>
      <div data-enter={"1"} style={{ "flexShrink": "0", "marginTop": "auto", "display": "grid", "gap": "8px", "paddingTop": "6px" }}>
        <button data-act={"discover"} style={{ "height": "50px", "borderRadius": "15px", "border": "0", "background": "linear-gradient(180deg,#1B2542 0%,var(--argo-ink) 100%)", "color": "#fff", "fontWeight": "600", "fontSize": "15px", "display": "flex", "alignItems": "center", "justifyContent": "center", "gap": "8px", "boxShadow": "inset 0 1px 0 rgba(255,255,255,.16),0 1px 2px rgba(10,17,40,.3),0 12px 24px -12px rgba(10,17,40,.6)", "transition": "transform .18s cubic-bezier(.32,.72,0,1)" }} className="argo-interaction-afb2bbd2">
          {view.t("发现今天的机会")}
          <svg width={"16"} height={"16"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"2"} strokeLinecap={"round"} strokeLinejoin={"round"}>
            <path d={"M5 12h14m-6-6 6 6-6 6"}>
            </path>
          </svg>
        </button>
        <div style={{ "textAlign": "center", "fontSize": "12px", "color": "var(--argo-faint)" }}>
          {home.discoverNote}
        </div>
      </div>
    </div>
  </>;
}
