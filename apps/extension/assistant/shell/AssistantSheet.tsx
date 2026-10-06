import { Fragment } from 'react';
import type { SceneProps } from '../app/view-types';

/** Layout ported from the accepted Fable design; behavior is supplied by the controller. */
export function AssistantSheet({ view, events }: SceneProps) {
  const { sheet } = view;
  return <>
    <div data-sheet-backdrop={"1"} data-act={"sheet-close"} style={{ "position": "absolute", "inset": "0", "background": "rgba(10,17,40,.28)", "zIndex": "40", "backdropFilter": "blur(2px)" }}>
    </div>
    <div data-sheet={"1"} role={"dialog"} aria-modal={"true"} aria-label={sheet.title} style={{ "position": "absolute", "left": "0", "right": "0", "bottom": "0", "maxHeight": "88%", "background": "#fff", "borderRadius": "24px 24px 28px 28px", "boxShadow": "0 -10px 40px -20px rgba(10,17,40,.35)", "zIndex": "41", "display": "flex", "flexDirection": "column", "overflow": "hidden" }}>
      <div style={{ "display": "flex", "alignItems": "center", "justifyContent": "space-between", "padding": "18px 20px 8px" }}>
        <div>
          <div style={{ "fontSize": "16px", "fontWeight": "600" }}>
            {sheet.title}
          </div>
          <div style={{ "fontSize": "12px", "color": "var(--argo-muted)", "marginTop": "2px" }}>
            {sheet.caption}
          </div>
        </div>
        <button data-act={"sheet-close"} aria-label={view.t("关闭")} style={{ "width": "32px", "height": "32px", "borderRadius": "50%", "border": "0", "background": "rgba(10,17,40,.05)", "color": "#4F5B73" }}>
          {"×"}
        </button>
      </div>
      <div data-scroll={"1"} style={{ "overflow": "auto", "padding": "4px 20px 20px", "flex": "1", "minHeight": "0", "minWidth": 0, "overflowWrap": "anywhere" }}>
        {sheet.isAts && <>
          <div style={{ "display": "grid", "gridTemplateColumns": "minmax(0,1fr)", "gap": "14px" }}>
            {sheet.ats.sample && <>
              <div style={{ "padding": "10px 12px", "borderRadius": "12px", "background": "var(--argo-lilac)", "fontSize": "12px", "color": "var(--argo-ink-2)", "lineHeight": "1.6" }}>
                {view.t("以下为")}
                <b>
                  {view.t("功能示例")}
                </b>
                {view.t("，不是你的评分。解锁后会基于你的简历与该岗位 JD 生成真实结果。")}
              </div>
            </>}
            <div style={{ "display": "flex", "alignItems": "center", "gap": "14px", "padding": "14px 16px", "borderRadius": "16px", "background": "var(--argo-grey)" }}>
              <div style={{ "display": "flex", "alignItems": "baseline", "gap": "2px", "flexShrink": 0, "whiteSpace": "nowrap" }}>
                <b style={{ "fontSize": "38px", "fontWeight": "700", "letterSpacing": "-1.5px", "lineHeight": "1" }}>
                  {sheet.ats.total}
                </b>
                <span style={{ "fontSize": "13px", "color": "var(--argo-faint)" }}>
                  {"/ "}{sheet.ats.max}
                </span>
              </div>
              <div style={{ "fontSize": "12px", "color": "#4F5B73", "lineHeight": "1.6", "minWidth": 0 }}>
                <b style={{ "display": "block", "color": "var(--argo-ink)", "fontWeight": "600" }}>
                  {sheet.ats.headline}
                </b>
                {view.t("简历：")}{sheet.ats.resume}{view.t(" · 岗位：")}{sheet.ats.job}
                <br />
                {view.t("这是 ATS 对简历与 JD 匹配度的评估，不是录用概率。")}
              </div>
            </div>
            <div style={{ "display": "grid", "gap": "10px" }}>
              {sheet.ats.dims.map((d, dIndex) => <Fragment key={dIndex}>
                <div style={{ "display": "grid", "gap": "6px", "padding": "10px 12px", "borderRadius": "14px", "border": "1px solid #EEF2F7" }}>
                  <div style={{ "display": "flex", "alignItems": "flex-start", "gap": "8px" }}>
                    <span style={{ "fontSize": "11px", "fontWeight": "700", "color": "var(--argo-faint)", "width": "16px", "flex": "0 0 auto", "paddingTop": "2px" }}>
                      {d.code}
                    </span>
                    <span style={{ "flex": "1", "minWidth": "0", "fontSize": "13px", "fontWeight": "600", "lineHeight": "1.4", "overflowWrap": "anywhere" }}>
                      {d.label}
                    </span>
                    <span style={{ "fontSize": "13px", "fontVariantNumeric": "tabular-nums", "color": d.scoreColor, "whiteSpace": "nowrap", "fontWeight": "600" }}>
                      {d.scoreText}
                    </span>
                  </div>
                  <div style={{ "height": "6px", "borderRadius": "3px", "background": "#EEF2F7", "overflow": "hidden", "marginLeft": "24px" }}>
                    <span data-dim-bar={"1"} style={{ "display": "block", "height": "100%", "width": `${d.pct}%`, "background": d.color, "borderRadius": "3px" }}>
                    </span>
                  </div>
                  <div style={{ "marginLeft": "24px", "fontSize": "12px", "color": "var(--argo-muted)", "lineHeight": "1.55" }}>
                    {d.desc}
                  </div>
                  {d.problems.map((pr, prIndex) => <Fragment key={prIndex}>
                    <div style={{ "marginLeft": "24px", "fontSize": "12px", "color": "#B86A2B", "display": "flex", "gap": "6px" }}>
                      <span>
                        {"·"}
                      </span>
                      <span>
                        {pr.text}
                      </span>
                    </div>
                  </Fragment>)}
                </div>
              </Fragment>)}
            </div>
            {sheet.ats.hasProblems && <>
              <div style={{ "display": "grid", "gap": "6px" }}>
                <b style={{ "fontSize": "13px", "fontWeight": "600" }}>
                  {view.t("整体问题")}
                </b>
                {sheet.ats.problems.map((p, pIndex) => <Fragment key={pIndex}>
                  <div style={{ "fontSize": "13px", "color": "#1F2A44", "lineHeight": "1.6", "display": "flex", "gap": "8px" }}>
                    <span style={{ "color": "#B86A2B" }}>
                      {"!"}
                    </span>
                    <span>
                      {p.text}
                    </span>
                  </div>
                </Fragment>)}
              </div>
            </>}
            <div style={{ "display": "grid", "gap": "6px" }}>
              <b style={{ "fontSize": "13px", "fontWeight": "600" }}>
                {view.t("改进建议")}
              </b>
              {sheet.ats.suggestions.map((s, sIndex) => <Fragment key={sIndex}>
                <div style={{ "fontSize": "13px", "color": "#1F2A44", "lineHeight": "1.6", "display": "flex", "gap": "8px" }}>
                  <span style={{ "color": "var(--argo-green)" }}>
                    {"→"}
                  </span>
                  <span>
                    {s.text}
                  </span>
                </div>
              </Fragment>)}
            </div>
            <div style={{ "display": "grid", "gap": "8px" }}>
              <b style={{ "fontSize": "13px", "fontWeight": "600" }}>
                {view.t("缺失关键词")}
              </b>
              <div style={{ "display": "flex", "flexWrap": "wrap", "gap": "6px" }}>
                {sheet.ats.missing.map((k, kIndex) => <Fragment key={kIndex}>
                  <span style={{ "fontSize": "12px", "padding": "5px 10px", "borderRadius": "999px", "background": "var(--argo-peach)", "color": "#8A5A2B" }}>
                    {k.text}
                  </span>
                </Fragment>)}
              </div>
            </div>
            <div style={{ "fontSize": "11px", "color": "#98A2B5", "lineHeight": "1.6", "paddingTop": "4px", "borderTop": "1px solid #EEF2F7" }}>
              {sheet.ats.meta}
            </div>
          </div>
        </>}
        {sheet.isJd && <>
          <div style={{ "display": "grid", "gap": "12px", "fontSize": "13px", "lineHeight": "1.7", "color": "#1F2A44" }}>
            <div style={{ "display": "flex", "flexWrap": "wrap", "gap": "6px" }}>
              <span style={{ "fontSize": "12px", "padding": "4px 9px", "borderRadius": "999px", "background": "var(--argo-grey)" }}>
                {sheet.jd.location}
              </span>
              <span style={{ "fontSize": "12px", "padding": "4px 9px", "borderRadius": "999px", "background": "var(--argo-grey)" }}>
                {sheet.jd.mode}
              </span>
              <span style={{ "fontSize": "12px", "padding": "4px 9px", "borderRadius": "999px", "background": "var(--argo-grey)" }}>
                {sheet.jd.type}
              </span>
              <span style={{ "fontSize": "12px", "padding": "4px 9px", "borderRadius": "999px", "background": "var(--argo-grey)" }}>
                {sheet.jd.salary}
              </span>
            </div>
            <p style={{ "margin": "0",whiteSpace:"pre-wrap",overflowWrap:"anywhere" }}>
              {sheet.jd.description||sheet.jd.summary}
            </p>
            {!sheet.jd.description && <><div>
              <b style={{ "fontWeight": "600" }}>
                {view.t("你会做什么（示例 JD）")}
              </b>
              <ul style={{ "margin": "6px 0 0", "paddingLeft": "18px" }}>
                {sheet.jd.responsibilities.map((text, i) => <li key={i}>{text}</li>)}
              </ul>
            </div>
            <div>
              <b style={{ "fontWeight": "600" }}>
                {view.t("我们希望你")}
              </b>
              <ul style={{ "margin": "6px 0 0", "paddingLeft": "18px" }}>
                {sheet.jd.requirements.map((text, i) => <li key={i}>{text}</li>)}
              </ul>
            </div>
            <div style={{ "fontSize": "11px", "color": "#98A2B5", "borderTop": "1px solid #EEF2F7", "paddingTop": "10px" }}>
              {view.t("来源 ")}{sheet.jd.source}{" · "}{sheet.jd.boardUrl}{view.t(" · JD 版本 ")}{sheet.jd.jdDigest}{view.t(" · 数据来自后端可信岗位，不读取当前网页。")}
            </div></>}
          </div>
        </>}
        {sheet.isUsage && <>
          <div style={{ "display": "grid", "gap": "8px" }}>
            {sheet.usage.map((u, uIndex) => <Fragment key={uIndex}>
              <div style={{ "display": "grid", "gap": "8px", "padding": "12px 14px", "borderRadius": "14px", "border": "1px solid #EEF2F7", "background": "#fff" }}>
                <div style={{ "display": "flex", "alignItems": "center", "gap": "8px" }}>
                  <b style={{ "flex": "1", "fontSize": "13px", "fontWeight": "600" }}>
                    {u.label}
                  </b>
                  <span style={{ "fontSize": "11px", "fontWeight": "600", "padding": "3px 8px", "borderRadius": "999px", "background": u.tagBg, "color": u.tagColor }}>
                    {u.tag}
                  </span>
                </div>
                {u.hasBar && <>
                  <div style={{ "height": "6px", "borderRadius": "3px", "background": "#EEF2F7", "overflow": "hidden" }}>
                    <span style={{ "display": "block", "height": "100%", "width": `${u.pct}%`, "background": u.barColor, "borderRadius": "3px" }}>
                    </span>
                  </div>
                </>}
                <div style={{ "display": "flex", "justifyContent": "space-between", "fontSize": "12px", "color": "var(--argo-muted)" }}>
                  <span>
                    {u.line}
                  </span>
                  <span>
                    {u.right}
                  </span>
                </div>
              </div>
            </Fragment>)}
            <div style={{ "fontSize": "11px", "color": "#98A2B5", "lineHeight": "1.6", "padding": "6px 2px" }}>
              {view.t("以上数字均为示例，套餐、价格与周期尚未设定；真实用量由服务端权益策略返回。是否可用与可用数量分别呈现；不限量与未知不用同一个空值表达。")}
            </div>
            <button data-act={"open-plans"} style={{ "height": "44px", "borderRadius": "13px", "border": "1px solid var(--argo-line)", "background": "#fff", "fontWeight": "600", "fontSize": "13px" }}>
              {view.t("查看套餐（Portal）")}
            </button>
          </div>
        </>}
        {sheet.isResume && <>
          <div style={{ "display": "grid", "gap": "8px" }}>
            {sheet.resumeStatus && <p role="status" style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--argo-muted)' }}>{sheet.resumeStatus}</p>}
            {sheet.versions.map((v, vIndex) => <Fragment key={vIndex}>
              <div style={{ "display": "flex", "alignItems": "center", "gap": "10px", "padding": "12px 14px", "borderRadius": "14px", "border": "1px solid #EEF2F7" }}>
                <span style={{ "width": "34px", "height": "34px", "borderRadius": "10px", "background": "var(--argo-ice)", "display": "flex", "alignItems": "center", "justifyContent": "center" }}>
                  <svg width={"16"} height={"16"} viewBox={"0 0 24 24"} fill={"none"} stroke={"#0A1128"} strokeWidth={"1.7"} strokeLinecap={"round"} strokeLinejoin={"round"}>
                    <path d={"M6 3h8l4 4v14H6zM14 3v5h4"}>
                    </path>
                  </svg>
                </span>
                <span style={{ "flex": "1" }}>
                  <b style={{ "display": "block", "fontSize": "13px", "fontWeight": "600" }}>
                    {v.label}
                  </b>
                  <span style={{ "fontSize": "12px", "color": "var(--argo-faint)" }}>
                    {v.note}
                  </span>
                </span>
                <span style={{ "fontSize": "11px", "fontWeight": "600", "padding": "3px 8px", "borderRadius": "999px", "background": v.tagBg, "color": v.tagColor }}>
                  {v.tag}
                </span>
              </div>
            </Fragment>)}
            <div style={{ "fontSize": "12px", "color": "var(--argo-muted)", "lineHeight": "1.6", "padding": "4px 2px" }}>
              {sheet.readOnly ? view.t("这里展示简历库中的版本信息。申请使用与文件交付权限将在后续流程中重新验证。") : view.t("版本来自你的简历库。更换用于评分或申请的版本后，已有的 ATS 评估需要重新评估，申请材料需要重新核对。")}
            </div>
            {sheet.readOnly && <button data-act="session-refresh" style={{ height: 44, borderRadius: 13, border: '1px solid var(--argo-line)', background: '#fff' }}>刷新资料与简历</button>}
          </div>
        </>}
        {sheet.isFillConfirm && <>
          <div style={{ "display": "grid", "gap": "12px" }}>
            <div style={{ "display": "grid", "gap": "6px" }}>
              {sheet.fillUses.map((u, uIndex) => <Fragment key={uIndex}>
                <div style={{ "display": "flex", "justifyContent": "space-between", "gap": "12px", "fontSize": "13px", "padding": "8px 12px", "borderRadius": "10px", "background": "#F7FAFD" }}>
                  <span style={{ "color": "var(--argo-muted)" }}>
                    {u.label}
                  </span>
                  <span style={{ "fontWeight": "600", "textAlign": "right", "overflow": "hidden", "textOverflow": "ellipsis", "whiteSpace": "nowrap" }}>
                    {u.value}
                  </span>
                </div>
              </Fragment>)}
            </div>
            <p style={{ "margin": "0", "fontSize": "12px", "color": "var(--argo-muted)", "lineHeight": "1.65" }}>
              {view.t("只在这个岗位、这个申请页与上述资料范围内填写。工作授权、签名等需本人回答的问题会留给你；插件不会点击网站的 Submit。")}
            </p>
            <button data-act={"fill-confirm"} style={{ "height": "46px", "borderRadius": "14px", "border": "0", "background": "linear-gradient(180deg,#1B2542,var(--argo-ink))", "color": "#fff", "fontWeight": "600", "fontSize": "14px" }}>
              {view.t("开始填写")}
            </button>
          </div>
        </>}
        {sheet.isTargets && <>
          <div style={{ "display": "grid", "gap": "8px" }}>
            {sheet.targets.map((t, tIndex) => <Fragment key={t.id}>
              <button data-act={"target-use"} data-arg={t.id} data-target-row={"1"} style={{ "display": "grid", "gridTemplateColumns": "1fr auto", "gap": "8px 12px", "alignItems": "center", "padding": "12px 14px", "borderRadius": "16px", "border": `1px solid ${t.border}`, "background": t.bg, "textAlign": "left", "boxShadow": t.shadow, "transition": "transform .18s cubic-bezier(.32,.72,0,1),background .2s,border-color .2s" }} className="argo-interaction-7b62346d argo-interaction-39b90613">
                <span style={{ "minWidth": "0" }}>
                  <b style={{ "display": "block", "fontSize": "14px", "fontWeight": "600" }}>
                    {t.role}
                  </b>
                  <span style={{ "display": "block", "fontSize": "12px", "color": "var(--argo-muted)", "marginTop": "2px", "overflow": "hidden", "textOverflow": "ellipsis", "whiteSpace": "nowrap" }}>
                    {t.line}
                  </span>
                  <span style={{ "display": "block", "fontSize": "12px", "color": "var(--argo-faint)", "marginTop": "2px" }}>
                    {t.line2}
                  </span>
                </span>
                <span style={{ "fontSize": "11px", "fontWeight": "600", "padding": "4px 9px", "borderRadius": "999px", "background": t.tagBg, "color": t.tagColor, "whiteSpace": "nowrap" }}>
                  {t.tag}
                </span>
              </button>
            </Fragment>)}
            {sheet.targetsEmpty && <>
              <div style={{ "padding": "18px 16px", "border": "1px dashed #C9D6E6", "borderRadius": "16px", "fontSize": "13px", "color": "var(--argo-muted)", "lineHeight": "1.7", "textAlign": "center" }}>
                {view.t("还没有保存的目标岗位。")}
                <br />
                {view.t("告诉 ArgoLand.AI 你想找的方向，就会整理成一组可复用的偏好。")}
              </div>
            </>}
            <button data-act={"target-add"} style={{ "height": "46px", "borderRadius": "14px", "border": "1px dashed #C9D6E6", "background": "#fff", "fontSize": "13px", "fontWeight": "600", "color": "var(--argo-ink)", "display": "flex", "alignItems": "center", "justifyContent": "center", "gap": "8px" }} className="argo-interaction-7b62346d">
              <span style={{ "width": "22px", "height": "22px", "borderRadius": "50%", "background": "#EEF1FB", "display": "flex", "alignItems": "center", "justifyContent": "center", "fontSize": "15px", "lineHeight": "1" }}>
                {"+"}
              </span>
              {view.t("添加新的目标岗位")}
            </button>
            <div style={{ "fontSize": "11px", "color": "#98A2B5", "lineHeight": "1.6", "padding": "4px 2px" }}>
              {view.t("每一组目标岗位都会同步到你的 ArgoLand 资料（正式接线为待接能力）。选中的一组用于今天的岗位推荐、ATS 评估与申请材料。")}
            </div>
          </div>
        </>}
        {sheet.isLetters && <>
          <div style={{ "display": "grid", "gap": "12px", "fontSize": "13px", "lineHeight": "1.7", "color": "#1F2A44" }}>
            <p style={{ "margin": "0" }}>
              {view.t("求职信属于具体岗位的材料。选定岗位后，ArgoLand.AI 会结合该岗位 JD 与你已确认的资料生成候选草稿，你可以修改后再决定是否使用。")}
            </p>
            {sheet.lettersHasJobs && <>
              <div style={{ "display": "grid", "gap": "6px" }}>
                {sheet.lettersJobs.map((j, jIndex) => <Fragment key={j.id}>
                  <button data-act={"open-cover"} data-arg={j.id} style={{ "display": "flex", "alignItems": "center", "gap": "10px", "padding": "10px 12px", "borderRadius": "12px", "border": "1px solid #EEF2F7", "background": "#fff", "textAlign": "left" }} className="argo-interaction-7b62346d">
                    <span style={{ "width": "30px", "height": "30px", "borderRadius": "9px", "background": j.markBg, "display": "flex", "alignItems": "center", "justifyContent": "center", "fontWeight": "700", "fontSize": "12px" }}>
                      {j.initial}
                    </span>
                    <span style={{ "flex": "1" }}>
                      <b style={{ "display": "block", "fontWeight": "600", "fontSize": "13px" }}>
                        {j.title}
                      </b>
                      <span style={{ "fontSize": "12px", "color": "var(--argo-faint)" }}>
                        {j.company}{" · "}{j.letterState}
                      </span>
                    </span>
                  </button>
                </Fragment>)}
              </div>
            </>}
            {sheet.lettersNoJobs && <>
              <button data-act={"discover"} style={{ "height": "44px", "borderRadius": "13px", "border": "0", "background": "var(--argo-ink)", "color": "#fff", "fontWeight": "600", "fontSize": "13px" }}>
                {view.t("先去发现岗位")}
              </button>
            </>}
          </div>
        </>}
      </div>
    </div>
  </>;
}
