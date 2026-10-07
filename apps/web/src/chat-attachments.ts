import type { Attachment, AudioTranscriptReference, ProviderStatus, ReviewedAudioTranscript, PublicChatAttachmentSupport, PublicReviewedAudioTranscript } from '@companion/platform-contracts';
import type { AudioReviewSnapshot } from './audio-transcriptions-controller.ts';
import { reviewedAudioTextValid } from './audio-transcriptions-controller.ts';

export interface ChatAttachmentAssessment { issues: string[]; labels: Record<string, string>; audioTranscripts: AudioTranscriptReference[]; reviewedAudio: (ReviewedAudioTranscript | PublicReviewedAudioTranscript)[]; }
export function assessChatAttachments(uploads: Attachment[], provider: ProviderStatus | PublicChatAttachmentSupport | undefined, review: AudioReviewSnapshot): ChatAttachmentAssessment {
  const result: ChatAttachmentAssessment = { issues: [], labels: {}, audioTranscripts: [], reviewedAudio: [] };
  if (!uploads.length) return result;
  const support = provider && ('directMimeTypes' in provider ? provider : provider.chatAttachments);
  if (!support) { result.issues.push('当前服务尚未声明文件输入能力。请读取最新能力或选择已声明的服务。'); for (const upload of uploads) result.labels[upload.id] = '输入能力未确认'; return result; }
  if (uploads.length > support.maxAttachments) result.issues.push(`一次最多 ${support.maxAttachments} 个附件，请移除多余文件。`);
  if (uploads.reduce((sum, item) => sum + item.size, 0) > support.maxTotalBytes) result.issues.push(`附件合计超过 ${Math.floor(support.maxTotalBytes / 1024 / 1024)} MiB，请减少附件。`);
  if (new Set(uploads.map((item) => item.id)).size !== uploads.length || uploads.some((item) => !Number.isSafeInteger(item.size) || item.size < 0)) result.issues.push('附件记录无效，请移除后重新上传。');
  let audioCount = 0;
  for (const upload of uploads) {
    const audio = upload.mime.startsWith('audio/');
    if (audio) {
      ++audioCount;
      const config = support.audioTranscripts, entry = review.entries[upload.id], receipt = entry?.receipt;
      if (!config?.mimeTypes.includes(upload.mime)) { result.labels[upload.id] = '暂不支持此音频格式'; result.issues.push(`${upload.name}：音频格式尚不支持。`); continue; }
      if (upload.size > config.maxAudioBytes) { result.labels[upload.id] = '超过音频转写大小限制'; result.issues.push(`${upload.name}：音频超过 ${Math.floor(config.maxAudioBytes / 1024 / 1024)} MiB。`); continue; }
      if (!receipt || entry.phase !== 'complete' || receipt.sourceAttachmentId !== upload.id || receipt.sourceName !== upload.name || receipt.sourceMime !== upload.mime || entry.source.size !== upload.size || ('provider' in config && 'model' in config && (!('provider' in receipt) || receipt.provider !== config.provider || receipt.model !== config.model)) || receipt.provenance !== 'untrusted_audio_transcript' || !entry.reviewed || !reviewedAudioTextValid(entry.reviewedText, config.maxReviewedCharacters)) {
        result.labels[upload.id] = entry?.phase === 'uncertain' || entry?.phase === 'recovering' ? '转写结果未确认' : receipt ? '等待你审阅正文' : '等待转写和确认';
        result.issues.push(`${upload.name}：请先完成转写，并确认要发送的正文。`); continue;
      }
      result.labels[upload.id] = entry.reviewedText === receipt.text ? '已审阅原始转写' : '已审阅你的编辑';
      result.audioTranscripts.push({ receiptId: receipt.id, reviewedText: entry.reviewedText });
      result.reviewedAudio.push({ receiptId: receipt.id, sourceAttachmentId: upload.id, sourceName: upload.name, sourceMime: upload.mime, sourceSha256: receipt.sourceSha256, ...('provider' in config && 'provider' in receipt ? { provider: receipt.provider, model: receipt.model } : {}), text: entry.reviewedText, textModified: entry.reviewedText !== receipt.text, provenance: receipt.provenance });
    } else if (upload.mime.startsWith('video/')) { result.labels[upload.id] = '视频内容解析尚未接入'; result.issues.push(`${upload.name}：目前无法解析视频内容，请移除后发送。`); }
    else if (support.directMimeTypes.includes(upload.mime)) result.labels[upload.id] = upload.mime === 'application/pdf' ? '此服务可直接读取 PDF' : upload.mime.startsWith('image/') ? '此服务可直接读取图片' : '此服务可直接读取文字文件';
    else { result.labels[upload.id] = '当前服务无法读取这个格式'; result.issues.push(`${upload.name}：当前服务不支持 ${upload.mime || '此文件格式'}。`); }
  }
  if (audioCount > support.audioTranscripts.maxPerMessage) result.issues.push(`一条消息最多审阅 ${support.audioTranscripts.maxPerMessage} 份音频，请移除多余音频。`);
  return result;
}
