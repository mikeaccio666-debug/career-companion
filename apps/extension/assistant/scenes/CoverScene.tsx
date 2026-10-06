import { Fragment } from 'react';
import type { SceneProps } from '../app/view-types';

/** Layout ported from the accepted Fable design; behavior is supplied by the controller. */
export function CoverScene({ view, events }: SceneProps) {
  const { cover } = view;
  return <>
    <div data-scene={"cover"} style={{ "flex": "1", "minHeight": "0", "display": "flex", "flexDirection": "column" }}>
      <div data-scroll={"1"} style={{ "flex": "1", "minHeight": "0", "overflow": "auto", "padding": "0 20px 12px", "display": "grid", "gap": "12px", "alignContent": "start" }}>
        <button data-enter={"1"} data-act={"open-shortlist"} style={{ "justifySelf": "start", "height": "32px", "padding": "0 6px", "border": "0", "background": "transparent", "color": "#4F5B73", "fontSize": "13px", "display": "flex", "alignItems": "center", "gap": "6px", "borderRadius": "9px" }} className="argo-interaction-4c615124">
          <svg width={"14"} height={"14"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"2"} strokeLinecap={"round"} strokeLinejoin={"round"}>
            <path d={"M19 12H5m6-6-6 6 6 6"}>
            </path>
          </svg>
          {view.t("回到申请清单")}
        </button>
        <div data-enter={"1"} style={{ "flexShrink": "0", "display": "flex", "alignItems": "center", "gap": "10px" }}>
          <span style={{ "width": "38px", "height": "38px", "borderRadius": "12px", "background": cover.markBg, "display": "flex", "alignItems": "center", "justifyContent": "center", "fontWeight": "700" }}>
            {cover.initial}
          </span>
          <span style={{ "flex": "1", "minWidth": "0" }}>
            <b style={{ "display": "block", "fontSize": "15px", "fontWeight": "600" }}>
              {cover.title}
            </b>
            <span style={{ "fontSize": "12px", "color": "var(--argo-muted)" }}>
              {cover.company}{view.t(" · 基于该岗位 JD 与你已确认的资料")}
            </span>
          </span>
        </div>
        <div data-enter={"1"} style={{ "flexShrink": "0", "display": "flex", "gap": "6px", "flexWrap": "wrap", "alignItems": "center" }}>
          <span style={{ "fontSize": "11px", "fontWeight": "600", "padding": "4px 9px", "borderRadius": "999px", "background": cover.reqBg, "color": cover.reqColor }}>
            {cover.reqLabel}
          </span>
          <span style={{ "fontSize": "11px", "fontWeight": "600", "padding": "4px 9px", "borderRadius": "999px", "background": cover.stBg, "color": cover.stColor }}>
            {cover.stLabel}
          </span>
          <span style={{ "fontSize": "11px", "color": "var(--argo-faint)" }}>
            {cover.quota}
          </span>
        </div>
        {cover.ask && <>
          <div data-enter={"1"} style={{ "flexShrink": "0", "border": "1px dashed #C9D6E6", "borderRadius": "18px", "padding": "22px 20px", "textAlign": "center", "display": "grid", "gap": "12px", "justifyItems": "center" }}>
            <p style={{ "margin": "0", "fontSize": "13px", "color": "#4F5B73", "lineHeight": "1.7" }}>
              {cover.askText}
            </p>
            <div style={{ "display": "flex", "gap": "8px" }}>
              <button disabled={cover.generating} data-act={"cover-generate"} style={{ "height": "42px", "padding": "0 16px", "borderRadius": "13px", "border": "0", "background": "var(--argo-ink)", "color": "#fff", "fontWeight": "600", "fontSize": "13px" }}>
                {view.t("生成候选草稿")}
              </button>
              <button data-act={"open-shortlist"} style={{ "height": "42px", "padding": "0 14px", "borderRadius": "13px", "border": "1px solid var(--argo-line)", "background": "#fff", "fontSize": "13px" }}>
                {cover.deferLabel}
              </button>
            </div>
          </div>
        </>}
        {cover.generating && <>
          <div data-enter={"1"} style={{ "flexShrink": "0", "border": "1px solid var(--argo-line)", "borderRadius": "18px", "padding": "18px", "display": "grid", "gap": "10px" }}>
            <div style={{ "display": "flex", "alignItems": "center", "gap": "10px", "fontSize": "13px", "color": "#4F5B73" }}>
              <span data-motion={"1"} style={{ "width": "14px", "height": "14px", "borderRadius": "50%", "border": "2px solid #DCE4EE", "borderTopColor": "var(--argo-ink)", "animation": "argoSpin .9s linear infinite" }}>
              </span>
              {view.t("正在结合 JD 与你的资料起草…")}
            </div>
            <span data-motion={"1"} style={{ "height": "10px", "borderRadius": "5px", "background": "linear-gradient(90deg,#EEF2F7,#F7FAFD,#EEF2F7)", "backgroundSize": "300% 100%", "animation": "argoShimmer 1.4s linear infinite", "width": "90%" }}>
            </span>
            <span data-motion={"1"} style={{ "height": "10px", "borderRadius": "5px", "background": "linear-gradient(90deg,#EEF2F7,#F7FAFD,#EEF2F7)", "backgroundSize": "300% 100%", "animation": "argoShimmer 1.4s linear infinite", "width": "70%" }}>
            </span>
            <span data-motion={"1"} style={{ "height": "10px", "borderRadius": "5px", "background": "linear-gradient(90deg,#EEF2F7,#F7FAFD,#EEF2F7)", "backgroundSize": "300% 100%", "animation": "argoShimmer 1.4s linear infinite", "width": "82%" }}>
            </span>
          </div>
        </>}
        {cover.hasDraft && <>
          <div data-enter={"1"} style={{ "flexShrink": "0", "border": "1px solid var(--argo-line)", "borderRadius": "18px", "background": "#fff", "boxShadow": "0 1px 2px rgba(10,17,40,.04),0 12px 30px -20px rgba(10,17,40,.25)", "overflow": "hidden" }}>
            <textarea disabled={cover.generating} data-cover-text={"1"} aria-label={view.t("编辑求职信草稿")} value={cover.text} rows={12} style={{ "width": "100%", "border": "0", "padding": "18px 20px", "fontSize": "14px", "lineHeight": "1.8", "color": "#1F2A44", "resize": "vertical", "minHeight": "260px", "background": "transparent", "outline": "none", "display": "block", "fontFamily": "inherit" }} onChange={events.onInput}>
            </textarea>
            <div style={{ "display": "flex", "alignItems": "center", "justifyContent": "space-between", "padding": "8px 14px 12px", "borderTop": "1px solid #EEF2F7", "fontSize": "11px", "color": "var(--argo-faint)" }}>
              <span>
                {cover.meta}
              </span>
              <button disabled={cover.generating} data-act={"cover-generate"} style={{ "height": "30px", "padding": "0 10px", "borderRadius": "9px", "border": "1px solid var(--argo-line)", "background": "#fff", "fontSize": "12px", "fontWeight": "600", "color": "var(--argo-ink)" }}>
                {view.t("重新生成")}
              </button>
            </div>
          </div>
        </>}
      </div>
      {cover.hasDraft && <>
        <div data-enter={"1"} style={{ "flexShrink": "0", "flex": "0 0 auto", "padding": "10px 20px 18px", "display": "grid", "gap": "6px", "borderTop": "1px solid #EEF2F7", "background": "rgba(255,255,255,.7)" }}>
          {cover.savedDraft && <button disabled={cover.generating} data-act="cover-delete" style={{height:36,borderRadius:12,border:"1px solid var(--argo-line)",background:"#fff",color:"var(--argo-muted)",fontSize:13}}>{view.t("删除草稿")}</button>}
          <button disabled={cover.generating} data-act={"cover-keep"} style={{ "height": "46px", "borderRadius": "14px", "border": "0", "background": "linear-gradient(180deg,#1B2542,var(--argo-ink))", "color": "#fff", "fontWeight": "600", "fontSize": "14px", "boxShadow": "inset 0 1px 0 rgba(255,255,255,.16),0 1px 2px rgba(10,17,40,.3)", "transition": "transform .16s cubic-bezier(.32,.72,0,1)" }} className="argo-interaction-afb2bbd2">
            {cover.keepLabel}
          </button>
          <div style={{ "textAlign": "center", "fontSize": "11px", "color": "var(--argo-faint)", "lineHeight": "1.5" }}>
            {cover.connected ? view.t("草稿保存在你的账号中；上传需另行确认。") : view.t("仅保存为本地示例草稿；正式保存与投递授权为待接能力，不会出现「已上传 / 已提交」。")}
          </div>
        </div>
      </>}
    </div>
  </>;
}
