import { useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { privateFileUrl } from './api';
import './media-preview.css';

export default function MediaPreview({ url, name, kind }: { url: string; name?: string; kind: 'video' | 'audio' }) {
  const media = useRef<HTMLMediaElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const label = kind === 'video' ? '视频' : '音频';
  const accessibleName = `${label}预览${name ? `：${name}` : ''}`;

  useEffect(() => {
    const element = media.current;
    if (!element) return;
    const source = privateFileUrl(url);
    setFailed(!source);
    element.crossOrigin = 'use-credentials';
    if (source) { element.src = source; element.load(); }
    else { element.pause(); element.removeAttribute('src'); element.load(); }
    return () => {
      element.pause();
      element.removeAttribute('src');
      element.load();
    };
  }, [url, kind, reload]);

  return <div className="media-preview">
    {kind === 'video'
      ? <video ref={(element) => { media.current = element; }} crossOrigin="use-credentials" controls playsInline preload="metadata" aria-label={accessibleName} onError={() => setFailed(true)}>当前浏览器无法播放这段视频，可以打开产物查看。</video>
      : <audio ref={(element) => { media.current = element; }} crossOrigin="use-credentials" controls preload="metadata" aria-label={accessibleName} onError={() => setFailed(true)}>当前浏览器无法播放这段音频，可以打开产物查看。</audio>}
    {failed && <div className="media-preview-error"><p role="status">暂时无法播放这段{label}，可以重新载入或打开产物。</p><button type="button" className="text-button" onClick={() => setReload((value) => value + 1)}><RotateCcw size={14} />重新载入{label}</button></div>}
  </div>;
}
