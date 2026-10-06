import { useEffect, useRef, useState } from 'react';
import { usePlatformAccountClient } from './account-client';
import { holdPrivateImage } from './private-media';

export default function PrivateImage({ url, alt, className, loading = 'lazy' }: {
  url: unknown; alt: string; className?: string; loading?: 'lazy' | 'eager';
}) {
  const client = usePlatformAccountClient();
  const src = client?.privateFileUrl(url);
  const image = useRef<HTMLImageElement | null>(null);
  const [failedSource, setFailedSource] = useState<string>();
  useEffect(() => {
    const element = image.current;
    if (element) return holdPrivateImage(client, element, src);
  }, [client, src, failedSource]);
  if (!src || failedSource === src) return <span className={`${className ?? ''} private-image-unavailable`} role="img" aria-label={client?.isCurrent() ? alt : '图片预览不可用'}>图片暂时无法读取</span>;
  return <img key={src} ref={image} className={className} crossOrigin="use-credentials" src={src} alt={alt} loading={loading} onError={() => { if (client?.isCurrent()) setFailedSource(src); }} />;
}
