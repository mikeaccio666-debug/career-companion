import { Fragment } from 'react';
import type { SceneProps } from '../app/view-types';

/** Layout ported from the accepted Fable design; behavior is supplied by the controller. */
export function ShortlistScene({ view, events }: SceneProps) {
  const { short } = view;
  return <>
    <div data-scene={"shortlist"} style={{ "flex": "1", "minHeight": "0", "display": "flex", "flexDirection": "column" }}>
      <div data-scroll={"1"} style={{ "flex": "1", "minHeight": "0", "overflow": "auto", "padding": "6px 20px 12px", "display": "grid", "gap": "12px", "alignContent": "start" }}>
        <div data-enter={"1"} style={{ "flexShrink": "0", "padding": "4px 4px 0" }}>
          <div style={{ "fontSize": "11px", "letterSpacing": "2.4px", "color": "var(--argo-faint)", "fontWeight": "600" }}>
            {"YOUR SHORTLIST · "}{short.count}
          </div>
          <h2 style={{ "margin": "6px 0 0", "fontSize": "22px", "lineHeight": "1.3", "fontWeight": "600", "letterSpacing": "-.4px" }}>
            {short.title}
          </h2>
          <p style={{ "margin": "6px 0 0", "fontSize": "13px", "color": "var(--argo-muted)", "lineHeight": "1.6" }}>
            {short.sub}
          </p>
        </div>
        {short.empty && <>
          <div data-enter={"1"} style={{ "flexShrink": "0", "padding": "28px 20px", "border": "1px dashed #C9D6E6", "borderRadius": "18px", "textAlign": "center", "color": "var(--argo-muted)", "fontSize": "13px", "lineHeight": "1.7" }}>
            {view.t("还没有选中的机会。")}
            <br />
            {view.t("把心动的岗位留在这里，再一起准备。")}
            <div style={{ "marginTop": "14px" }}>
              <button data-act={"discover"} style={{ "height": "42px", "padding": "0 16px", "borderRadius": "13px", "border": "0", "background": "var(--argo-ink)", "color": "#fff", "fontWeight": "600", "fontSize": "13px" }}>
                {view.t("发现今天的机会")}
              </button>
            </div>
          </div>
        </>}
        {short.hasItems && <>
          <div data-enter={"1"} style={{ "flexShrink": "0", "border": "1px solid var(--argo-line)", "borderRadius": "18px", "background": "#fff", "padding": "14px 16px", "display": "grid", "gap": "10px", "boxShadow": "0 1px 2px rgba(10,17,40,.04)" }}>
            <div style={{ "display": "flex", "alignItems": "center", "justifyContent": "space-between" }}>
              <b style={{ "fontSize": "13px", "fontWeight": "600" }}>
                {view.t("这轮使用的简历")}
              </b>
              <span style={{ "fontSize": "11px", "color": "var(--argo-faint)" }}>
                {short.planNote}
              </span>
            </div>
            <div style={{ "display": "grid", "gap": "6px" }}>
              {short.versions.map((v, vIndex) => <Fragment key={v.id}>
                <button data-act={short.connected?"material-select":"pick-resume"} data-arg={v.id} disabled={short.locked} style={{ "display": "flex", "alignItems": "center", "gap": "10px", "padding": "10px 12px", "borderRadius": "12px", "border": `1px solid ${v.border}`, "background": v.bg, "textAlign": "left", "transition": "background .2s,border-color .2s" }}>
                  <span style={{ "width": "18px", "height": "18px", "borderRadius": "50%", "border": `2px solid ${v.ring}`, "display": "flex", "alignItems": "center", "justifyContent": "center", "flex": "0 0 auto" }}>
                    <span style={{ "width": "8px", "height": "8px", "borderRadius": "50%", "background": v.dot }}>
                    </span>
                  </span>
                  <span style={{ "flex": "1", "minWidth": "0" }}>
                    <b style={{ "display": "block", "fontSize": "13px", "fontWeight": "600" }}>
                      {v.label}
                    </b>
                    <span style={{ "fontSize": "11px", "color": "var(--argo-faint)" }}>
                      {v.note}
                    </span>
                  </span>
                  <span style={{ "fontSize": "11px", "fontWeight": "600", "padding": "3px 8px", "borderRadius": "999px", "background": v.tagBg, "color": v.tagColor }}>
                    {v.tag}
                  </span>
                </button>
              </Fragment>)}
            </div>
          </div>
          <div data-enter={"1"} style={{ "flexShrink": "0", "display": "grid", "gap": "8px" }}>
            {short.items.map((it, itIndex) => <Fragment key={it.id}>
              <article data-short-row={it.id} style={{ "border": "1px solid var(--argo-line)", "borderRadius": "16px", "background": "#fff", "padding": "12px 14px", "display": "grid", "gap": "10px", "boxShadow": "0 1px 2px rgba(10,17,40,.04)" }}>
                <div style={{ "display": "flex", "alignItems": "center", "gap": "10px" }}>
                  <span style={{ "width": "34px", "height": "34px", "borderRadius": "11px", "background": it.markBg, "display": "flex", "alignItems": "center", "justifyContent": "center", "fontWeight": "700", "fontSize": "13px" }}>
                    {it.initial}
                  </span>
                  <span style={{ "flex": "1", "minWidth": "0" }}>
                    <b style={{ "display": "block", "fontSize": "14px", "fontWeight": "600", "overflow": "hidden", "textOverflow": "ellipsis", "whiteSpace": "nowrap" }}>
                      {it.title}
                    </b>
                    <span style={{ "fontSize": "12px", "color": "var(--argo-muted)" }}>
                      {it.company}{" · "}{it.location}
                    </span>
                  </span>
                  {it.removable && <>
                    <button data-act={"short-remove"} data-arg={it.id} aria-label={view.t("移除")} style={{ "width": "30px", "height": "30px", "borderRadius": "50%", "border": "0", "background": "transparent", "color": "#98A2B5", "fontSize": "16px" }} className="argo-interaction-e57751b0">
                      {"×"}
                    </button>
                  </>}
                  {it.openable && <>
                    <button data-act={"open-job-page"} data-arg={it.id} style={{ "height": "34px", "padding": "0 12px", "borderRadius": "10px", "border": "0", "background": "var(--argo-ink)", "color": "#fff", "fontSize": "12px", "fontWeight": "600", "display": "flex", "alignItems": "center", "gap": "6px", "whiteSpace": "nowrap" }}>
                      {view.t("去填写")}
                      <svg width={"12"} height={"12"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"2.2"} strokeLinecap={"round"} strokeLinejoin={"round"}>
                        <path d={"M14 3h7v7M21 3l-9 9M10 5H3v16h16v-7"}>
                        </path>
                      </svg>
                    </button>
                  </>}
                  {it.retryable && <>
                    <button data-act={"short-retry"} data-arg={it.id} style={{ "height": "34px", "padding": "0 12px", "borderRadius": "10px", "border": "1px solid #F1C9C2", "background": "#fff", "color": "#B4483A", "fontSize": "12px", "fontWeight": "600", "whiteSpace": "nowrap" }}>
                      {view.t("重试")}
                    </button>
                  </>}
                </div>
                <div style={{ "display": "flex", "alignItems": "center", "justifyContent": "space-between", "gap": "8px", "fontSize": "12px" }}>
                  <span style={{ "display": "flex", "alignItems": "center", "gap": "6px", "color": it.statusColor }}>
                    <span style={{ "width": "7px", "height": "7px", "borderRadius": "50%", "background": it.statusDot }}>
                    </span>
                    {it.status}
                  </span>
                  <button data-act="open-jd" data-arg={it.id} style={{border:0,background:"transparent",fontSize:12,color:"var(--argo-ink)",textDecoration:"underline"}}>{view.t("查看岗位详情")}</button>
                  <button data-act={"open-cover"} data-arg={it.id} style={{ "border": "0", "background": "transparent", "fontSize": "12px", "fontWeight": "600", "color": "var(--argo-ink)", "textDecoration": "underline", "textDecorationColor": "#C9D2DF", "textUnderlineOffset": "3px", "padding": "0" }}>
                    {it.letterLabel}
                  </button>
                </div>
              </article>
            </Fragment>)}
          </div>
        </>}
      </div>
      {short.moreSaved && <button data-act="short-more" disabled={short.loading} style={{margin:'8px 20px',padding:12,border:'1px solid var(--argo-line)',borderRadius:12,background:'white'}}>{view.t("加载更多收藏")}</button>}
      {short.hasItems && <>
        <div data-enter={"1"} style={{ "flexShrink": "0", "flex": "0 0 auto", "padding": "10px 20px 18px", "display": "grid", "gap": "6px", "borderTop": "1px solid #EEF2F7", "background": "rgba(255,255,255,.7)", "backdropFilter": "blur(8px)" }}>
          <button data-act={short.primaryAct} style={{ "height": "48px", "borderRadius": "14px", "border": `1px solid ${short.primaryBorder}`, "background": short.primaryBg, "color": short.primaryColor, "fontWeight": "600", "fontSize": "14px", "display": "flex", "alignItems": "center", "justifyContent": "center", "gap": "8px", "boxShadow": short.primaryShadow, "transition": "transform .16s cubic-bezier(.32,.72,0,1)" }} className="argo-interaction-afb2bbd2">
            {short.primaryLabel}
          </button>
          <div style={{ "textAlign": "center", "fontSize": "11px", "color": "var(--argo-faint)", "lineHeight": "1.5" }}>
            {short.foot}
          </div>
        </div>
      </>}
    </div>
  </>;
}
