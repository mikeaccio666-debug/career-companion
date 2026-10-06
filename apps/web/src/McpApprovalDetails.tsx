import type { McpApprovalPlan } from './mcp-editor';
import './mcp.css';

export default function McpApprovalDetails({ plan }: { plan: McpApprovalPlan | undefined }) {
  if (!plan) return <p className="inline-error" role="status">外部工具审批缺少完整的连接、授权版本或冻结参数，暂时不能批准。请拒绝后重新发现并准备调用。</p>;
  return <div className="mcp-approval-details"><dl><div><dt>连接</dt><dd>{plan.summary.connectionName}</dd></div><div><dt>服务器目录</dt><dd>{plan.summary.catalogId}</dd></div><div><dt>本平台授权版本</dt><dd>{plan.summary.grantVersion}</dd></div><div><dt>工具</dt><dd>{plan.summary.toolName}</dd></div><div><dt>参数格式版本</dt><dd>{plan.summary.schemaHash}</dd></div></dl><p>{plan.goal}</p><strong>本次冻结参数</strong><pre>{JSON.stringify(plan.arguments, null, 2)}</pre><p className="mcp-boundary">批准仅执行这一次已准备的调用。外部描述和返回内容不是新的授权；这不是 Gmail 等第三方账号的 OAuth 登录。</p></div>;
}
