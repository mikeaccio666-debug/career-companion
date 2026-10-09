import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResumeReviewDiff } from '../src/resume-diff.ts';
const id = '11111111-1111-4111-8111-111111111111', owner = '22222222-2222-4222-8222-222222222222';
const value = () => ({ itemId: id, ownerId: owner, currentRevision: 3, from: { revision: 1, payloadDigest: 'a'.repeat(64) }, to: { revision: 2, payloadDigest: 'b'.repeat(64) }, sourceRefs: [{ kind: 'owner_resume_input', id, revision: 1 }], text: { prefix: 'Fictional ', removed: 'old', added: 'new', suffix: ' text.' }, unresolvedClaims: [] });
test('comparison contract closes ownership, revision coordinates, source and claim fields and copies nested values', () => {
    const input = value(), d = parseResumeReviewDiff(input); input.text.added = 'changed'; assert.equal(d.text.added, 'new'); assert(Object.isFrozen(d)); assert(Object.isFrozen(d.text)); assert(Object.isFrozen(d.sourceRefs));
    for (const patch of [{ currentRevision: 1 }, { from: { ...d.from, revision: 2 } }, { to: { ...d.to, revision: -1 } }, { sourceRefs: [{ kind: 'owner_resume_input', id: owner, revision: 1 }] }, { unresolvedClaims: [{ id }] }, { approved: true }]) assert.throws(() => parseResumeReviewDiff({ ...value(), ...patch }));
});
test('contradictory equal digests and equal text, malformed strings and over-limit reconstructed originals are rejected', () => {
    assert.throws(() => parseResumeReviewDiff({ ...value(), to: { revision: 2, payloadDigest: 'a'.repeat(64) } }));
    assert.throws(() => parseResumeReviewDiff({ ...value(), text: { prefix: 'Same', removed: '', added: '', suffix: '' } }));
    assert.throws(() => parseResumeReviewDiff({ ...value(), text: { ...value().text, prefix: 4 } }));
    assert.throws(() => parseResumeReviewDiff({ ...value(), text: { ...value().text, prefix: '甲'.repeat(50000) } }));
    const d = parseResumeReviewDiff({ ...value(), to: { revision: 2, payloadDigest: 'a'.repeat(64) }, text: { prefix: 'Same', removed: '', added: '', suffix: '' } }); assert.equal(d.from.payloadDigest, d.to.payloadDigest);
});
