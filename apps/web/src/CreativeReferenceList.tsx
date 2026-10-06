import { ArrowDown, ArrowUp, X } from 'lucide-react';
import type { CreativeReference } from './creative-plan';
import PrivateImage from './PrivateImage';

export default function CreativeReferenceList({ references, disabled = false, onMove, onRemove, firstLast = false }: {
  references: CreativeReference[]; disabled?: boolean; onMove?: (index: number, direction: -1 | 1) => void;
  onRemove?: (id: string) => void; firstLast?: boolean;
}) {
  if (!references.length) return null;
  return <ol className="creative-reference-list" aria-label="参考图片及顺序">{references.map((reference, index) => {
    const image = reference.attachment;
    return <li key={image.id}>
      <PrivateImage url={image.url} alt={`参考图片 ${index + 1}：${image.name}`} />
      <div className="creative-reference-info"><strong>{firstLast ? index === 0 ? '首帧' : '尾帧' : `第 ${index + 1} 张`}</strong><span>{image.name}</span><small>{reference.source.kind === 'artifact' ? '来自已保存的作品' : '来自本次上传'} · {(image.size / 1024 / 1024).toFixed(2)} MiB</small>{reference.source.kind === 'artifact' && reference.source.jobPrompt && <small>来源任务：{reference.source.jobPrompt}</small>}</div>
      {(onMove || onRemove) && <div className="creative-reference-actions">
        {onMove && <><button type="button" className="icon-button" aria-label={`上移参考图片 ${index + 1}`} disabled={disabled || index === 0} onClick={() => onMove(index, -1)}><ArrowUp size={15} /></button><button type="button" className="icon-button" aria-label={`下移参考图片 ${index + 1}`} disabled={disabled || index === references.length - 1} onClick={() => onMove(index, 1)}><ArrowDown size={15} /></button></>}
        {onRemove && <button type="button" className="icon-button" aria-label={`移除参考图片 ${index + 1} ${image.name}`} disabled={disabled} onClick={() => onRemove(image.id)}><X size={15} /></button>}
      </div>}
    </li>;
  })}</ol>;
}
