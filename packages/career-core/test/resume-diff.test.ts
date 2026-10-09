import test from 'node:test';
import assert from 'node:assert/strict';
import { compareOwnerResumeText } from '../src/index.ts';
const id = '11111111-1111-4111-8111-111111111111';
const payload = (text: string) => ({ text, claims: [], source_refs: [{ kind: 'owner_resume_input', id, revision: 1 }] });
test('exact region comparison reconstructs both versions without normalizing whitespace, punctuation or Unicode', () => {
    for (const [before, after] of [['项目：😀研究。', '项目：😄研究。'], ['same', 'same'], ['A\nB', 'A\nC\nB'], ['删除这一句。保留', '保留'], ['保留', '保留新增'], ['新增保留', '保留'], ['a\nb\nc', 'A\nb\nC']]) {
        const d = compareOwnerResumeText(payload(before), payload(after));
        assert.equal(d.prefix + d.removed + d.suffix, before);
        assert.equal(d.prefix + d.added + d.suffix, after);
        assert(Object.isFrozen(d));
        for (const part of Object.values(d)) assert.equal(Buffer.from(part).toString('utf8'), part);
    }
});
test('comparison is complete at the actual 50000-character body bound without a quadratic alignment table', () => {
    const before = '甲'.repeat(50000), after = '乙'.repeat(50000), d = compareOwnerResumeText(payload(before), payload(after));
    assert.equal(d.removed, before); assert.equal(d.added, after); assert.equal(d.prefix, ''); assert.equal(d.suffix, '');
    assert.throws(() => compareOwnerResumeText(payload(before + '甲'), payload(after)));
});
test('different originals, upload references and model claims cannot become an owner-original comparison', () => {
    const a = payload('A'), b = payload('B');
    assert.throws(() => compareOwnerResumeText(payload(''), b));
    assert.throws(() => compareOwnerResumeText(a, { ...b, source_refs: [{ ...b.source_refs[0], id: '22222222-2222-4222-8222-222222222222' }] }));
    assert.throws(() => compareOwnerResumeText(a, { ...b, claims: [{ text: 'Fictional fabricated claim' }] }));
    const upload = { kind: 'resume_upload', id: '33333333-3333-4333-8333-333333333333', sha256: 'a'.repeat(64), storageVersion: '"fictional"' };
    assert.throws(() => compareOwnerResumeText({ ...a, source_refs: [...a.source_refs, upload] }, { ...b, source_refs: [...b.source_refs, { ...upload, sha256: 'b'.repeat(64) }] }));
});
