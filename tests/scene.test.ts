import test from 'node:test';
import assert from 'node:assert/strict';
import { describeEffect, focusView, mergeDuplicates, progressDigest } from '../src/core/scene.js';
import type { ElementInfo, Observation } from '../src/core/types.js';

const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const scene = (elements: ElementInfo[], extra: Partial<Observation> = {}): Observation => ({ id: 'o', revision: 'r', sessionId: 's', kind: 'macos', title: 'Results',
  text: '', elements, truncated: false, capturedAt: 0, ...extra });

test('one visible result exposed as button, image, and link becomes one target with every variant', () => {
  const merged = mergeDuplicates([
    { id: 'e1', role: 'button', name: 'Elvis Presley - Wikipedia', disabled: false, actions: ['click'], bounds: at(20, 400, 380, 580) },
    { id: 'e2', role: 'AXImage', name: 'Elvis Presley - Wikipedia', disabled: false, actions: ['click'], clickVariants: ['right'], bounds: at(24, 404, 370, 500) },
    { id: 'e3', role: 'AXLink', name: 'Elvis Presley - Wikipedia', disabled: false, actions: ['click'], bounds: at(24, 910, 200, 20) },
    { id: 'e4', role: 'AXLink', name: 'Elvis Presley - Wikipedia', disabled: false, actions: ['click'], bounds: at(900, 400, 200, 20) },
  ]);
  assert.deepEqual(merged.map(e => e.id), ['e1', 'e4']);
  assert.deepEqual(merged[0].clickVariants, ['right']);
  // A caption without actions inside a clickable card keeps the card, whose own click the driver accepts;
  // controls with different capabilities are never merged into one.
  const card = mergeDuplicates([{ id: 't', role: 'AXStaticText', name: 'Photo', disabled: false, actions: [], bounds: at(10, 10, 50, 10) },
    { id: 'c', role: 'button', name: 'Photo', disabled: false, actions: ['click'], bounds: at(0, 0, 100, 100) }]);
  assert.deepEqual(card.map(e => [e.id, e.actions]), [['c', ['click']]]);
  assert.equal(mergeDuplicates([{ id: 'f', role: 'combobox', name: 'Size', disabled: false, actions: ['select'], bounds: at(0, 0, 50, 20) },
    { id: 'b', role: 'button', name: 'Size', disabled: false, actions: ['click'], bounds: at(0, 0, 50, 20) }]).length, 2);
});
test('an open menu is the whole view, and a long page keeps focused and goal-related controls in reading order', () => {
  const menu = scene([{ id: 'e1', role: 'AXLink', name: 'Images', disabled: false, actions: ['click'] },
    { id: 'e2', role: 'AXMenuItem', name: 'Copy Image', disabled: false, actions: ['click'], modal: true }], { modal: { kind: 'menu' } });
  assert.deepEqual(focusView(menu, 'copy an image').elements.map(e => e.id), ['e2']);
  const page = scene(Array.from({ length: 200 }, (_, i): ElementInfo => ({ id: `e${i}`, role: 'AXLink', name: i === 150 ? 'Elvis Presley images' : `Result ${i}`,
    disabled: false, actions: ['click'], focused: i === 199 })));
  const view = focusView(page, 'Find an Elvis Presley photograph', 20);
  assert.equal(view.elements.length, 20); assert.equal(view.truncated, true);
  assert.ok(view.elements.some(e => e.id === 'e150') && view.elements.some(e => e.id === 'e199'));
  assert.deepEqual(view.elements.map(e => Number(e.id.slice(1))), [...view.elements.map(e => Number(e.id.slice(1)))].sort((a, b) => a - b));
});
test('progress ignores text churn and geometry but not navigation, open layers, form state, or the clipboard', () => {
  const field: ElementInfo = { id: 'e8', role: 'textbox', name: 'Search', value: 'Elvis', disabled: false, actions: ['fill'], bounds: at(0, 0, 10, 10) };
  const base = scene([field], { text: 'Ad 1', clipboard: { changeCount: 5, hasImage: false } });
  assert.equal(progressDigest(base), progressDigest({ ...base, text: 'Ad 2', revision: 'other', elements: [{ ...field, bounds: at(5, 5, 10, 10) }] }));
  for (const changed of [{ url: 'https://x.test/images' }, { modal: { kind: 'menu' as const } }, { elements: [{ ...field, value: 'Elvis Presley' }] }, { clipboard: { changeCount: 6, hasImage: true } }])
    assert.notEqual(progressDigest(base), progressDigest({ ...base, ...changed }));
});
test('effects describe what an action changed in terms Jev can use', () => {
  const image: ElementInfo = { id: 'e60', role: 'AXImage', name: 'Elvis', disabled: false, actions: ['click'] };
  const before = scene([image], { clipboard: { changeCount: 5, hasImage: false } });
  const menu = scene([{ id: 'm1', role: 'AXMenuItem', name: 'Copy Image', disabled: false, actions: ['click'], modal: true }], { modal: { kind: 'menu' }, clipboard: { changeCount: 5, hasImage: false } });
  assert.equal(describeEffect(before, menu, { kind: 'click', elementId: 'e60', button: 'right' }), 'a menu opened with 1 items');
  assert.equal(describeEffect(menu, { ...before, clipboard: { changeCount: 6, hasImage: true } }, { kind: 'click', elementId: 'm1' }), 'the menu closed; an image was copied to the clipboard');
  assert.equal(describeEffect(before, before, { kind: 'press', key: 'c', modifiers: ['Meta'] }), 'the clipboard did not change');
  assert.equal(describeEffect(before, before, { kind: 'click', elementId: 'e60' }), 'no visible effect');
});
