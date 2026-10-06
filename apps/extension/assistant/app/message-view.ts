import { C } from '../design/palette';
import type { CandidateCard, ChatMessage } from '../state/types';
import type { ViewContext } from './view-context';
import { uploadView } from './profile-view';

export function emptyCandidate(): CandidateCard {
  return { phase: 0, fields: [], editable: false, readOnly: true, busy: false, targetId: null, eyebrow: '', title: '', badge: '', badgeBg: C.grey, badgeColor: C.muted, confirmLabel: '', note: '', notice: false, noticeText: '', noticeBg: C.peach, noticeActions: [] };
}

export function messageView(ctx: ViewContext, message: ChatMessage) {
  return {
    id: message.id, isAi: message.role === 'ai', isUser: message.role === 'user', isCard: message.role === 'card', isUpload: message.role === 'upload', isNotice: message.role === 'notice',
    text: 'text' in message ? message.text : '', stream: message.role === 'ai' && message.stream,
    segments: message.role === 'user' ? message.segments.map(segment => ({ id: segment.id, text: segment.text, kind: segment.key ? 'key' : 'plain', field: segment.field ?? '' })) : [],
    hits: message.role === 'user' ? message.hits.map(hit => ({ field: hit.field, label: hit.label ?? '', value: hit.value })) : [],
    showExtract: message.role === 'user' && message.showExtract, fromVoice: message.role === 'user' && message.fromVoice,
    card: message.role === 'card' ? message.card : emptyCandidate(),
    upload: uploadView(ctx, message.role === 'upload' ? message.upload : { state: 'idle' }),
    noticeBg: message.role === 'notice' ? message.bg : C.peach,
    hasActions: message.role === 'notice' && message.actions.length > 0,
    actions: message.role === 'notice' ? message.actions.map(action => ({ ...action, arg: '' })) : [],
  };
}
