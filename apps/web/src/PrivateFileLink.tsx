import type { ReactNode } from 'react';
import { privateFileUrl } from './api';

/** A native navigation keeps large downloads streaming and uses the API's owner-checked response. */
export default function PrivateFileLink({ url, children, className, download = false, name }: {
  url: unknown; children: ReactNode; className?: string; download?: boolean; name?: string;
}) {
  const href = privateFileUrl(url, { download });
  if (!href) return <span className={`${className ?? ''} private-file-unavailable`} role="status">文件地址不可用</span>;
  return <a className={className} href={href} target="_blank" rel="noreferrer" download={download ? name || true : undefined}>{children}</a>;
}
