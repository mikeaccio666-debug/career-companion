export const fictionalMethodContent = () => ({
  whenToUse: '准备讲述一个有资料依据的课程项目时。',
  appliesTo: { role_families: ['da'], stages: ['preparation'], situations: ['course_project'] },
  prerequisites: ['project-facts'], evidenceNature: '经验建议',
  steps: [{ goal: '核对一个真实判断', method: '对照课程报告，说明你为什么这样判断。', output: '一条带来源的判断。' }],
  rubricRef: null, stopWhen: ['判断有明确依据时先停下。'],
  counterexamples: ['团队成果不能全部说成个人贡献。'], escalateWhen: ['材料含义不清楚时，请真人帮助核对。'],
});
export const fictionalMethodDetails = () => ({
  sourceId: '11111111-1111-4111-8111-111111111111', revision: 2, passageId: '2:0',
  title: '虚构课程项目方法', updatedAt: '2026-10-08T00:00:00.000Z',
  scope: 'org', assetClass: 'method_card', provenanceLabel: '蔓藤方法 · v7',
  provenance: 'untrusted_knowledge', deidentified: true, older: false, brand: '蔓藤', assetRevision: 7,
  content: fictionalMethodContent(),
});
