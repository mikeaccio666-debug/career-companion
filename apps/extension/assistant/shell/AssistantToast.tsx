import { Fragment } from 'react';
import type { SceneProps } from '../app/view-types';

/** Layout ported from the accepted Fable design; behavior is supplied by the controller. */
export function AssistantToast({ view, events }: SceneProps) {
  const { toast } = view;
  return <>
    <div data-toast={"1"} role={"status"} style={{ "position": "absolute", "left": "50%", "bottom": "28px", "transform": "translateX(-50%)", "background": "var(--argo-ink)", "color": "#fff", "fontSize": "13px", "padding": "10px 16px", "borderRadius": "999px", "boxShadow": "0 12px 30px -12px rgba(10,17,40,.6)", "zIndex": "70", "maxWidth": "80%", "textAlign": "center" }}>
      {toast.text}
    </div>
  </>;
}
