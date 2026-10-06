import { Fragment } from 'react';
import type { SceneProps } from '../app/view-types';

/** Layout ported from the accepted Fable design; behavior is supplied by the controller. */
export function PreparingScene({ view, events }: SceneProps) {
  const { prep } = view;
  return <>
    <div data-scene={"preparing"} data-scroll={"1"} style={{ "flex": "1", "minHeight": "0", "overflow": "auto", "padding": "10px 24px 20px", "display": "flex", "flexDirection": "column", "gap": "16px" }}>
      <div data-enter={"1"} style={{ "flexShrink": "0", "textAlign": "center", "paddingTop": "6px" }}>
        <div style={{ "fontSize": "11px", "letterSpacing": "2.4px", "color": "var(--argo-faint)", "fontWeight": "600" }}>
          {"PREPARING"}
        </div>
        <h2 style={{ "margin": "8px 0 0", "fontSize": "21px", "lineHeight": "1.3", "fontWeight": "600", "letterSpacing": "-.4px" }}>
          {view.t("把你的故事，放进这些新的可能。")}
        </h2>
        <p style={{ "margin": "6px 0 0", "fontSize": "13px", "color": "var(--argo-muted)" }}>
          {view.t("正在为 ")}{prep.count}{view.t(" 个机会核对岗位与简历版本 · ")}{prep.resumeLabel}
        </p>
      </div>
      <div data-enter={"1"} style={{ "flexShrink": "0", "display": "grid", "gap": "8px" }}>
        {prep.items.map((p, pIndex) => <Fragment key={pIndex}>
          <div style={{ "display": "flex", "alignItems": "center", "gap": "12px", "padding": "12px 14px", "borderRadius": "14px", "background": "#fff", "border": "1px solid var(--argo-line)", "boxShadow": "0 1px 2px rgba(10,17,40,.04)" }}>
            <span style={{ "width": "28px", "height": "28px", "borderRadius": "9px", "background": p.markBg, "display": "flex", "alignItems": "center", "justifyContent": "center", "fontWeight": "700", "fontSize": "12px" }}>
              {p.initial}
            </span>
            <span style={{ "flex": "1", "minWidth": "0" }}>
              <b style={{ "display": "block", "fontSize": "13px", "fontWeight": "600", "overflow": "hidden", "textOverflow": "ellipsis", "whiteSpace": "nowrap" }}>
                {p.title}
              </b>
              <span style={{ "fontSize": "11px", "color": "var(--argo-faint)" }}>
                {p.company}
              </span>
            </span>
            <span style={{ "display": "flex", "alignItems": "center", "gap": "6px", "fontSize": "12px", "color": p.color, "whiteSpace": "nowrap" }}>
              {p.spinning && <>
                <span data-motion={"1"} style={{ "width": "12px", "height": "12px", "borderRadius": "50%", "border": "2px solid #DCE4EE", "borderTopColor": "var(--argo-ink)", "animation": "argoSpin .9s linear infinite" }}>
                </span>
              </>}
              {p.status}
            </span>
          </div>
        </Fragment>)}
      </div>
      <p data-enter={"1"} style={{ "flexShrink": "0", "margin": "auto 0 0", "textAlign": "center", "fontSize": "11px", "color": "#98A2B5" }}>
        {view.t("每个岗位单独准备与报告结果；失败的岗位可单独重试。原型进度为演示。")}
      </p>
    </div>
  </>;
}
