import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderStatus } from '@companion/platform-contracts';
import { referenceCreativeArtifact } from '../src/creative-api.ts';
import { CREATIVE_IMAGE_BYTES, creativeAspectRatios, creativePlanJob, creativeReadiness, creativeReferencePolicy, freshCreativeDraft, moveCreativeReference, serializeCreativeDraft, validateCreativeFiles, validateCreativeReferences, type CreativeReference } from '../src/creative-plan.ts';
import { CreativeOperationScope } from '../src/creative-session.ts';

const imagePolicy = { maxImages: 4, maxTotalBytes: CREATIVE_IMAGE_BYTES, mimeTypes: ['image/png', 'image/jpeg', 'image/webp'] };
const openai: ProviderStatus = { id: 'openai', name: 'Fictional image service', keyConfigured: true, enabled: true, capabilities: ['chat', 'image'], models: ['fictional-chat'], modelsByCapability: { chat: ['fictional-chat'], image: ['gpt-image-2.5-flare'] }, envVariables: [], referenceImages: { image: { ...imagePolicy, binding: 'openai_edits' } } };
const ark: ProviderStatus = { ...openai, id: 'ark', name: 'Fictional video service', capabilities: ['video'], models: [], modelsByCapability: { video: ['ep-fictional-account-model'] }, referenceImages: { video: { ...imagePolicy, binding: 'ark_video' } } };
const fal: ProviderStatus = { ...openai, id: 'fal', capabilities: ['image', 'video'], modelsByCapability: { image: ['fal-ai/fictional-image'], video: ['fal-ai/fictional-video'] }, referenceImages: { image: { ...imagePolicy, binding: 'fal_input' }, video: { ...imagePolicy, binding: 'fal_input' } } };
const comfy: ProviderStatus = { ...openai, id: 'comfyui', capabilities: ['image', 'video'], models: [], modelsByCapability: { image: [], video: [] }, referenceImages: undefined, executionTemplate: { version: 1, hash: 'a'.repeat(64) } };
const providers = [openai, ark, fal, comfy];
function reference(id = 'fictional-upload', size = 100): CreativeReference {
  return { attachment: { id, name: 'fictional-picture.png', mime: 'image/png', size, url: `/api/platform/uploads/${id}` }, source: { kind: 'artifact', artifactId: `fictional-artifact-${id}`, jobId: 'fictional-source-job', jobPrompt: 'Fictional source artwork.' } };
}
function draft(provider: ProviderStatus, kind: 'image' | 'video' = 'image') { return { ...freshCreativeDraft([provider], kind), prompt: '  Fictional next creation.  ' }; }

test('private reference support is explicit and bounded by both product and provider limits', () => {
  assert.equal(creativeReferencePolicy({ ...openai, referenceImages: undefined }, 'image'), undefined);
  assert.equal(creativeReferencePolicy(openai, 'video'), undefined);
  assert.equal(creativeReferencePolicy({ ...openai, referenceImages: { image: { ...imagePolicy, maxImages: 0, binding: 'openai_edits' } } }, 'image'), undefined);
  assert.equal(creativeReferencePolicy({ ...openai, referenceImages: { image: { ...imagePolicy, binding: 'unknown' as never } } }, 'image'), undefined);
  assert.equal(creativeReferencePolicy({ ...openai, referenceImages: { image: { ...imagePolicy, maxImages: 10, maxTotalBytes: CREATIVE_IMAGE_BYTES * 2, binding: 'openai_edits' } } }, 'image')!.maxImages, 4);
  const narrow = creativeReferencePolicy({ ...openai, referenceImages: { image: { maxImages: 1, maxTotalBytes: 50, mimeTypes: ['image/png'], binding: 'openai_edits' } } }, 'image');
  assert.throws(() => validateCreativeReferences([reference('one'), reference('two')], narrow), /最多使用 1/);
  assert.throws(() => validateCreativeReferences([reference()], narrow), /总大小/);
});

test('image selection rejects unsupported media, duplicate private IDs and excess aggregate size before upload', () => {
  const policy = creativeReferencePolicy(openai, 'image');
  const files = [{ name: 'fictional.png', type: 'image/png', size: 100 }];
  assert.doesNotThrow(() => validateCreativeFiles(files, [], policy));
  assert.throws(() => validateCreativeFiles([{ ...files[0], type: 'video/mp4' }], [], policy), /视频和其他文件/);
  assert.throws(() => validateCreativeFiles(files, [], undefined), /先选择/);
  assert.throws(() => validateCreativeFiles(files, Array.from({ length: 4 }, (_, index) => reference(`image-${index}`)), policy), /最多使用 4/);
  assert.throws(() => validateCreativeFiles([{ ...files[0], size: CREATIVE_IMAGE_BYTES }], [reference()], policy), /总大小/);
  assert.throws(() => validateCreativeReferences([reference(), reference()], policy), /只能选择一次/);
  assert.throws(() => validateCreativeReferences([{ ...reference(), attachment: { ...reference().attachment, size: undefined as never } }], policy), /不完整/);
  assert.throws(() => validateCreativeReferences([reference()], undefined), /参考图片支持/);
});

test('OpenAI image creation and edits project only supported exact ratio and private attachment IDs', () => {
  const input = draft(openai); input.aspectRatio = '4:3';
  assert.deepEqual(serializeCreativeDraft(input, providers).job.options, { aspectRatio: '4:3' });
  input.references = [reference('first'), reference('second')];
  const plan = serializeCreativeDraft(input, providers);
  assert.deepEqual(plan.job.attachmentIds, ['first', 'second']);
  assert.deepEqual(plan.job.options, { aspectRatio: '4:3' });
  assert.equal(plan.job.model, 'gpt-image-2.5-flare');
  assert.equal('references' in plan.job, false);
  assert.equal(JSON.stringify(plan.job).includes('/api/platform/'), false);
  input.optionsText = '{"seed":42}'; assert.throws(() => serializeCreativeDraft(input, providers), /清空高级参数/);
  assert.equal(creativeAspectRatios(openai, 'image').includes('4:3'), true);
});

test('Ark frame roles preserve image order and require explicit valid mode counts', () => {
  const input = draft(ark, 'video'); input.references = [reference('first')];
  assert.equal(input.aspectRatio, 'adaptive');
  input.optionsText = '{"seed":42,"resolution":"720p"}';
  let plan = serializeCreativeDraft(input, providers);
  assert.deepEqual(plan.job.options, { seed: 42, resolution: '720p', aspectRatio: 'adaptive', duration: 5, referenceMode: 'first_frame' });
  input.references.push(reference('last')); assert.throws(() => serializeCreativeDraft(input, providers), /恰好一张/);
  input.referenceMode = 'first_last_frame'; plan = serializeCreativeDraft(input, providers);
  assert.deepEqual(plan.job.attachmentIds, ['first', 'last']);
  input.references = moveCreativeReference(input.references, 1, -1);
  assert.deepEqual(serializeCreativeDraft(input, providers).job.attachmentIds, ['last', 'first']);
  input.references.push(reference('third')); assert.throws(() => serializeCreativeDraft(input, providers), /恰好两张/);
  input.referenceMode = 'reference_image'; assert.equal(serializeCreativeDraft(input, providers).job.options!.referenceMode, 'reference_image');
  input.optionsText = '{"seed":1.5}'; assert.throws(() => serializeCreativeDraft(input, providers), /整数/);
  input.optionsText = '{"resolution":"fictional-size"}'; assert.throws(() => serializeCreativeDraft(input, providers), /分辨率/);
});

test('fal model-specific inputs remain explicit without generic ratio or duration leaking into queue bodies', () => {
  for (const kind of ['image', 'video'] as const) {
    const input = draft(fal, kind); input.optionsText = '{"input":{"aspect_ratio":"9:16","duration":7,"image_url":"https://example.com/fictional.png"}}';
    assert.deepEqual(serializeCreativeDraft(input, providers).job.options, { input: { aspect_ratio: '9:16', duration: 7, image_url: 'https://example.com/fictional.png' } });
    input.references = [reference()]; assert.throws(() => serializeCreativeDraft(input, providers), /避免重复输入/);
    input.optionsText = '{"input":{"duration":7}}';
    assert.deepEqual(serializeCreativeDraft(input, providers).job.options, { input: { duration: 7 }, referenceField: 'image_url' });
    input.references.push(reference('second')); assert.throws(() => serializeCreativeDraft(input, providers), /多图输入/);
    input.referenceField = 'image_urls'; assert.equal(serializeCreativeDraft(input, providers).job.options!.referenceField, 'image_urls');
    input.optionsText = '{"seed":42}'; assert.throws(() => serializeCreativeDraft(input, providers), /input 对象/);
    input.optionsText = '{"input":{"prompt":"Hidden second prompt."}}'; assert.throws(() => serializeCreativeDraft(input, providers), /再次填写 prompt/);
    input.optionsText = '{"input":{"sync_mode":true}}'; assert.throws(() => serializeCreativeDraft(input, providers), /持久队列/);
  }
});

test('ComfyUI receives empty options while unsupported references and client template parameters are rejected', () => {
  const input = draft(comfy);
  assert.deepEqual(serializeCreativeDraft(input, providers).job.options, {});
  assert.deepEqual(creativeAspectRatios(comfy, 'image'), []);
  assert.deepEqual(creativeReadiness(serializeCreativeDraft(input, providers), providers), []);
  input.optionsText = '{"seed":42}'; assert.throws(() => serializeCreativeDraft(input, providers), /服务端模板/);
  input.optionsText = ''; input.references = [reference()]; assert.throws(() => serializeCreativeDraft(input, providers), /参考图片支持/);
});

test('review and creation snapshots remain independent of editor edits and contain no reference URLs or source metadata', () => {
  const input = draft(fal); input.references = [reference()]; input.optionsText = '{"input":{"seed":42}}';
  const plan = serializeCreativeDraft(input, providers), job = creativePlanJob(plan);
  input.prompt = 'Changed fictional prompt.'; input.references[0].attachment.name = 'changed.png';
  input.references[0].source = { kind: 'upload' };
  assert.equal(plan.references[0].attachment.name, 'fictional-picture.png');
  assert.equal(plan.references[0].source.kind, 'artifact');
  (plan.job.options!.input as Record<string, unknown>).seed = 99;
  plan.job.attachmentIds![0] = 'changed-attachment';
  assert.equal((job.options!.input as Record<string, unknown>).seed, 42);
  assert.deepEqual(job.attachmentIds, ['fictional-upload']);
  assert.equal(job.prompt, 'Fictional next creation.');
  assert.equal(JSON.stringify(job).includes('fictional-source-job'), false);
  assert.equal(JSON.stringify(job).includes('/api/platform/'), false);
});

test('unconfigured providers and missing capability models can prepare reviewed drafts while creation readiness stays closed', () => {
  const unavailable = { ...ark, enabled: false, keyConfigured: false, models: ['fictional-chat'], modelsByCapability: { chat: ['fictional-chat'], video: [] } };
  const input = draft(unavailable, 'video'); input.references = [reference()];
  const plan = serializeCreativeDraft(input, [unavailable]);
  assert.equal(plan.references.length, 1);
  assert.equal(creativeReadiness(plan, [unavailable]).length, 2);
  plan.job.model = 'ep-explicit-fictional-model';
  assert.deepEqual(creativeReadiness(plan, [{ ...unavailable, enabled: true, keyConfigured: true }]), []);
  assert.match(creativeReadiness(plan, [{ ...unavailable, referenceImages: undefined }]).join(' '), /参考图片支持/);
});

test('known model ratio conflicts are held for editing without guessing account endpoint identities', () => {
  const input = draft(ark, 'video'); input.references = [reference()]; input.aspectRatio = '16:9'; input.model = 'doubao-seedance-2-5-fictional';
  assert.match(creativeReadiness(serializeCreativeDraft(input, providers), providers)[0], /随参考图/);
  input.aspectRatio = 'adaptive'; assert.deepEqual(creativeReadiness(serializeCreativeDraft(input, providers), providers), []);
  input.aspectRatio = '16:9'; input.model = 'ep-fictional'; assert.deepEqual(creativeReadiness(serializeCreativeDraft(input, providers), providers), []);
  const image = draft(openai); image.model = 'fictional-legacy-image';
  assert.match(creativeReadiness(serializeCreativeDraft(image, providers), providers)[0], /1:1/);
  image.aspectRatio = '1:1'; assert.deepEqual(creativeReadiness(serializeCreativeDraft(image, providers), providers), []);
});

test('advanced options cannot override reviewed reference bindings, hide credentials or exceed safe input bounds', () => {
  const input = draft(fal);
  for (const text of ['{"referenceField":"image_urls"}', '{"aspectRatio":"1:1"}', '{"attachmentIds":["hidden"]}']) { input.optionsText = text; assert.throws(() => serializeCreativeDraft(input, providers), /避免覆盖/); }
  for (const text of ['{"input":{"headers":{"authorization":"fictional"}}}', '{"input":{"endpoint":"https://example.com"}}']) { input.optionsText = text; assert.throws(() => serializeCreativeDraft(input, providers), /认证或连接/); }
  input.optionsText = '[]'; assert.throws(() => serializeCreativeDraft(input, providers), /JSON 对象/);
  input.optionsText = '{broken'; assert.throws(() => serializeCreativeDraft(input, providers), /JSON 对象/);
  input.optionsText = '{"input":{"number":1e400}}'; assert.throws(() => serializeCreativeDraft(input, providers), /有限数值/);
  input.optionsText = JSON.stringify({ input: { description: '界'.repeat(7000) } }); assert.throws(() => serializeCreativeDraft(input, providers), /20,000 字节/);
});

test('owned artifact resolution uses the real API alias and rejects mismatched source records without reading media bytes', async () => {
  const original = globalThis.fetch, calls: { url: string; init?: RequestInit }[] = [];
  const selected = reference();
  let source = { artifactId: 'fictional-artifact', jobId: 'fictional-job' };
  globalThis.fetch = (async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ attachment: selected.attachment, source }), { status: 200 }); }) as typeof fetch;
  try {
    const result = await referenceCreativeArtifact('fictional-artifact', 'fictional-job');
    assert.equal(result.attachment.id, 'fictional-upload');
    assert.deepEqual(result.source, { kind: 'artifact', artifactId: 'fictional-artifact', jobId: 'fictional-job' });
    assert.equal(calls[0].url, '/api/platform/artifacts/fictional-artifact/reference-attachment');
    assert.equal(calls[0].init?.body, undefined); assert.equal(calls[0].init?.credentials, 'include');
    source = { ...source, jobId: 'wrong-fictional-job' };
    await assert.rejects(() => referenceCreativeArtifact('fictional-artifact', 'fictional-job'), /完整参考记录/);
  } finally { globalThis.fetch = original; }
});

test('late upload or alias results cannot update a different account or release its current operation', async () => {
  const scope = new CreativeOperationScope('fictional-account-a'); scope.mount('fictional-account-a');
  const previous = scope.begin()!; assert.equal(scope.begin(), undefined);
  let release!: () => void;
  const completion = new Promise<void>((resolve) => { release = resolve; }).then(() => scope.isCurrent(previous));
  scope.setAccount('fictional-account-b'); scope.mount('fictional-account-b');
  const active = scope.begin()!; release();
  assert.equal(await completion, false);
  assert.equal(scope.finish(previous), false); assert.equal(scope.busy, true);
  assert.equal(scope.finish(active), true); assert.equal(scope.busy, false);
  const departed = scope.begin()!; scope.dispose();
  assert.equal(scope.isCurrent(departed), false); assert.equal(scope.begin(), undefined);
  scope.mount('fictional-account-b'); assert.equal(scope.isCurrent(departed), false);
});
