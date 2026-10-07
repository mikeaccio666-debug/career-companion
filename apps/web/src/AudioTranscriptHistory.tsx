import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { PublicAudioTranscriptionReceipt, PublicReviewedAudioTranscript } from '@companion/platform-contracts';
import { usePlatformAccountClient } from './account-client.tsx';
import { createAudioTranscriptionClient } from './audio-transcriptions-api.ts';
import { errorText } from './api.ts';
import './chat-attachments.css';

function Transcript({ transcript, workbench }: { transcript: PublicReviewedAudioTranscript; workbench: boolean }) {
  const account = usePlatformAccountClient();
  const api = useMemo(() => account ? createAudioTranscriptionClient(account.request, { publicReceipt: true, allowInternalMetadata: () => workbench }) : null, [account, workbench]);
  const abort = useRef<AbortController | null>(null);
  const [original, setOriginal] = useState<PublicAudioTranscriptionReceipt | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    setOriginal(null); setLoading(false); setError('');
    const dispose = () => { abort.current?.abort(); abort.current = null; };
    const stop = account?.subscribe(() => { if (!account.isCurrent()) { dispose(); setOriginal(null); setLoading(false); setError(''); } });
    return () => { dispose(); stop?.(); };
  }, [account, transcript.receiptId, transcript.sourceSha256]);
  async function readOriginal() {
    if (!api || !account?.isCurrent() || loading) return;
    const controller = new AbortController(); abort.current?.abort(); abort.current = controller; setLoading(true); setError('');
    try {
      const receipt = await api.readReceipt({ id: transcript.sourceAttachmentId, name: transcript.sourceName, mime: transcript.sourceMime, sha256: transcript.sourceSha256, receiptId: transcript.receiptId }, controller.signal);
      if (!controller.signal.aborted && account.isCurrent() && abort.current === controller) setOriginal(receipt);
    } catch (failure) { if (!controller.signal.aborted && account.isCurrent() && abort.current === controller) setError(errorText(failure)); }
    finally { if (!controller.signal.aborted && account.isCurrent() && abort.current === controller) { setLoading(false); abort.current = null; } }
  }
  if (!account?.isCurrent()) return null;
  return <article className="audio-transcript-history" data-provenance={transcript.provenance}><strong>{transcript.sourceName} · {transcript.textModified ? '你编辑后审阅的正文' : '已审阅的原始转写'}</strong><pre>{transcript.text}</pre><small>来源：音频转写。这里显示的是你确认用于聊天的正文。</small>{transcript.textModified && (original ? <details open><summary>对照原始音频转写</summary><pre>{original.text}</pre></details> : <button type="button" className="text-button" disabled={loading} onClick={() => void readOriginal()}>{loading ? <><Loader2 size={13} className="spin" />正在读取原始转写…</> : '读取原始转写作对照'}</button>)}{error && <p className="chat-input-warning" role="status">{error}</p>}</article>;
}
export default function AudioTranscriptHistory({ transcripts, workbench = false }: { transcripts?: PublicReviewedAudioTranscript[]; workbench?: boolean }) {
  return transcripts?.length ? <section className="audio-transcript-history-list" aria-label="这条消息的音频转写来源">{transcripts.map((transcript) => <Transcript workbench={workbench} key={transcript.receiptId} transcript={transcript} />)}</section> : null;
}
