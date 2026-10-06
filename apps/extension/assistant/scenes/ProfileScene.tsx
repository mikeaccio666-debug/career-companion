import { Fragment } from 'react';
import type { SceneProps } from '../app/view-types';

/** Layout ported from the accepted Fable design; behavior is supplied by the controller. */
export function ProfileScene({ view, events }: SceneProps) {
  const { review } = view;
  return <>
    <div data-scene={"profile"} style={{ "flex": "1", "minHeight": "0", "display": "flex", "flexDirection": "column" }}>
      <div data-scroll={"1"} style={{ "flex": "1", "minHeight": "0", "overflow": "auto", "padding": "4px 24px 12px" }}>
        <div data-enter={"1"} style={{ "flexShrink": "0", "display": "flex", "alignItems": "flex-end", "justifyContent": "space-between", "gap": "16px", "padding": "6px 0 14px", "flexWrap": "wrap" }}>
          <div>
            <div style={{ "fontSize": "11px", "letterSpacing": "2.4px", "color": "var(--argo-faint)", "fontWeight": "600" }}>
              {"YOUR PROFILE"}
            </div>
            <h2 style={{ "margin": "6px 0 0", "fontSize": "22px", "lineHeight": "1.3", "fontWeight": "600", "letterSpacing": "-.4px" }}>
              {review.title}
            </h2>
            <p style={{ "margin": "6px 0 0", "fontSize": "13px", "color": "var(--argo-muted)", "lineHeight": "1.6" }}>
              {review.sub}
            </p>
          </div>
          <div style={{ "display": "flex", "gap": "14px", "fontSize": "12px", "color": "var(--argo-muted)", "whiteSpace": "nowrap" }}>
            <span style={{ "display": "flex", "alignItems": "center", "gap": "5px" }}>
              <span style={{ "width": "8px", "height": "8px", "borderRadius": "50%", "background": "var(--argo-green)" }}>
              </span>
              {review.legend}
            </span>
            <span style={{ "display": "flex", "alignItems": "center", "gap": "5px" }}>
              <span style={{ "width": "8px", "height": "8px", "borderRadius": "50%", "background": "#C9D2DF" }}>
              </span>
              {view.t("未提供")}
            </span>
            <span style={{ "display": "flex", "alignItems": "center", "gap": "5px" }}>
              <span style={{ "width": "8px", "height": "8px", "borderRadius": "50%", "background": "var(--argo-warm)" }}>
              </span>
              {view.t("按岗位确认")}
            </span>
          </div>
        </div>
        {review.readOnly && <button type="button" data-act="intake-open" style={{ marginBottom: 16, padding: '11px 16px', border: '1px solid var(--argo-line)', borderRadius: 12, background: '#eef3fa', color: 'var(--argo-ink)', font: 'inherit', fontSize: 13 }}>{view.t('聊聊你的经历')}</button>}
        <div style={{ "display": "grid", "gridTemplateColumns": review.columns, "gap": "12px" }}>
          {review.groups.map((g, gIndex) => <Fragment key={gIndex}>
            <section data-enter={"1"} style={{ "flexShrink": "0", "position": "relative", "border": "1px solid var(--argo-line)", "borderRadius": "18px", "background": "#fff", "padding": "14px 16px", "display": "grid", "gap": "8px", "alignContent": "start", "boxShadow": "0 1px 2px rgba(10,17,40,.04)", "marginBottom": `${g.stackPad}px` }}>
              {g.stacked && <>
                <span style={{ "position": "absolute", "left": "10px", "right": "10px", "bottom": "-7px", "height": "14px", "borderRadius": "0 0 16px 16px", "background": "var(--argo-grey)", "border": "1px solid var(--argo-line)", "borderTop": "0", "zIndex": "-1" }}>
                </span>
              </>}
              <div style={{ "display": "flex", "alignItems": "center", "justifyContent": "space-between", "gap": "8px" }}>
                <span style={{ "minWidth": "0" }}>
                  <b style={{ "fontSize": "14px", "fontWeight": "600" }}>
                    {g.title}
                  </b>
                  {g.hasSwitch && <>
                    <span style={{ "display": "block", "fontSize": "11px", "color": "var(--argo-faint)", "marginTop": "2px" }}>
                      {g.subtitle}
                    </span>
                  </>}
                </span>
                <span style={{ "display": "flex", "gap": "6px" }}>
                  {g.hasSwitch && <>
                    <button data-act={"open-targets"} style={{ "height": "28px", "padding": "0 10px", "borderRadius": "9px", "border": "1px solid #DCE4EE", "background": "var(--argo-grey)", "fontSize": "12px", "fontWeight": "600", "color": "var(--argo-ink)", "display": "flex", "alignItems": "center", "gap": "4px" }} className="argo-interaction-4c8cd924">
                      {g.switchLabel}
                      <svg width={"11"} height={"11"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"2.4"} strokeLinecap={"round"} strokeLinejoin={"round"}>
                        <path d={"m6 9 6 6 6-6"}>
                        </path>
                      </svg>
                    </button>
                  </>}
                  {g.editSection && <button data-act="profile-edit" data-arg={g.editSection} style={{ height: 28, padding: '0 10px', borderRadius: 9, border: '1px solid var(--argo-line)', background: '#fff', fontSize: 12, color: 'var(--argo-ink)' }}>{view.t('修改')}</button>}
                  {!review.readOnly && <button data-act={"review-edit"} data-arg={g.phase} style={{ "height": "28px", "padding": "0 10px", "borderRadius": "9px", "border": "1px solid var(--argo-line)", "background": "#fff", "fontSize": "12px", "fontWeight": "600", "color": "var(--argo-ink)" }} className="argo-interaction-d0fd638f">
                    {view.t("修改")}
                  </button>}
                </span>
              </div>
              {g.rows.map((r, rIndex) => <Fragment key={rIndex}>
                <div style={{ "display": "grid", "gridTemplateColumns": "96px 1fr", "gap": "8px", "alignItems": "start", "fontSize": "13px", "lineHeight": "1.55" }}>
                  <span style={{ "color": "var(--argo-faint)" }}>
                    {r.label}
                  </span>
                  <span style={{ "display": "flex", "alignItems": "flex-start", "gap": "8px", "minWidth": "0" }}>
                    <span style={{ "width": "8px", "height": "8px", "borderRadius": "50%", "background": r.dot, "flex": "0 0 auto", "marginTop": "6px" }}>
                    </span>
                    <span style={{ "color": r.color, "whiteSpace": "pre-line", "minWidth": "0", "overflowWrap": "anywhere" }}>
                      {r.value}
                    </span>
                  </span>
                </div>
              </Fragment>)}
            </section>
          </Fragment>)}
        </div>
      </div>
      <div data-enter={"1"} style={{ "flexShrink": "0", "flex": "0 0 auto", "padding": "12px 24px 20px", "display": "flex", "gap": "10px", "alignItems": "center", "borderTop": "1px solid #EEF2F7", "background": "rgba(255,255,255,.7)", "backdropFilter": "blur(8px)" }}>
        <span style={{ "flex": "1", "fontSize": "12px", "color": "var(--argo-muted)", "lineHeight": "1.5" }}>
          {review.foot}
        </span>
        <button data-act={review.primaryAct} style={{ "height": "48px", "padding": "0 20px", "borderRadius": "14px", "border": "0", "background": "linear-gradient(180deg,#1B2542,var(--argo-ink))", "color": "#fff", "fontWeight": "600", "fontSize": "14px", "display": "flex", "alignItems": "center", "gap": "8px", "boxShadow": "inset 0 1px 0 rgba(255,255,255,.16),0 1px 2px rgba(10,17,40,.3),0 12px 24px -12px rgba(10,17,40,.6)", "transition": "transform .16s cubic-bezier(.32,.72,0,1)", "whiteSpace": "nowrap" }} className="argo-interaction-afb2bbd2">
          {review.primaryLabel}
          <svg width={"16"} height={"16"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"2"} strokeLinecap={"round"} strokeLinejoin={"round"}>
            <path d={"M5 12h14m-6-6 6 6-6 6"}>
            </path>
          </svg>
        </button>
      </div>
    </div>
  </>;
}
