import { Fragment } from 'react';
import type { AssistantEvents } from '../app/view-types';
import type { hostView } from './host-view';
type SceneProps = { view: { host: ReturnType<typeof hostView> }; events: AssistantEvents };

/** Layout ported from the accepted Fable design; behavior is supplied by the controller. */
export function HostPage({ view, events }: SceneProps) {
  const { host } = view;
  return <>
    <div data-host={"1"} data-scroll={"1"} style={{ "position": "absolute", "inset": "0", "overflow": "auto", "background": "#FBFBFC" }}>
      {host.isJournal && <>
        <div style={{ "maxWidth": "720px", "margin": "0 auto", "padding": "56px 40px 120px", "color": "#1F2A44" }}>
          <div style={{ "display": "flex", "justifyContent": "space-between", "alignItems": "center", "fontSize": "13px", "color": "var(--argo-muted)" }}>
            <b style={{ "color": "var(--argo-ink)", "fontWeight": "600", "letterSpacing": ".2px" }}>
              {"The Openfield"}
            </b>
            <span style={{ "display": "flex", "gap": "22px" }}>
              <span>
                {"Journal"}
              </span>
              <span>
                {"Ideas"}
              </span>
              <span>
                {"About"}
              </span>
            </span>
          </div>
          <div style={{ "marginTop": "72px", "fontSize": "11px", "letterSpacing": "2.4px", "color": "var(--argo-faint)" }}>
            {"A PLACE TO BEGIN AGAIN"}
          </div>
          <h1 style={{ "margin": "16px 0 0", "fontSize": "44px", "lineHeight": "1.1", "fontWeight": "600", "letterSpacing": "-.8px", "color": "var(--argo-ink)", "textWrap": "pretty" }}>
            {"Good things take a little exploration."}
          </h1>
          <p style={{ "margin": "20px 0 0", "fontSize": "17px", "lineHeight": "1.7", "color": "#4F5B73", "maxWidth": "520px" }}>
            {"Small discoveries, different perspectives, and a little room for whatever comes next."}
          </p>
          <div style={{ "height": "1px", "background": "var(--argo-line)", "margin": "56px 0 28px" }}>
          </div>
          <div style={{ "display": "grid", "gap": "18px" }}>
            <div style={{ "display": "flex", "gap": "18px", "alignItems": "center", "padding": "18px", "border": "1px solid var(--argo-line)", "borderRadius": "16px", "background": "#fff" }}>
              <span style={{ "width": "44px", "height": "44px", "borderRadius": "12px", "background": "var(--argo-ice)", "display": "flex", "alignItems": "center", "justifyContent": "center", "color": "var(--argo-ink)" }}>
                {"↗"}
              </span>
              <span style={{ "flex": "1" }}>
                <b style={{ "display": "block", "fontWeight": "600" }}>
                  {"Making space for a new chapter"}
                </b>
                <span style={{ "fontSize": "13px", "color": "var(--argo-muted)" }}>
                  {"Ideas · 5 min read"}
                </span>
              </span>
            </div>
            <div style={{ "display": "flex", "gap": "18px", "alignItems": "center", "padding": "18px", "border": "1px solid var(--argo-line)", "borderRadius": "16px", "background": "#fff" }}>
              <span style={{ "width": "44px", "height": "44px", "borderRadius": "12px", "background": "var(--argo-lilac)", "display": "flex", "alignItems": "center", "justifyContent": "center", "color": "var(--argo-ink)" }}>
                {"○"}
              </span>
              <span style={{ "flex": "1" }}>
                <b style={{ "display": "block", "fontWeight": "600" }}>
                  {"The things that make work meaningful"}
                </b>
                <span style={{ "fontSize": "13px", "color": "var(--argo-muted)" }}>
                  {"Perspectives · 8 min read"}
                </span>
              </span>
            </div>
          </div>
          <p style={{ "marginTop": "48px", "fontSize": "12px", "color": "#98A2B5", "lineHeight": "1.7" }}>
            {"这是一个虚构的普通网页，用来演示 ArgoLand.AI 随处唤起。面板右上角 × 收起面板；悬浮入口旁的 × 隐藏入口，之后从浏览器工具栏的 ArgoLand 按钮唤回。"}
          </p>
        </div>
      </>}
      {host.isJob && <>
        <div style={{ "maxWidth": "680px", "margin": "0 auto", "padding": "40px 40px 140px", "color": "#1F2A44" }}>
          <div style={{ "display": "flex", "justifyContent": "space-between", "alignItems": "center", "fontSize": "13px", "color": "var(--argo-muted)" }}>
            <b style={{ "color": "var(--argo-ink)", "fontWeight": "600" }}>
              {host.job.company}
            </b>
            <span style={{ "display": "flex", "gap": "22px" }}>
              <span>
                {"Our story"}
              </span>
              <span>
                {"Careers"}
              </span>
            </span>
          </div>
          <div style={{ "marginTop": "44px", "fontSize": "11px", "letterSpacing": "2.4px", "color": "var(--argo-faint)" }}>
            {"JOIN OUR TEAM · 示例申请页"}
          </div>
          <h1 style={{ "margin": "12px 0 0", "fontSize": "32px", "lineHeight": "1.15", "fontWeight": "600", "letterSpacing": "-.5px" }}>
            {host.job.title}
          </h1>
          <p style={{ "margin": "10px 0 0", "color": "var(--argo-muted)" }}>
            {host.job.location}{" · "}{host.job.mode}{" · "}{host.job.type}
          </p>
          <div style={{ "height": "1px", "background": "var(--argo-line)", "margin": "32px 0 24px" }}>
          </div>
          <div style={{ "fontSize": "11px", "letterSpacing": "2.4px", "color": "var(--argo-faint)", "marginBottom": "16px" }}>
            {"YOUR APPLICATION"}
          </div>
          <div style={{ "display": "grid", "gap": "14px" }}>
            {host.fields.map((f, fIndex) => <Fragment key={fIndex}>
              <div style={{ "display": "grid", "gap": "6px" }}>
                <label style={{ "fontSize": "13px", "color": "#4F5B73" }}>
                  {f.label}{" "}
                  <span style={{ "color": "var(--argo-coral)" }}>
                    {"*"}
                  </span>
                </label>
                <div data-host-field={f.key} style={{ "minHeight": "42px", "border": `1px solid ${f.border}`, "background": f.bg, "borderRadius": "10px", "padding": "10px 12px", "fontSize": "14px", "color": "var(--argo-ink)", "transition": "background .4s,border-color .4s" }}>
                  {f.value}
                  <span style={{ "color": "#98A2B5", "fontSize": "12px" }}>
                    {f.hint}
                  </span>
                </div>
              </div>
            </Fragment>)}
          </div>
          <div style={{ "marginTop": "14px", "display": "grid", "gap": "14px" }}>
            <div style={{ "display": "grid", "gap": "6px" }}>
              <label style={{ "fontSize": "13px", "color": "#4F5B73" }}>
                {"Are you legally authorized to work in the US? "}
                <span style={{ "color": "var(--argo-coral)" }}>
                  {"*"}
                </span>
              </label>
              <div style={{ "minHeight": "42px", "border": `1px solid ${host.manualBorder}`, "background": "#fff", "borderRadius": "10px", "padding": "10px 12px", "fontSize": "13px", "color": "#98A2B5", "transition": "border-color .4s", "boxShadow": host.manualGlow }}>
                {"Select an option — 由你本人回答"}
              </div>
            </div>
            <div style={{ "display": "grid", "gap": "6px" }}>
              <label style={{ "fontSize": "13px", "color": "#4F5B73" }}>
                {"I confirm the information above is accurate (signature) "}
                <span style={{ "color": "var(--argo-coral)" }}>
                  {"*"}
                </span>
              </label>
              <div style={{ "minHeight": "42px", "border": `1px solid ${host.manualBorder}`, "background": "#fff", "borderRadius": "10px", "padding": "10px 12px", "fontSize": "13px", "color": "#98A2B5", "transition": "border-color .4s", "boxShadow": host.manualGlow }}>
                {"Type your full name — 由你本人完成"}
              </div>
            </div>
          </div>
          <p style={{ "margin": "18px 0 0", "fontSize": "12px", "color": "#98A2B5" }}>
            {"工作授权问题、信息确认与签名由申请人本人完成。"}
          </p>
          <button data-act={"host-submit"} data-host-submit={"1"} style={{ "marginTop": "22px", "height": "46px", "padding": "0 22px", "borderRadius": "10px", "border": "0", "background": "var(--argo-ink)", "color": "#fff", "fontWeight": "600", "transition": "box-shadow .4s", "boxShadow": host.submitGlow }}>
            {"Submit application "}
            <span style={{ "opacity": ".6", "fontWeight": "400", "fontSize": "12px", "marginLeft": "8px" }}>
              {"网站原生按钮示意"}
            </span>
          </button>
        </div>
      </>}
    </div>
  </>;
}
