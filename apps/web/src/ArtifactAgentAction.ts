import { createElement } from 'react';
import { MessageCircle } from 'lucide-react';
import type { Artifact } from './types';
import { canBringTextArtifact } from './agent-handoff.ts';

export default function ArtifactAgentAction({ artifact, onBring, disabled = false, label = '带回 Agent 草稿' }: { artifact: Artifact; onBring?: (artifact: Artifact) => void; disabled?: boolean; label?: string }) {
  if (!onBring || !canBringTextArtifact(artifact)) return null;
  return createElement('div', { className: 'artifact-agent-action' },
    createElement('button', { type: 'button', className: 'text-button', 'aria-label': `将成果 ${artifact.name} ${label}`, disabled, onClick: () => onBring(artifact) }, createElement(MessageCircle, { size: 14, 'aria-hidden': true }), label),
    createElement('small', null, '追加成果引用，保留已有草稿和附件；发送后 Agent 才读取正文。'));
}
