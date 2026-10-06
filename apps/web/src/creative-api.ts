import type { Attachment } from '@companion/platform-contracts';
import { request } from './api.ts';
import type { CreativeReference } from './creative-plan.ts';

export async function referenceCreativeArtifact(artifactId: string, expectedJobId: string, signal?: AbortSignal): Promise<CreativeReference> {
  const result = await request<{ attachment: Attachment; source: { artifactId: string; jobId: string } }>(`/artifacts/${encodeURIComponent(artifactId)}/reference-attachment`, { signal });
  if (!result?.attachment?.id || result.source?.artifactId !== artifactId || result.source?.jobId !== expectedJobId) throw new Error('服务没有返回这件作品的完整参考记录，请刷新任务后重试。');
  return { attachment: result.attachment, source: { kind: 'artifact', ...result.source } };
}
