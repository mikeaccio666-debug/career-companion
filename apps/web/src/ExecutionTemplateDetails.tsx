import type { ExecutionTemplateBinding } from '@companion/platform-contracts';
import './execution-template.css';

export default function ExecutionTemplateDetails({ binding, label = '生成模板', fixed = true }: { binding?: ExecutionTemplateBinding; label?: string; fixed?: boolean }) {
  return <div className="execution-template-details"><strong>{label}</strong>{binding ? <><span>{fixed ? '已固定版本' : '当前版本'} · {binding.hash.slice(0, 12)}</span><details><summary>查看完整版本标识</summary><code>{binding.hash}</code></details></> : <span>版本尚未绑定</span>}</div>;
}
