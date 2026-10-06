import { useEffect } from 'react';
import { AudioLines, Loader2, Paperclip, X } from 'lucide-react';
import type { Attachment, ProviderStatus } from '@companion/platform-contracts';
import type { AudioTranscriptionController, AudioReviewSnapshot } from './audio-transcriptions-controller.ts';
import { reviewedAudioTextValid } from './audio-transcriptions-controller.ts';
import type { ChatAttachmentAssessment } from './chat-attachments.ts';
import './chat-attachments.css';

interface Props { uploads: Attachment[]; provider?: ProviderStatus; controller: AudioTranscriptionController | null; snapshot: AudioReviewSnapshot; assessment: ChatAttachmentAssessment; disabled: boolean; onRemove(id: string): void; onRefresh(): void; }
export default function ChatAttachmentsPanel({ uploads, provider, controller, snapshot, assessment, disabled, onRemove, onRefresh }: Props) {
  useEffect(() => { controller?.start(); return () => controller?.stop(); }, [controller]);
  const support = provider?.chatAttachments, audioSupport = support?.audioTranscripts;
  return <section className="chat-input-attachments" aria-label="聊天文件输入与音频审阅">
    <div className="chat-input-capabilities"><span>{support ? `支持：${support.directMimeTypes.some((mime) => mime.startsWith('text/') || mime === 'application/json') ? '文字文件 · ' : ''}${support.directMimeTypes.some((mime) => mime.startsWith('image/')) ? '图片 · ' : ''}${support.directMimeTypes.includes('application/pdf') ? 'PDF · ' : ''}${audioSupport?.available ? '音频转写后审阅' : '音频转写暂不可用'}。视频解析尚未接入。` : '选择对话模型后查看支持的文件。音频会先转写，确认正文后再发送。'}</span><button type="button" className="text-button" disabled={disabled} onClick={onRefresh}>刷新支持的格式</button></div>
    {uploads.length > 0 && <div className="chat-input-files">{uploads.map((upload) => {
      const entry = snapshot.entries[upload.id], audio = upload.mime.startsWith('audio/'), busy = entry?.phase === 'transcribing' || entry?.phase === 'recovering';
      const maxCharacters = audioSupport?.maxReviewedCharacters ?? 0;
      const canTranscribe = !!audioSupport?.available && audioSupport.mimeTypes.includes(upload.mime) && upload.size <= audioSupport.maxAudioBytes;
      return <article className={`chat-input-file ${audio ? 'audio-review-file' : ''}`} key={upload.id}>
        <div className="chat-input-file-heading"><strong>{audio ? <AudioLines size={15} /> : <Paperclip size={14} />}{upload.name}</strong><button type="button" className="icon-button" aria-label={`移除 ${upload.name}`} disabled={disabled} onClick={() => onRemove(upload.id)}><X size={14} /></button></div>
        <p className="chat-input-file-status">{assessment.labels[upload.id]}</p>
        {audio && <div className="audio-review-actions">
          {!entry?.clientRequestId && <button type="button" className="secondary" disabled={disabled || !controller || !canTranscribe} onClick={() => void controller?.transcribe(upload.id, audioSupport)}>转写并审阅</button>}
          {busy && <><span role="status"><Loader2 size={14} className="spin" />{entry.phase === 'recovering' ? '正在只读查询已完成回执…' : '正在转写…'}</span><button type="button" className="text-button" disabled={disabled} onClick={() => controller?.cancel(upload.id)}>停止接收</button></>}
          {entry?.phase === 'uncertain' && <button type="button" className="secondary" disabled={disabled || !controller} onClick={() => void controller?.recover(upload.id)}>只读恢复回执</button>}
        </div>}
        {audio && !audioSupport?.available && !entry?.receipt && <p className="chat-input-note">音频转写暂不可用。已有转写结果仍可编辑和确认。</p>}
        {entry?.error && <p className="chat-input-warning" role="status">{entry.error}</p>}
        {entry?.clientRequestId && entry.phase !== 'complete' && <small className="audio-request-id">请求编号：{entry.clientRequestId}</small>}
        {entry?.receipt && entry.phase === 'complete' && <div className="audio-review-editor">
          <details open><summary>原始转写</summary><pre>{entry.receipt.text || '这份回执没有可识别文字。'}</pre></details>
          <label>审阅后发送的正文<textarea aria-label={`审阅 ${upload.name} 的转写正文`} rows={4} value={entry.reviewedText} disabled={disabled} maxLength={maxCharacters || undefined} onChange={(event) => controller?.edit(upload.id, event.target.value)} /></label>
          <p className="chat-input-note">{entry.reviewedText === entry.receipt.text ? '当前保留原始转写。' : '当前包含你的编辑，历史会明确标注。'} {entry.reviewedText.length} / {maxCharacters || '未声明'} 字。改动正文后需要重新勾选。</p>
          <label className="audio-review-check"><input type="checkbox" checked={entry.reviewed} disabled={disabled || !reviewedAudioTextValid(entry.reviewedText, maxCharacters)} onChange={(event) => controller?.review(upload.id, event.target.checked, maxCharacters)} />我已核对这份音频及上述正文，选择把此正文用于当前聊天</label>
          <p className="chat-input-note" data-provenance={entry.receipt.provenance}>转写可能有误。请核对后选择要用于聊天的文字；原音频会作为私人来源保留。</p>
        </div>}
      </article>;
    })}</div>}
    {uploads.some((upload) => upload.mime.startsWith('audio/')) && audioSupport && <p className="chat-input-note">音频限制：每份 {Math.floor(audioSupport.maxAudioBytes / 1024 / 1024)} MiB、{audioSupport.maxDurationSeconds} 秒；每条消息最多 {audioSupport.maxPerMessage} 份。已有结果在转写不可用时仍可确认。</p>}
    {assessment.issues.length > 0 && <p className="chat-input-warning" role="status">发送前需处理：{assessment.issues.join(' ')}</p>}
  </section>;
}
