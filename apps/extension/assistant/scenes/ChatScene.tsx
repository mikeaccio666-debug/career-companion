import { Fragment } from 'react';
import { StreamingText } from './StreamingText';
import type { SceneProps } from '../app/view-types';

/** Layout ported from the accepted Fable design; behavior is supplied by the controller. */
export function ChatScene({ view, events }: SceneProps) {
  const { chat, ui, voice } = view;
  return <>
    <div data-scene={"chat"} style={{ "flex": "1", "minHeight": "0", "display": "flex" }}>
      {ui.wide && <>
        <aside data-enter={"1"} style={{ "flexShrink": "0", "width": "216px", "flex": "0 0 auto", "padding": "6px 8px 20px 20px", "display": "flex", "flexDirection": "column", "gap": "6px" }}>
          <div style={{ "fontSize": "11px", "letterSpacing": "2.4px", "color": "var(--argo-faint)", "fontWeight": "600", "padding": "6px 12px 8px" }}>
            {view.t("补全资料")}
          </div>
          {chat.stages.map((s, sIndex) => <Fragment key={sIndex}>
            <div style={{ "display": "flex", "gap": "10px", "alignItems": "center", "padding": "10px 12px", "borderRadius": "12px", "background": s.bg, "color": s.color, "transition": "background .3s" }}>
              <span style={{ "width": "22px", "height": "22px", "borderRadius": "50%", "background": s.dotBg, "color": s.dotColor, "fontSize": "11px", "display": "flex", "alignItems": "center", "justifyContent": "center", "fontWeight": "600", "flex": "0 0 auto" }}>
                {s.mark}
              </span>
              <span style={{ "fontSize": "13px", "fontWeight": s.weight }}>
                {s.title}
              </span>
            </div>
          </Fragment>)}
          <p style={{ "margin": "14px 12px 0", "fontSize": "12px", "lineHeight": "1.7", "color": "var(--argo-faint)" }}>
            {view.t("你确认过的信息，才会成为你的求职资料。随时可以停下，之后继续。")}
          </p>
          <div style={{ "margin": "auto 0 0", "padding": "12px", "borderRadius": "14px", "background": "var(--argo-grey)", "fontSize": "12px", "color": "#4F5B73", "lineHeight": "1.6" }}>
            <span style={{ "color": "var(--argo-faint)" }}>
              {view.t("使用中的简历")}
            </span>
            <br />
            <b style={{ "fontWeight": "600", "color": "var(--argo-ink)" }}>
              {chat.resumeLabel}
            </b>
          </div>
        </aside>
      </>}
      <div style={{ "flex": "1", "minWidth": "0", "display": "flex", "flexDirection": "column" }}>
        {ui.narrow && <>
          <div style={{ "display": "flex", "gap": "6px", "padding": "4px 20px 8px", "overflow": "auto" }}>
            {chat.stages.map((s, sIndex) => <Fragment key={sIndex}>
              <span style={{ "fontSize": "12px", "padding": "6px 10px", "borderRadius": "999px", "background": s.bg, "color": s.color, "whiteSpace": "nowrap", "fontWeight": s.weight }}>
                {s.mark}{" "}{s.title}
              </span>
            </Fragment>)}
          </div>
        </>}
        <div data-chat-scroll={"1"} data-scroll={"1"} style={{ "flex": "1", "minHeight": "0", "overflow": "auto", "padding": "6px 24px 14px", "display": "flex", "flexDirection": "column", "gap": "14px" }}>
          {chat.messages.map((m, mIndex) => <Fragment key={m.id}>
            {m.isAi && <>
              <div data-msg={"ai"} data-enter-msg={"1"} style={{ "flex": "0 0 auto", "maxWidth": "560px", "display": "grid", "gap": "6px" }}>
                <div style={{ "fontSize": "11px", "letterSpacing": "1.2px", "color": "var(--argo-faint)", "fontWeight": "600", "display": "flex", "alignItems": "center", "gap": "6px" }}>
                  <svg width={"12"} height={"12"} viewBox={"0 0 24 24"} fill={"none"} stroke={"#B3B8EA"} strokeWidth={"2"} strokeLinecap={"round"} strokeLinejoin={"round"}>
                    <path d={"m12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8Z"}>
                    </path>
                  </svg>
                  {"ARGOAI"}
                </div>
                <div style={{ "fontSize": "14px", "lineHeight": "1.75", "color": "#1F2A44", "whiteSpace": "pre-line" }}>
                  <span data-msg-text={m.id}><StreamingText id={m.id} text={m.text} stream={m.stream} reduced={events.reduced} active={events.active} onDone={events.onStreamDone} /></span>
                  <span data-caret={m.id} style={{ "display": "none", "width": "2px", "height": "16px", "background": "var(--argo-ink)", "verticalAlign": "-3px", "marginLeft": "2px", "borderRadius": "1px", "animation": "argoPulse .9s ease-in-out infinite" }}>
                  </span>
                </div>
              </div>
            </>}
            {m.isUser && <>
              <div data-enter-msg={"1"} style={{ "flex": "0 0 auto", "display": "flex", "flexDirection": "column", "alignItems": "flex-end", "gap": "8px" }}>
                {m.fromVoice && <>
                  <span style={{ "fontSize": "11px", "color": "var(--argo-faint)", "display": "flex", "alignItems": "center", "gap": "4px" }}>
                    <svg width={"11"} height={"11"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"2"} strokeLinecap={"round"}>
                      <rect x={"9"} y={"2"} width={"6"} height={"12"} rx={"3"}>
                      </rect>
                      <path d={"M5 10v2a7 7 0 0 0 14 0v-2"}>
                      </path>
                    </svg>
                    {view.t("来自语音转写 · 已核对")}
                  </span>
                </>}
                <div data-msg-id={m.id} style={{ "maxWidth": "82%", "background": "var(--argo-ink)", "color": "#fff", "padding": "11px 15px", "borderRadius": "18px 18px 6px 18px", "fontSize": "14px", "lineHeight": "1.7", "boxShadow": "0 8px 20px -12px rgba(10,17,40,.6)" }}>
                  {m.segments.map((seg, segIndex) => <Fragment key={segIndex}>
                    <span data-seg={seg.kind} data-seg-id={seg.id} data-seg-field={seg.field} style={{ "borderRadius": "6px", "padding": "0 1px", "transition": "opacity .4s" }}>
                      {seg.text}
                    </span>
                  </Fragment>)}
                </div>
                {m.showExtract && <>
                  <div data-extract-list={m.id} style={{ "display": "grid", "gap": "6px", "maxWidth": "82%", "padding": "4px 2px" }}>
                    {m.hits.map((h, hIndex) => <Fragment key={hIndex}>
                      <div data-extract-item={h.field} style={{ "display": "flex", "alignItems": "center", "gap": "8px", "fontSize": "13px", "color": "var(--argo-ink)", "opacity": "0" }}>
                        <span style={{ "width": "6px", "height": "6px", "borderRadius": "50%", "background": "var(--argo-peri)", "flex": "0 0 auto" }}>
                        </span>
                        <span style={{ "color": "var(--argo-muted)" }}>
                          {h.label}
                        </span>
                        <b data-extract-pill={h.field} style={{ "fontWeight": "600", "background": "#EEF1FB", "padding": "2px 8px", "borderRadius": "8px" }}>
                          {h.value}
                        </b>
                      </div>
                    </Fragment>)}
                  </div>
                </>}
              </div>
            </>}
            {m.isCard && <>
              <div data-cand-card={m.id} data-enter-msg={"1"} style={{ "flex": "0 0 auto", "maxWidth": "560px", "border": "1px solid var(--argo-line)", "borderRadius": "20px", "background": "#fff", "boxShadow": "0 1px 2px rgba(10,17,40,.04),0 14px 34px -20px rgba(10,17,40,.25)", "overflow": "hidden" }}>
                <div style={{ "display": "flex", "alignItems": "center", "justifyContent": "space-between", "gap": "10px", "padding": "14px 16px 10px", "borderBottom": "1px solid #EEF2F7" }}>
                  <div>
                    <div style={{ "fontSize": "11px", "letterSpacing": "2px", "color": "var(--argo-faint)", "fontWeight": "600" }}>
                      {m.card.eyebrow}
                    </div>
                    <div style={{ "fontSize": "15px", "fontWeight": "600", "marginTop": "2px" }}>
                      {m.card.title}
                    </div>
                  </div>
                  <span style={{ "fontSize": "11px", "fontWeight": "600", "padding": "4px 9px", "borderRadius": "999px", "background": m.card.badgeBg, "color": m.card.badgeColor, "whiteSpace": "nowrap" }}>
                    {m.card.badge}
                  </span>
                </div>
                <div style={{ "display": "grid", "gap": "2px", "padding": "6px 8px" }}>
                  {m.card.fields.map((f, fIndex) => <Fragment key={f.key}>
                    <div data-cand-row={f.key} style={{ "display": "grid", "gridTemplateColumns": "118px 1fr auto", "alignItems": "center", "gap": "10px", "padding": "8px 8px", "borderRadius": "12px" }} className="argo-interaction-7b62346d">
                      <span style={{ "fontSize": "13px", "color": "var(--argo-muted)" }}>
                        {f.label}
                      </span>
                      {f.isInput && <>
                        <input data-cand-input={f.key} data-cand-msg={m.id} value={f.value} placeholder={f.placeholder} aria-label={f.label} readOnly={m.card.readOnly || m.card.busy} style={{ "minWidth": "0", "height": "34px", "border": "1px solid transparent", "borderRadius": "9px", "padding": "0 8px", "fontSize": "14px", "color": "var(--argo-ink)", "background": "transparent", "transition": "border-color .2s,background .2s" }} style-focus={"border-color:#A8C0DC;background:#fff;box-shadow:0 0 0 3px rgba(168,192,220,.35)"} className="argo-interaction-763aef4b" onChange={events.onInput} />
                      </>}
                      {f.isSelect && <>
                        <select data-cand-input={f.key} data-cand-msg={m.id} value={f.value} aria-label={f.label} disabled={m.card.readOnly || m.card.busy} style={{ "minWidth": "0", "height": "34px", "border": "1px solid #DCE4EE", "borderRadius": "9px", "padding": "0 8px", "fontSize": "14px", "color": "var(--argo-ink)", "background": "#fff" }} onChange={events.onChange}>
                          {f.options.map((o, oIndex) => <Fragment key={oIndex}>
                            <option value={o.v}>
                              {o.t}
                            </option>
                          </Fragment>)}
                        </select>
                      </>}
                      <span data-field-src={f.key} style={{ "fontSize": "11px", "padding": "3px 8px", "borderRadius": "999px", "background": f.srcBg, "color": f.srcColor, "whiteSpace": "nowrap" }}>
                        {f.source}
                      </span>
                    </div>
                  </Fragment>)}
                </div>
                {m.card.editable && <>
                  <div data-cand-actions={"1"} style={{ "display": "flex", "gap": "8px", "alignItems": "center", "padding": "8px 16px 16px" }}>
                    <button data-act={"cand-confirm"} data-arg={m.id} disabled={m.card.busy} style={{ "flex": "1", "height": "44px", "borderRadius": "13px", "border": "0", "background": "linear-gradient(180deg,#1B2542,var(--argo-ink))", "color": "#fff", "fontWeight": "600", "fontSize": "14px", "display": "flex", "alignItems": "center", "justifyContent": "center", "gap": "8px", "boxShadow": "inset 0 1px 0 rgba(255,255,255,.16),0 1px 2px rgba(10,17,40,.3)", "transition": "transform .16s cubic-bezier(.32,.72,0,1)" }} className="argo-interaction-afb2bbd2">
                      {m.card.confirmLabel}
                    </button>
                    <button data-act={"cand-later"} data-arg={m.id} style={{ "height": "44px", "padding": "0 14px", "borderRadius": "13px", "border": "0", "background": "transparent", "color": "#4F5B73", "fontSize": "14px" }} className="argo-interaction-4c615124">
                      {view.t("稍后再说")}
                    </button>
                  </div>
                  <div style={{ "padding": "0 16px 14px", "fontSize": "12px", "color": "var(--argo-faint)", "lineHeight": "1.6" }}>
                    {m.card.note}
                  </div>
                </>}
                {m.card.notice && <>
                  <div style={{ "margin": "0 16px 16px", "padding": "12px 14px", "borderRadius": "12px", "background": m.card.noticeBg, "color": "var(--argo-ink)", "fontSize": "13px", "lineHeight": "1.6", "display": "grid", "gap": "10px" }}>
                    <span style={{ "whiteSpace": "pre-line" }}>
                      {m.card.noticeText}
                    </span>
                    <div style={{ "display": "flex", "gap": "8px", "flexWrap": "wrap" }}>
                      {m.card.noticeActions.map((na, naIndex) => <Fragment key={naIndex}>
                        <button data-act={na.act} data-arg={m.id} style={{ "height": "34px", "padding": "0 12px", "borderRadius": "10px", "border": "1px solid #DCE4EE", "background": "#fff", "fontSize": "13px", "fontWeight": "600" }}>
                          {na.label}
                        </button>
                      </Fragment>)}
                    </div>
                  </div>
                </>}
              </div>
            </>}
            {m.isUpload && <>
              <div data-enter-msg={"1"} data-upload={"1"} style={{ "maxWidth": "520px", "border": "1px dashed #C9D6E6", "borderRadius": "20px", "background": "linear-gradient(180deg,#FBFDFF,#F3F7FC)", "padding": "20px", "display": "grid", "gap": "14px", "justifyItems": "center", "textAlign": "center" }}>
                <div style={{ "position": "relative", "width": "64px", "height": "76px", "borderRadius": "12px", "background": "#fff", "boxShadow": "0 1px 2px rgba(10,17,40,.08),0 10px 24px -14px rgba(10,17,40,.35)", "display": "flex", "alignItems": "center", "justifyContent": "center", "overflow": "hidden" }}>
                  <svg width={"26"} height={"26"} viewBox={"0 0 24 24"} fill={"none"} stroke={"#0A1128"} strokeWidth={"1.6"} strokeLinecap={"round"} strokeLinejoin={"round"}>
                    <path d={"M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"}>
                    </path>
                  </svg>
                  {m.upload.scanning && <>
                    <span data-motion={"1"} style={{ "position": "absolute", "inset": "0", "background": "linear-gradient(180deg,rgba(168,192,220,0) 30%,rgba(168,192,220,.35) 50%,rgba(168,192,220,0) 70%)", "backgroundSize": "100% 300%", "animation": "argoShimmer 1.6s linear infinite" }}>
                    </span>
                  </>}
                </div>
                <div>
                  <b style={{ "fontSize": "14px", "fontWeight": "600" }}>
                    {m.upload.title}
                  </b>
                  <p style={{ "margin": "6px 0 0", "fontSize": "13px", "color": "var(--argo-muted)", "lineHeight": "1.6", "whiteSpace": "pre-line" }}>
                    {m.upload.text}
                  </p>
                </div>
                {m.upload.showSteps && <>
                  <div style={{ "display": "grid", "gap": "8px", "width": "100%", "maxWidth": "320px", "textAlign": "left" }}>
                    {m.upload.steps.map((st, stIndex) => <Fragment key={stIndex}>
                      <div style={{ "display": "flex", "alignItems": "center", "gap": "10px", "fontSize": "13px", "color": st.color, "transition": "color .3s" }}>
                        <span style={{ "width": "20px", "height": "20px", "borderRadius": "50%", "display": "flex", "alignItems": "center", "justifyContent": "center", "fontSize": "11px", "fontWeight": "600", "background": st.bg, "color": st.fg, "flex": "0 0 auto", "transition": "background .3s" }}>
                          {st.mark}
                        </span>
                        <span style={{ "flex": "1" }}>
                          {st.label}
                        </span>
                        <span style={{ "fontSize": "11px", "color": "var(--argo-faint)" }}>
                          {st.right}
                        </span>
                      </div>
                    </Fragment>)}
                    <div style={{ "height": "4px", "borderRadius": "2px", "background": "#E9EEF5", "overflow": "hidden" }}>
                      <span data-motion={"1"} style={{ "display": "block", "height": "100%", "width": "100%", "borderRadius": "2px", "background": "linear-gradient(90deg,#E9EEF5,var(--argo-steel),var(--argo-peri),#E9EEF5)", "backgroundSize": "300% 100%", "animation": "argoShimmer 1.6s linear infinite" }}>
                      </span>
                    </div>
                  </div>
                </>}
                {m.upload.slow && <>
                  <div style={{ "fontSize": "12px", "color": "#8A5A2B", "background": "var(--argo-peach)", "padding": "8px 12px", "borderRadius": "10px" }}>
                    {view.t("比平时慢一些，仍在处理。你可以继续等待，或取消后手动填写。")}
                  </div>
                </>}
                <div style={{ "display": "flex", "gap": "8px", "flexWrap": "wrap", "justifyContent": "center" }}>
                  {m.upload.actions.map((ua, uaIndex) => <Fragment key={uaIndex}>
                    <button data-act={ua.act} style={{ "height": "40px", "padding": "0 16px", "borderRadius": "12px", "border": `1px solid ${ua.border}`, "background": ua.bg, "color": ua.color, "fontWeight": "600", "fontSize": "13px", "transition": "transform .16s" }} className="argo-interaction-6cf058f9">
                      {ua.label}
                    </button>
                  </Fragment>)}
                </div>
              </div>
            </>}
            {m.isNotice && <>
              <div data-enter-msg={"1"} style={{ "flex": "0 0 auto", "maxWidth": "520px", "padding": "12px 14px", "borderRadius": "14px", "background": m.noticeBg, "fontSize": "13px", "lineHeight": "1.65", "color": "var(--argo-ink)", "display": "grid", "gap": "10px" }}>
                <span style={{ "whiteSpace": "pre-line" }}>
                  {m.text}
                </span>
                {m.hasActions && <>
                  <div style={{ "display": "flex", "gap": "8px", "flexWrap": "wrap" }}>
                    {m.actions.map((na, naIndex) => <Fragment key={naIndex}>
                      <button data-act={na.act} data-arg={na.arg} style={{ "height": "34px", "padding": "0 12px", "borderRadius": "10px", "border": "1px solid #DCE4EE", "background": "#fff", "fontSize": "13px", "fontWeight": "600" }}>
                        {na.label}
                      </button>
                    </Fragment>)}
                  </div>
                </>}
              </div>
            </>}
          </Fragment>)}
          {chat.thinking && <>
            <div data-thinking={"1"} style={{ "flex": "0 0 auto", "display": "flex", "alignItems": "center", "gap": "8px", "fontSize": "12px", "color": "var(--argo-faint)", "padding": "2px 0" }}>
              <span style={{ "display": "inline-flex", "gap": "3px" }}>
                <i data-motion={"1"} style={{ "width": "5px", "height": "5px", "borderRadius": "50%", "background": "var(--argo-peri)", "animation": "argoDots 1.1s ease-in-out infinite" }}>
                </i>
                <i data-motion={"1"} style={{ "width": "5px", "height": "5px", "borderRadius": "50%", "background": "var(--argo-peri)", "animation": "argoDots 1.1s ease-in-out .15s infinite" }}>
                </i>
                <i data-motion={"1"} style={{ "width": "5px", "height": "5px", "borderRadius": "50%", "background": "var(--argo-peri)", "animation": "argoDots 1.1s ease-in-out .3s infinite" }}>
                </i>
              </span>
              {chat.thinkingLabel}
            </div>
          </>}
          {chat.showPrivacyActions && <>
            <div data-enter-msg={"1"} style={{ "flex": "0 0 auto", "display": "flex", "gap": "8px", "flexWrap": "wrap", "maxWidth": "560px" }}>
              <button data-act={"privacy-skip"} style={{ "height": "40px", "padding": "0 14px", "borderRadius": "12px", "border": "1px solid #DCE4EE", "background": "#fff", "fontSize": "13px", "fontWeight": "600" }} className="argo-interaction-7b62346d">
                {view.t("跳过这一组")}
              </button>
              <button data-act={"privacy-decline"} style={{ "height": "40px", "padding": "0 14px", "borderRadius": "12px", "border": "1px solid #DCE4EE", "background": "#fff", "fontSize": "13px", "fontWeight": "600" }} className="argo-interaction-7b62346d">
                {view.t("全部选择「不愿回答」")}
              </button>
              <button data-act={"privacy-provide"} style={{ "height": "40px", "padding": "0 14px", "borderRadius": "12px", "border": "0", "background": "transparent", "fontSize": "13px", "color": "#4F5B73" }} className="argo-interaction-4c615124">
                {view.t("我来逐项选择")}
              </button>
            </div>
          </>}
          {chat.showMorePrompt && <>
            <div data-enter-msg={"1"} style={{ "flex": "0 0 auto", "display": "flex", "gap": "8px", "flexWrap": "wrap", "alignItems": "center", "maxWidth": "560px" }}>
              <button data-act={"target-done"} style={{ "height": "40px", "padding": "0 14px", "borderRadius": "12px", "border": "0", "background": "var(--argo-ink)", "color": "#fff", "fontSize": "13px", "fontWeight": "600" }}>
                {view.t("不用了，继续下一步")}
              </button>
              <span style={{ "fontSize": "12px", "color": "var(--argo-faint)" }}>
                {view.t("或者直接在下面说出另一个目标岗位，我再整理一组。")}
              </span>
            </div>
          </>}
          {chat.showReviewCta && <>
            <div data-enter-msg={"1"} style={{ "flex": "0 0 auto", "maxWidth": "560px" }}>
              <button data-act={"open-review"} style={{ "height": "46px", "padding": "0 18px", "borderRadius": "14px", "border": "0", "background": "linear-gradient(180deg,#1B2542,var(--argo-ink))", "color": "#fff", "fontWeight": "600", "fontSize": "14px", "display": "flex", "alignItems": "center", "gap": "8px", "boxShadow": "inset 0 1px 0 rgba(255,255,255,.16),0 1px 2px rgba(10,17,40,.3)", "transition": "transform .16s cubic-bezier(.32,.72,0,1)" }} className="argo-interaction-afb2bbd2">
                {view.t("查看完整资料")}
                <svg width={"16"} height={"16"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"2"} strokeLinecap={"round"} strokeLinejoin={"round"}>
                  <path d={"M5 12h14m-6-6 6 6-6 6"}>
                  </path>
                </svg>
              </button>
            </div>
          </>}
        </div>
        {chat.showComposer && <>
          <div data-composer={"1"} style={{ "flex": "0 0 auto", "padding": "0 20px 16px" }}>
            {voice.notice && <>
              <div data-enter-msg={"1"} style={{ "flex": "0 0 auto", "display": "flex", "alignItems": "center", "gap": "10px", "marginBottom": "8px", "padding": "10px 12px", "borderRadius": "12px", "background": "var(--argo-peach)", "fontSize": "12px", "color": "var(--argo-ink)", "lineHeight": "1.5" }}>
                <span style={{ "flex": "1" }}>
                  {voice.noticeText}
                </span>
                <button data-act={"voice-dismiss"} style={{ "height": "30px", "padding": "0 10px", "borderRadius": "9px", "border": "1px solid #F1D9C2", "background": "#fff", "fontSize": "12px", "fontWeight": "600" }}>
                  {view.t("改用文字")}
                </button>
              </div>
            </>}
            <div style={{ "border": `1px solid ${voice.borderColor}`, "borderRadius": "18px", "background": "#fff", "boxShadow": "0 1px 2px rgba(10,17,40,.04),0 10px 24px -18px rgba(10,17,40,.25)", "transition": "border-color .3s,box-shadow .3s", "overflow": "hidden" }}>
              {voice.recording && <>
                <div data-recording={"1"} style={{ "display": "flex", "alignItems": "center", "gap": "14px", "padding": "14px 16px", "minHeight": "96px" }}>
                  <span style={{ "position": "relative", "width": "40px", "height": "40px", "flex": "0 0 auto" }}>
                    <span data-motion={"1"} style={{ "position": "absolute", "inset": "0", "borderRadius": "50%", "background": "rgba(255,122,107,.35)", "animation": "argoRing 1.6s ease-out infinite" }}>
                    </span>
                    <span style={{ "position": "absolute", "inset": "0", "borderRadius": "50%", "background": "var(--argo-coral)", "display": "flex", "alignItems": "center", "justifyContent": "center", "color": "#fff" }}>
                      <svg width={"16"} height={"16"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"2"} strokeLinecap={"round"}>
                        <rect x={"9"} y={"2"} width={"6"} height={"12"} rx={"3"}>
                        </rect>
                        <path d={"M5 10v2a7 7 0 0 0 14 0v-2M12 19v3"}>
                        </path>
                      </svg>
                    </span>
                  </span>
                  <div style={{ "flex": "1", "minWidth": "0" }}>
                    <div style={{ "display": "flex", "alignItems": "flex-end", "gap": "3px", "height": "28px" }}>
                      {voice.bars.map((b, bIndex) => <Fragment key={bIndex}>
                        <i data-motion={"1"} style={{ "width": "3px", "height": "100%", "borderRadius": "2px", "background": "var(--argo-ink)", "transformOrigin": "bottom", "animation": `argoWave ${b.dur}s ease-in-out ${b.delay}s infinite`, "opacity": ".85" }}>
                        </i>
                      </Fragment>)}
                    </div>
                    <div style={{ "fontSize": "12px", "color": "var(--argo-muted)", "marginTop": "6px" }}>
                      {view.t("正在听 · ")}{voice.timer}{view.t(" · 说完点「结束」")}
                    </div>
                  </div>
                  <button data-act={"voice-cancel"} style={{ "height": "36px", "padding": "0 12px", "borderRadius": "11px", "border": "1px solid #DCE4EE", "background": "#fff", "fontSize": "13px" }}>
                    {view.t("取消")}
                  </button>
                  <button data-act={"voice-stop"} style={{ "height": "36px", "padding": "0 14px", "borderRadius": "11px", "border": "0", "background": "var(--argo-ink)", "color": "#fff", "fontSize": "13px", "fontWeight": "600" }}>
                    {view.t("结束")}
                  </button>
                </div>
              </>}
              {voice.processing && <>
                <div style={{ "display": "flex", "alignItems": "center", "gap": "12px", "padding": "14px 16px", "minHeight": "96px", "fontSize": "13px", "color": "#4F5B73" }}>
                  <span data-motion={"1"} style={{ "width": "16px", "height": "16px", "borderRadius": "50%", "border": "2px solid #DCE4EE", "borderTopColor": "var(--argo-ink)", "animation": "argoSpin .9s linear infinite" }}>
                  </span>
                  {view.t("正在转写你的语音… ")}
                  <button data-act={"voice-cancel"} style={{ "marginLeft": "auto", "height": "34px", "padding": "0 12px", "borderRadius": "10px", "border": "1px solid #DCE4EE", "background": "#fff", "fontSize": "13px" }}>
                    {view.t("取消")}
                  </button>
                </div>
              </>}
              {voice.idleOrTranscript && <>
                {voice.transcript && <>
                  <div style={{ "display": "flex", "alignItems": "center", "gap": "8px", "padding": "10px 14px 0", "fontSize": "12px", "color": "var(--argo-muted)" }}>
                    <span style={{ "width": "6px", "height": "6px", "borderRadius": "50%", "background": "var(--argo-green)" }}>
                    </span>
                    {view.t("转写结果 · 请核对，可直接修改后发送")}
                  </div>
                </>}
                <textarea data-chat-input={"1"} rows={2} value={chat.input} placeholder={chat.placeholder} aria-label={view.t("告诉 ArgoLand.AI 你的资料")} style={{ "width": "100%", "border": "0", "resize": "none", "padding": "14px 16px 6px", "fontSize": "14px", "lineHeight": "1.6", "background": "transparent", "outline": "none", "minHeight": "56px", "maxHeight": "140px", "display": "block" }} onChange={events.onInput}>
                </textarea>
                <div style={{ "display": "flex", "alignItems": "center", "gap": "8px", "padding": "6px 10px 10px" }}>
                  <button data-act={"voice-start"} aria-label={view.t("语音输入")} style={{ "height": "36px", "padding": "0 12px 0 10px", "borderRadius": "11px", "border": "1px solid var(--argo-line)", "background": "#fff", "display": "flex", "alignItems": "center", "gap": "6px", "fontSize": "13px", "color": "var(--argo-ink-2)", "transition": "background .2s" }} className="argo-interaction-d0fd638f">
                    <svg width={"15"} height={"15"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"2"} strokeLinecap={"round"}>
                      <rect x={"9"} y={"2"} width={"6"} height={"12"} rx={"3"}>
                      </rect>
                      <path d={"M5 10v2a7 7 0 0 0 14 0v-2M12 19v3"}>
                      </path>
                    </svg>
                    {view.t("说给我听")}
                  </button>
                  <span style={{ "flex": "1", "fontSize": "11px", "color": "#98A2B5", "textAlign": "right" }}>
                    {chat.quotaHint}
                  </span>
                  <button data-act={"chat-send"} aria-label={view.t("发送")} disabled={chat.sendDisabled} style={{ "width": "38px", "height": "38px", "borderRadius": "12px", "border": "0", "background": "var(--argo-ink)", "color": "#fff", "display": "flex", "alignItems": "center", "justifyContent": "center", "boxShadow": "0 6px 14px -8px rgba(10,17,40,.6)", "transition": "transform .16s cubic-bezier(.32,.72,0,1),opacity .2s" }} className="argo-interaction-a3abad25">
                    <svg width={"16"} height={"16"} viewBox={"0 0 24 24"} fill={"none"} stroke={"currentColor"} strokeWidth={"2.2"} strokeLinecap={"round"} strokeLinejoin={"round"}>
                      <path d={"M12 20V4m-6 6 6-6 6 6"}>
                      </path>
                    </svg>
                  </button>
                </div>
              </>}
            </div>
            <div style={{ "fontSize": "11px", "color": "#98A2B5", "marginTop": "8px", "textAlign": "center" }}>
              {view.t("原型仅演示对话、转写与整理；不调用模型、不录音、不上传文件。")}
            </div>
          </div>
        </>}
      </div>
    </div>
  </>;
}
