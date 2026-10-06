import { Fragment } from 'react';
import type { SceneProps } from '../app/view-types';

/** Layout ported from the accepted Fable design; behavior is supplied by the controller. */
export function AssistantModal({ view, events }: SceneProps) {
  const { modal } = view;
  return <>
    <div data-modal-backdrop={"1"} style={{ "position": "absolute", "inset": "0", "background": "rgba(10,17,40,.35)", "zIndex": "80", "display": "flex", "alignItems": "center", "justifyContent": "center", "padding": "24px" }}>
      <div data-modal={"1"} role={"dialog"} aria-modal={"true"} aria-label={modal.title} style={{ "width": "360px", "maxWidth": "100%", "background": "#fff", "borderRadius": "24px", "padding": "24px", "boxShadow": "0 40px 80px -30px rgba(10,17,40,.5)" }}>
        <div style={{ "fontSize": "17px", "fontWeight": "600", "letterSpacing": "-.2px" }}>
          {modal.title}
        </div>
        <p style={{ "margin": "10px 0 0", "fontSize": "13px", "lineHeight": "1.7", "color": "#4F5B73", "whiteSpace": "pre-line" }}>
          {modal.text}
        </p>
        <div style={{ "display": "grid", "gap": "8px", "marginTop": "20px" }}>
          {modal.actions.map((a, aIndex) => <Fragment key={aIndex}>
            <button data-act={"modal-action"} data-arg={a.id} style={{ "height": "44px", "borderRadius": "14px", "border": `1px solid ${a.border}`, "background": a.bg, "color": a.color, "fontWeight": "600", "fontSize": "14px", "transition": "transform .16s cubic-bezier(.32,.72,0,1)" }} className="argo-interaction-6cf058f9">
              {a.label}
            </button>
          </Fragment>)}
        </div>
      </div>
    </div>
  </>;
}
