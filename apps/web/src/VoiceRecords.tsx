import { AudioLines, ArrowRight } from 'lucide-react';
import type { PublicVoiceRecord } from '@companion/platform-contracts';
import { ArtifactView, Badge } from './ui';
import { quotedVoiceText, voiceSourceLabel } from './voice-history';
import { usePlatformAccountClient } from './account-client';
import type { VoicePlaybackController } from './voice-playback';
export default function VoiceRecords({ records, onBringToChat, readOnly = false, compact = false, voicePlayback }: { records: PublicVoiceRecord[]; readOnly?: boolean; onBringToChat: (text: string) => void; compact?: boolean; voicePlayback?: VoicePlaybackController }) {
  const client = usePlatformAccountClient();
  const bringToChat = (content: string) => { if (client?.isCurrent()) onBringToChat(content); };
  if (!client?.isCurrent() || !records.length) return null;
  return <section className={`saved-voice-records ${compact ? 'compact' : ''}`} aria-label="已保存的语音摘录"><div className="section-title"><h3><AudioLines size={16} />已保存的语音摘录</h3><span>{records.length}</span></div><p className="voice-provenance">这些是你明确保存的客户端摘录，未经服务端核验，与普通模型回复分开记录。</p><div className="voice-record-list">{records.map((record) => <article key={record.id}><div className="voice-record-heading"><Badge>{voiceSourceLabel(record.source)}</Badge><span>{record.role === 'user' ? '用户' : record.role === 'assistant' ? 'AI 转写' : '说话者未标注'} · {new Date(record.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div><p>{record.text}</p>{record.attachments.map((attachment) => <ArtifactView key={attachment.id} artifact={attachment} voicePlayback={voicePlayback} />)}{!readOnly && <button className="text-button" onClick={() => bringToChat(quotedVoiceText(record.source, record.text, record.role))}><ArrowRight size={13} />带回对话草稿</button>}</article>)}</div></section>;
}
