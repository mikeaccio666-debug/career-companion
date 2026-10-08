import assert from 'node:assert/strict';
import test from 'node:test';
import { isSafetyResourceDomVisible, isSafetyResourceQuestionSlotReady, type SafetyResourceVisibilityPort } from '../src/safety-resource-visibility.ts';

// Synthetic style/geometry ports verify policy. They do not prove a browser actually painted or a person read text.
type Node = { parent: Node | null; connected: boolean; hidden: boolean; text: string; document: object;
  style: { display: string; visibility: string; contentVisibility: string; opacity: string };
  rect: { width: number; height: number; top: number; bottom: number; left: number; right: number } };
function fixture() {
  const document = {}, make = (parent: Node | null = null): Node => ({ parent, connected: true, hidden: false, text: '', document,
    style: { display: 'block', visibility: 'visible', contentVisibility: 'visible', opacity: '1' },
    rect: { width: 200, height: 100, top: 20, bottom: 120, left: 20, right: 220 } });
  const ancestor = make(), body = make(ancestor), slot = make(body);
  let pageVisible = true, viewport: { width: number; height: number } | null = { width: 390, height: 844 };
  const port: SafetyResourceVisibilityPort<Node> = { connected: node => node.connected, pageVisible: () => pageVisible,
    parent: node => node.parent, hiddenAttribute: node => node.hidden, style: node => node.style, rect: node => node.rect,
    viewport: () => viewport, sameDocument: (left, right) => left.document === right.document, hasText: node => !!node.text };
  return { ancestor, body, slot, make, port, hidePage() { pageVisible = false; }, removeView() { viewport = null; } };
}

test('visible resource requires a live page and intersecting nonempty geometry', () => {
  const f = fixture(); assert.equal(isSafetyResourceDomVisible(f.body, f.port), true);
  f.body.rect.top = 844; f.body.rect.bottom = 944; assert.equal(isSafetyResourceDomVisible(f.body, f.port), false);
  f.body.rect.top = 20; f.body.rect.bottom = 120; f.body.rect.height = 0;
  assert.equal(isSafetyResourceDomVisible(f.body, f.port), false);
});
test('self or ancestor CSS visibility hidden and collapse reject a nonzero rectangle', () => {
  for (const value of ['hidden', 'collapse']) {
    const f = fixture(); f.body.style.visibility = value; assert.equal(isSafetyResourceDomVisible(f.body, f.port), false);
    f.body.style.visibility = 'visible'; f.ancestor.style.visibility = value;
    assert.equal(isSafetyResourceDomVisible(f.body, f.port), false);
  }
});
test('display none or content-visibility hidden on any ancestor rejects body and empty question slot', () => {
  for (const field of ['display', 'contentVisibility'] as const) {
    const f = fixture(); f.ancestor.style[field] = field === 'display' ? 'none' : 'hidden';
    assert.equal(isSafetyResourceDomVisible(f.body, f.port), false);
    assert.equal(isSafetyResourceQuestionSlotReady(f.body, f.slot, f.port), false);
  }
});
test('zero opacity on self or ancestor rejects while fractional visible opacity remains eligible', () => {
  const f = fixture(); f.ancestor.style.opacity = '0.00'; assert.equal(isSafetyResourceDomVisible(f.body, f.port), false);
  f.ancestor.style.opacity = '1'; f.body.style.opacity = '0'; assert.equal(isSafetyResourceDomVisible(f.body, f.port), false);
  f.body.style.opacity = '0.5'; assert.equal(isSafetyResourceDomVisible(f.body, f.port), true);
});
test('hidden attributes, disconnected ancestry, and a background page reject presentation', () => {
  const f = fixture(); f.ancestor.hidden = true; assert.equal(isSafetyResourceDomVisible(f.body, f.port), false);
  f.ancestor.hidden = false; f.ancestor.connected = false; assert.equal(isSafetyResourceDomVisible(f.body, f.port), false);
  f.ancestor.connected = true; f.hidePage(); assert.equal(isSafetyResourceDomVisible(f.body, f.port), false);
});
test('style or geometry access failures, missing view and nonfinite geometry fail closed', () => {
  const f = fixture(); assert.equal(isSafetyResourceDomVisible(f.body, { ...f.port, style() { throw new Error('Unavailable style.'); } }), false);
  assert.equal(isSafetyResourceDomVisible(f.body, { ...f.port, rect() { throw new Error('Detached view.'); } }), false);
  f.removeView(); assert.equal(isSafetyResourceDomVisible(f.body, f.port), false);
  const second = fixture(); second.body.rect.left = NaN; assert.equal(isSafetyResourceDomVisible(second.body, second.port), false);
});
test('incomplete opacity and cyclic ancestry are not evidence of visibility', () => {
  const f = fixture(); f.ancestor.style.opacity = ''; assert.equal(isSafetyResourceDomVisible(f.body, f.port), false);
  f.ancestor.style.opacity = '1'; f.ancestor.parent = f.body; assert.equal(isSafetyResourceDomVisible(f.body, f.port), false);
});
test('an empty question slot needs a renderable actual slot, then written question needs its own visible geometry', () => {
  const f = fixture(); f.slot.rect.height = 0;
  assert.equal(isSafetyResourceQuestionSlotReady(f.body, f.slot, f.port), true);
  f.slot.style.visibility = 'hidden'; assert.equal(isSafetyResourceQuestionSlotReady(f.body, f.slot, f.port), false);
  f.slot.style.visibility = 'visible'; f.slot.text = 'Fictional test question.';
  assert.equal(isSafetyResourceQuestionSlotReady(f.body, f.slot, f.port), false);
  f.slot.rect.height = 24; assert.equal(isSafetyResourceQuestionSlotReady(f.body, f.slot, f.port), true);
  f.slot.rect.top = 850; f.slot.rect.bottom = 874;
  assert.equal(isSafetyResourceQuestionSlotReady(f.body, f.slot, f.port), false);
});
test('question slot from another document or hidden during the write is ineligible', () => {
  const f = fixture(); f.slot.document = {}; assert.equal(isSafetyResourceQuestionSlotReady(f.body, f.slot, f.port), false);
  f.slot.document = f.body.document; assert.equal(isSafetyResourceQuestionSlotReady(f.body, f.slot, f.port), true);
  f.slot.text = 'Fictional test question.'; f.slot.style.opacity = '0';
  assert.equal(isSafetyResourceQuestionSlotReady(f.body, f.slot, f.port), false);
});
