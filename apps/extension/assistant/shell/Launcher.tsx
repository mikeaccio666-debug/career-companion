import { Fragment } from 'react';
import type { SceneProps } from '../app/view-types';

/** Layout ported from the accepted Fable design; behavior is supplied by the controller. */
export function Launcher({ view, events }: SceneProps) {
  const { launcher } = view;
  return <>
    <div data-launcher={"1"} style={{ "position": "absolute", "right": "14px", "top": `${launcher.top}px`, "display": "flex", "flexDirection": "column", "alignItems": "center", "gap": "6px", "zIndex": "20", "touchAction": "none", "userSelect": "none" }}>
      <button data-act={"launcher-open"} aria-label={view.t("打开 ArgoLand.AI")} style={{ "width": "56px", "height": "56px", "borderRadius": "18px", "border": "1px solid rgba(255,255,255,.7)", "background": "linear-gradient(180deg,#FFFFFF,var(--argo-ice))", "boxShadow": "0 1px 2px rgba(10,17,40,.08),0 12px 28px -12px rgba(10,17,40,.35),inset 0 1px 0 #fff", "display": "flex", "alignItems": "center", "justifyContent": "center", "cursor": "grab", "transition": "transform .2s cubic-bezier(.32,.72,0,1),box-shadow .2s" }} className="argo-interaction-fb05e009 argo-interaction-4726cf4c">
        <svg width={"30"} height={"30"} viewBox={"0 0 24 24"} fill={"none"} stroke={"#0A1128"} strokeWidth={"1.6"} strokeLinecap={"round"} strokeLinejoin={"round"}>
          <path d={"M11 4.5V14H5.2Z"} fill={"#fff"}>
          </path>
          <path d={"M13 5.5 19 14h-6Z"} fill={"#fff"}>
          </path>
          <path d={"M4 16.5h16l-2.2 3H6.2Z"} fill={"#fff"}>
          </path>
          <path d={"M3.5 21.5q3-1.6 6 0t6 0 5 0"}>
          </path>
        </svg>
      </button>
      <button data-act={"launcher-hide"} aria-label={view.t("隐藏悬浮入口")} title={view.t("隐藏入口（从工具栏可唤回）")} style={{ "width": "22px", "height": "22px", "borderRadius": "50%", "border": "1px solid #D5DBE4", "background": "#fff", "color": "var(--argo-muted)", "fontSize": "12px", "lineHeight": "1", "display": "flex", "alignItems": "center", "justifyContent": "center", "boxShadow": "0 1px 2px rgba(10,17,40,.08)" }} className="argo-interaction-2479d2f5">
        {"×"}
      </button>
    </div>
  </>;
}
