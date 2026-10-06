import { useEffect, useState } from 'react';
import { MOTION } from '../design/motion';
export function StreamingText({ id, text, stream, reduced, active, onDone }: { id: string; text: string; stream: boolean; reduced: boolean; active: boolean; onDone(id: string): void }) {
  const [count, setCount] = useState(stream ? 0 : text.length);
  useEffect(() => {
    if (!stream || !active) return;
    if (reduced) { setCount(text.length); onDone(id); return; }
    if (count >= text.length) { onDone(id); return; }
    const char = text[count], duration = /[，。！？\n.!?]/.test(char) ? MOTION.streamPause : MOTION.streamMin + ((count * 17) % (MOTION.streamMax - MOTION.streamMin));
    const timer = setTimeout(() => setCount(n => Math.min(text.length, n + 1)), duration);
    return () => clearTimeout(timer);
  }, [count, text, stream, reduced, active, id, onDone]);
  return <><span aria-hidden="true">{stream ? text.slice(0, count) : text}</span><span className="argo-sr-only" role="status">{text}</span></>;
}
