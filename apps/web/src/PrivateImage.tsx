import { useState } from 'react';
import { privateFileUrl } from './api';

export default function PrivateImage({ url, alt, className, loading = 'lazy' }: {
  url: unknown; alt: string; className?: string; loading?: 'lazy' | 'eager';
}) {
  const src = privateFileUrl(url);
  const [failedSource, setFailedSource] = useState<string>();
  if (!src || failedSource === src) return <span className={`${className ?? ''} private-image-unavailable`} role="img" aria-label={alt}>图片暂时无法读取</span>;
  return <img className={className} crossOrigin="use-credentials" src={src} alt={alt} loading={loading} onError={() => setFailedSource(src)} />;
}
