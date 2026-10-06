import assert from 'node:assert/strict';

// Synthetic local Responses stream; never contacts a model provider.
function sse(items: Record<string, unknown>[]): Response {
  return new Response(items.map(item => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
export function fakeCodexResponse(body: Record<string, unknown>, turn: number): Response {
  const responseId = `resp_synthetic_${turn}`, created = { id: responseId, object: 'response', created_at: 1, status: 'in_progress', model: 'fixture-model', output: [] };
  let item: Record<string, unknown>;
  if (turn === 1) {
    const flatten = (tools: any[]): any[] => tools.flatMap(tool => tool.type === 'namespace' ? tool.tools.map((entry: any) => ({ ...entry, namespace: tool.name })) : [tool]);
    const tools = flatten(body.tools as any[]);
    const tool = tools.find(tool => ['exec_command', 'shell', 'shell_command'].includes(tool.name));
    assert.ok(tool, 'official harness should expose its coding command tool');
    const command = "printf 'export const synthetic = 42;\\n' > fixture.ts";
    const input = tool.name === 'exec_command' ? { cmd: command, max_output_tokens: 2000 } : tool.name === 'shell_command' ? { command, timeout_ms: 10000 } : { command: ['sh', '-c', command], timeout_ms: 10000 };
    item = { id: 'fc_synthetic', type: 'function_call', call_id: 'call_synthetic', name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: JSON.stringify(input) };
  } else item = { id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Created fixture.ts', annotations: [] }] };
  return sse([
    { type: 'response.created', response: created },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { ...created, status: 'completed', output: [item], usage: { input_tokens: 32, output_tokens: 16, total_tokens: 48 } } },
  ]);
}
