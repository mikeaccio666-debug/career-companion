import { useEffect, useState } from 'react';
import type { PublicLegalDocuments } from '@companion/platform-contracts';
import { readPublicLegalDocuments } from './legal-api';
import type { PublicLegalPage } from './student-entry-state';
import { Brand } from './ui';

export function LegalDocumentContent({ page, documents, loading = false, error = '' }: { page: PublicLegalPage; documents: PublicLegalDocuments | null; loading?: boolean; error?: string }) {
  const title = page === 'terms' ? '用户协议' : '隐私政策';
  return <div className="auth-page legal-page"><header className="auth-top"><Brand /></header><main className="legal-document"><nav aria-label="协议页面"><a href="/">返回账号入口</a><a href={page === 'terms' ? '/privacy' : '/terms'}>{page === 'terms' ? '隐私政策' : '用户协议'}</a></nav><h1>{documents?.status === 'available' ? documents[page].title : title}</h1>{loading ? <p role="status">正在读取{title}…</p> : error ? <p role="alert">{error}</p> : documents?.status === 'available' ? <><p className="legal-version">版本：{documents.version}</p><div className="legal-body">{documents[page].body}</div></> : <p role="status">{title}尚未开放，暂时无法确认协议。请稍后再试。</p>}</main></div>;
}
export default function LegalDocumentPage({ page }: { page: PublicLegalPage }) {
  const [documents, setDocuments] = useState<PublicLegalDocuments | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); let live = true;
    void readPublicLegalDocuments(controller.signal).then((value) => { if (live && !controller.signal.aborted) setDocuments(value); }).catch(() => { if (live && !controller.signal.aborted) setError('暂时无法读取协议页面，请检查连接后重试。'); }).finally(() => { if (live && !controller.signal.aborted) setLoading(false); });
    return () => { live = false; controller.abort(); };
  }, []);
  return <LegalDocumentContent page={page} documents={documents} loading={loading} error={error} />;
}
