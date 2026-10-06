import { Fragment } from 'react';
import type { SceneProps } from '../app/view-types';

/** Layout ported from the accepted Fable design; behavior is supplied by the controller. */
export function BatchEndScene({ view, events }: SceneProps) {
  const { batch } = view;
  return <>
    <div data-scene={"batchend"} data-scroll={"1"} style={{ "flex": "1", "minHeight": "0", "overflow": "auto", "padding": "10px 24px 20px", "display": "flex", "flexDirection": "column" }}>
      <div style={{ "flex": "1", "display": "flex", "flexDirection": "column", "justifyContent": "center", "alignItems": "center", "textAlign": "center", "gap": "14px", "padding": "12px 0" }}>
        <div data-enter={"1"} style={{ "flexShrink": "0", "width": "84px", "height": "84px", "borderRadius": "26px", "background": "linear-gradient(160deg,#FFFFFF,#E7EEF7)", "boxShadow": "inset 0 1px 0 #fff,0 18px 34px -18px rgba(10,17,40,.35),0 1px 2px rgba(10,17,40,.06)", "display": "flex", "alignItems": "center", "justifyContent": "center", "color": "var(--argo-ink)", "position": "relative" }}>
          <b style={{ "fontSize": "28px", "fontWeight": "700", "letterSpacing": "-1px" }}>
            {batch.count}
          </b>
          <span style={{ "position": "absolute", "bottom": "-8px", "fontSize": "10px", "letterSpacing": "1.6px", "color": "var(--argo-faint)", "background": "#F7FAFD", "padding": "2px 8px", "borderRadius": "999px" }}>
            {view.t("已选")}
          </span>
        </div>
        <div data-enter={"1"} style={{ "flexShrink": "0", "marginTop": "8px" }}>
          <div style={{ "fontSize": "11px", "letterSpacing": "2.4px", "color": "var(--argo-faint)", "fontWeight": "600" }}>
            {"A STEP CLOSER"}
          </div>
          <h2 style={{ "margin": "10px 0 0", "fontSize": "22px", "lineHeight": "1.3", "fontWeight": "600", "letterSpacing": "-.4px", "textWrap": "pretty" }}>
            {batch.title}
          </h2>
          <p style={{ "margin": "8px 0 0", "fontSize": "13px", "lineHeight": "1.7", "color": "var(--argo-muted)", "whiteSpace": "pre-line" }}>
            {batch.sub}
          </p>
        </div>
        {batch.showQuota && <>
          <div data-enter={"1"} style={{ "flexShrink": "0", "width": "100%", "padding": "12px 14px", "borderRadius": "14px", "background": batch.quotaBg, "textAlign": "left", "display": "flex", "gap": "10px", "alignItems": "flex-start" }}>
            <span style={{ "width": "22px", "height": "22px", "borderRadius": "50%", "background": "#fff", "display": "flex", "alignItems": "center", "justifyContent": "center", "fontSize": "12px", "fontWeight": "700", "color": batch.quotaIconColor, "flex": "0 0 auto" }}>
              {batch.quotaIcon}
            </span>
            <span style={{ "fontSize": "13px", "lineHeight": "1.6", "color": "var(--argo-ink)", "whiteSpace": "pre-line" }}>
              {batch.quotaText}
            </span>
          </div>
        </>}
      </div>
      <div data-enter={"1"} style={{ "flexShrink": "0", "display": "grid", "gap": "8px" }}>
        {batch.actions.map((a, aIndex) => <Fragment key={aIndex}>
          <button data-act={a.act} data-arg={a.arg} style={{ "height": `${a.h}px`, "borderRadius": "15px", "border": `1px solid ${a.border}`, "background": a.bg, "color": a.color, "fontWeight": a.weight, "fontSize": "14px", "display": "flex", "alignItems": "center", "justifyContent": "center", "gap": "8px", "boxShadow": a.shadow, "transition": "transform .16s cubic-bezier(.32,.72,0,1)" }} className="argo-interaction-afb2bbd2">
            {a.label}
          </button>
        </Fragment>)}
      </div>
    </div>
  </>;
}
