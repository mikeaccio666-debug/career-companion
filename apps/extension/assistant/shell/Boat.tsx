import { useEffect, useRef, useState } from 'react';
import type { BoatSceneHandle } from '../assets/boat/boat-scene';
import type { BoatRect } from './geometry';

/** One persistent scene survives welcome → header. Hide and unmount release GPU work. */
export function Boat({ rect, compact, reduced, open }: { rect: BoatRect; compact: boolean; reduced: boolean; open: boolean }) {
  const node = useRef<HTMLDivElement>(null), handle = useRef<BoatSceneHandle | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  useEffect(() => {
    let active = true;
    void import('../assets/boat/boat-scene.js').then(module => {
      if (!active || !node.current) return;
      try { handle.current = module.mountBoatScene(node.current, { reducedMotion: reduced, compact }); setStatus('ready'); }
      catch { setStatus('unavailable'); }
    }).catch(() => { if (active) setStatus('unavailable'); });
    return () => { active = false; handle.current?.destroy(); handle.current = null; };
  }, [reduced]);
  useEffect(() => { handle.current?.setCompact(compact); }, [compact, status]);
  useEffect(() => {
    const sync = () => { if (open && !document.hidden) handle.current?.resume(); else handle.current?.pause(); };
    sync(); document.addEventListener('visibilitychange', sync); return () => document.removeEventListener('visibilitychange', sync);
  }, [open, status]);
  return <div data-boat-host="1" aria-hidden="true" style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: 16, pointerEvents: 'none', transformOrigin: '0 0', borderRadius: compact ? 14 : 0, background: compact ? '#EEF4FA' : 'transparent' }}>
    <div ref={node} style={{ width: '100%', height: '100%' }} />
    {status !== 'ready' && <svg style={{ position: 'absolute', inset: 0 }} width="100%" height="100%" viewBox="0 0 100 80"><path d="M46 8V50H17Z" fill="white" stroke="#A8C0DC"/><path d="M52 16 82 50H52Z" fill="#EEF4FA" stroke="#A8C0DC"/><path d="M12 57h76L75 72H27Z" fill="white" stroke="#0A1128" strokeWidth="2"/></svg>}
  </div>;
}
