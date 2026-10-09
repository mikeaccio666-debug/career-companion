import { MentorHumanEntry } from './mentor-human-entry';
import { useEffect, useRef, useState } from 'react';
import { holdPrivateResource, clearPrivateImage } from './private-media';
import type { BoundPlatformClient } from './api';
import type { CompanionBirthObservation } from './companion-birth-controller';
import './companion-birth-view.css';
import CompanionWelcomeView from './companion-welcome-view';

function SavedSeal({ client, assetId, name }: { client: BoundPlatformClient; assetId: string; name: string }) {
  const [version, setVersion] = useState(0);
  const image = useRef<HTMLImageElement | null>(null);
  const [state, setState] = useState<{ client: BoundPlatformClient; assetId: string; url: string | null; error: boolean } | null>(null);
  useEffect(() => {
    const request = new AbortController(); let url: string | null = null, live = true;
    setState(null);
    const dispose = holdPrivateResource(client, () => {
      live = false; request.abort(); if (image.current) clearPrivateImage(image.current);
      if (url) { URL.revokeObjectURL(url); url = null; }
    });
    void client.readCompanionSealPNG(assetId, request.signal).then(blob => {
      if (!live || request.signal.aborted || !client.isCurrent()) return;
      url = URL.createObjectURL(blob); setState({ client, assetId, url, error: false });
    }).catch(() => { if (live && !request.signal.aborted && client.isCurrent()) setState({ client, assetId, url: null, error: true }); });
    return dispose;
  }, [client, assetId, version]);
  const current = client.isCurrent() && state?.client === client && state.assetId === assetId ? state : null;
  return <div className="companion-birth-asset">
    {current?.url ? <img ref={image} src={current.url} alt={`${name}的印章`} width="64" height="64" />
      : <span className="companion-birth-asset-placeholder" aria-hidden="true" />}
    {current?.error && <><span role="status">印章暂时无法读取。</span><button type="button" className="onboarding-link" onClick={() => setVersion(v => v + 1)}>重新读取印章</button></>}
  </div>;
}

export function CompanionBirthView({ client, observation, name, sealChar, available, onConfirm, onRetry, onRefresh, supportBlocked=false }: {
  client: BoundPlatformClient; observation: CompanionBirthObservation; name?: string; sealChar?: string;
  available: boolean; supportBlocked?: boolean; onConfirm: () => void; onRetry: () => void; onRefresh: () => void;
}) {
  const active = observation.viewer?.kind === 'active' ? observation.viewer.companion : null;
  const pending = observation.submitting || observation.checking;
  if (!client.isCurrent()) return null;
  return <section className="companion-birth career-surface" aria-label={active ? '主理人已诞生' : '确认主理人诞生'}>
    {active ? <>
      <header className="companion-birth-heading"><SavedSeal client={client} assetId={active.identity.sealAssetId} name={active.identity.name} />
        <div><span className="onboarding-ai">你的主理人 · AI</span><h2>{active.identity.name}</h2></div></header>
      <p className="companion-birth-event" role="status">—— {new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(active.bornAt))} · {active.identity.name}诞生 ——</p>
      <p>你的主理人已经诞生，名字和印章都保存好了。</p>
      <a href="/me/companion" className="onboarding-link">主理人设置</a>
      <CompanionWelcomeView client={client} companionId={active.companionId} paused={supportBlocked} />
      <nav className="mentor-human-group" aria-label="真人与社区"><h2>真人与社区</h2><MentorHumanEntry/></nav>
    </> : <>
      <span className="onboarding-ai">你的主理人 · AI</span><h2>{name ? `${name}——你起的名字` : '正在确认诞生进度'}</h2>
      {sealChar && <p>印章字「{sealChar}」。准备好了，就让它从这里陪你走。</p>}
      {name && sealChar && <button type="button" className="companion-naming-primary"
        disabled={!available || pending || observation.viewer?.kind !== 'not_born' || observation.acceptance === 'unknown'} onClick={onConfirm}>
        {observation.submitting ? '正在确认诞生…' : '让它诞生'}</button>}
      {observation.acceptance === 'unknown' && name && sealChar && <button type="button" className="onboarding-link"
        disabled={!available || pending || observation.viewer?.kind !== 'not_born'} onClick={onRetry}>用原来的确认重试</button>}
    </>}
    {observation.error && <p className="onboarding-notice" role="alert">{observation.error}</p>}
    <button type="button" className="onboarding-link" disabled={pending} onClick={onRefresh}>重新读取诞生进度</button>
  </section>;
}
