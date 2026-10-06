import { Globe2 } from 'lucide-react';
import { browserActionText, type BrowserPlan } from './browser-plan';

export default function BrowserPlanDetails({ plan, compact = false }: { plan: BrowserPlan; compact?: boolean }) {
  const url = new URL(plan.options.url);
  return <div className={`browser-plan-details ${compact ? 'compact' : ''}`}>
    <dl><div><dt><Globe2 size={13} />访问站点</dt><dd>{url.host}<span className="browser-plan-url">{plan.options.url}</span></dd></div><div><dt>任务目标</dt><dd>{plan.prompt}</dd></div></dl>
    {plan.options.actions?.length ? <ol>{plan.options.actions.map((action, index) => {
      const description = browserActionText(action);
      return <li key={index}><strong>{index + 1}. {description.title}</strong>{description.detail !== undefined && <div><small>{action.type === 'fill' ? '完整填入内容' : '选择内容'}</small><pre>{description.detail}</pre></div>}</li>;
    })}</ol> : <p className="browser-readonly-summary">只读取网页文字并截图，不点击或填写页面。</p>}
    <p className="browser-boundary-note">当前仅处理公开网页。登录、验证码、敏感字段和最终提交仍需你参与；本计划不授权这些操作。</p>
  </div>;
}
