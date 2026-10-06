import { Fragment } from 'react';
import type { SceneProps } from '../app/view-types';

/** Layout ported from the accepted Fable design; behavior is supplied by the controller. */
export function ShellHeader({ view, events }: SceneProps) {
  const { ui } = view;
  return <>
    <div style={{ "flex": "0 0 auto", "display": "flex", "alignItems": "center", "gap": "14px", "padding": "32px 64px 0 20px", "height": "96px" }}>
      <div style={{ "width": "48px", "height": "48px", "flex": "0 0 auto", "borderRadius": "14px", "background": "var(--argo-ice)" }}>
      </div>
      <div style={{ "minWidth": "0" }}>
        <div style={{ "fontWeight": "600", "fontSize": "15px", "letterSpacing": "-.1px" }}>
          {"ArgoLand.AI"}
        </div>
        <div style={{ "fontSize": "12px", "color": "var(--argo-muted)", "display": "flex", "alignItems": "center", "gap": "6px", "marginTop": "2px" }}>
          <span style={{ "width": "6px", "height": "6px", "borderRadius": "50%", "background": ui.statusDot }}>
          </span>
          <span style={{ "overflow": "hidden", "textOverflow": "ellipsis", "whiteSpace": "nowrap" }}>
            {ui.statusLine}
          </span>
        </div>
      </div>
      <div style={{ "marginLeft": "auto", "fontSize": "12px", "color": "var(--argo-faint)", "whiteSpace": "nowrap" }}>
        {ui.headerRight}
      </div>
    </div>
  </>;
}
