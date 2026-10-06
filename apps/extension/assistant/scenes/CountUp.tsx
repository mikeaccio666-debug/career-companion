import { useEffect, useState } from 'react';
export function CountUp({ value, reduced, active }: { value: number; reduced: boolean; active: boolean }) {
  const [display, setDisplay] = useState(value);
  useEffect(() => {
    if (reduced || !active) { setDisplay(value); return; }
    const start = performance.now(); let frame = 0;
    const step = (now: number) => { const progress = Math.min(1, (now - start) / 700); setDisplay(progress === 1 ? value : Math.round(value * (1 - (1 - progress) ** 3))); if (progress < 1) frame = requestAnimationFrame(step); };
    frame = requestAnimationFrame(step); return () => cancelAnimationFrame(frame);
  }, [value, reduced, active]);
  return <><span aria-hidden="true">{display}</span><span className="argo-sr-only">{value}</span></>;
}
