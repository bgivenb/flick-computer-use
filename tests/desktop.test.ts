import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopDriver } from '../src/drivers/desktop.js';
import { TaskRunner } from '../src/core/runner.js';
import { taskSchema, StaleObservationError, verify, type Action, type Driver, type Decider, type Observation } from '../src/core/types.js';

function lab() {
  let app = '', destination = '', saved = '', closed = false;
  let source = randomUUID();
  const native: Driver & { switchApp(id: string): Promise<void> } = {
    id: 'native', kind: 'macos', label: 'Lab', switchApp: async id => { app = id; },
    observe: async (): Promise<Observation> => ({ id: randomUUID(), sessionId: 'native', kind: 'macos', title: app, revision: `${app}/${source}/${destination}/${saved}`, text: saved ? 'Saved' : 'Ready', truncated: false, capturedAt: Date.now(),
      elements: app === 'source' ? [{ id: 's', name: 'Reference', value: source, role: 'textbox', disabled: false, actions: [] }] : [
        { id: 'd', name: 'Reference', value: destination, role: 'textbox', disabled: false, actions: ['fill'] },
        { id: 'save', name: 'Save', role: 'button', disabled: false, actions: ['click'] }] }),
    act: async action => { if (action.kind === 'fill') destination = action.value; else if (action.kind === 'click') saved = destination; },
    close: async () => { closed = true; }, screenshot: async () => Buffer.alloc(0),
  };
  const driver = new DesktopDriver([{ kind: 'macos', name: 'Source', bundleId: 'source' }, { kind: 'macos', name: 'Destination', bundleId: 'destination' }], {
    native: () => native, browser: async () => { throw new Error('unused'); },
  });
  return { driver, source: () => source, saved: () => saved, changeSource: () => { source = randomUUID(); }, closed: () => closed };
}
const chooser: Decider = { factored: true, decide: async (_, o, candidates) => {
  const desired: Action = !o.targetId ? { kind: 'switch', targetId: 'source' }
    : o.targetId === 'source' ? o.memory?.length ? { kind: 'switch', targetId: 'destination' } : { kind: 'remember', elementId: 's' }
    : o.elements.find(e => e.id === 'd')!.value === o.memory![0].value ? { kind: 'click', elementId: 'save' }
    : { kind: 'fill', elementId: 'd', value: o.memory![0].value };
  const choice = Object.keys(candidates).find(k => JSON.stringify(candidates[k].action) === JSON.stringify(desired));
  assert.ok(choice, JSON.stringify(desired));
  return { choice, confidence: 1, probability: 1, latencyMs: 0 };
} };

test('the initial app catalog cannot satisfy an absent-element completion check', async () => {
  const l = lab();
  try { assert.equal(verify(await l.driver.observe(), [{ kind: 'element_absent', name: 'Unsaved changes' }]).passed, false); }
  finally { await l.driver.close(); }
});

test('one goal switches apps and transfers an unknown observed value with independent verification', async () => {
  const l = lab(), runner = new TaskRunner(chooser);
  const input = taskSchema.parse({ sessionId: l.driver.id, goal: 'Copy the reference from Source to Destination and save it.',
    until: [{ kind: 'text', text: 'Saved' }, { kind: 'target', targetId: 'destination' }, { kind: 'field_from_memory', name: 'Reference', source: 'Source / Reference' }] });
  try {
    const result = await runner.wait(runner.start(l.driver, input).id, 1000, true);
    assert.equal(result.status, 'succeeded', result.reason);
    assert.equal(result.steps, 5); assert.equal(l.saved(), l.source()); assert.equal(result.memory?.[0].value, l.source());
  } finally { await l.driver.close(); }
  assert.equal(l.closed(), true);
});
test('remembering rejects changed source text before it becomes a reusable value', async () => {
  const l = lab(), signal = new AbortController().signal;
  try {
    await l.driver.act({ kind: 'switch', targetId: 'source' }, await l.driver.observe(), signal);
    const o = await l.driver.observe(); l.changeSource();
    await assert.rejects(l.driver.act({ kind: 'remember', elementId: 's' }, o, signal), StaleObservationError);
    assert.equal((await l.driver.observe()).memory?.length, 0);
  } finally { await l.driver.close(); }
});
test('continuation retains app state and memory after a missing-input handoff', async () => {
  const l = lab(); let blockOnce = true;
  const runner = new TaskRunner({ decide: async (...args) => {
    if (args[1].memory?.length && blockOnce) { blockOnce = false; return { choice: 'blocked', confidence: 1, probability: 1, latencyMs: 0 }; }
    return chooser.decide(...args);
  } });
  try {
    const input = taskSchema.parse({ sessionId: l.driver.id, goal: 'Transfer reference and save', until: [{ kind: 'text', text: 'Saved' }] });
    const first = await runner.wait(runner.start(l.driver, input).id, 1000);
    assert.equal(first.status, 'blocked'); assert.equal(first.memory?.length, 1);
    const second = await runner.wait(runner.continue(l.driver, first.id, {}, 'Continue the transfer.').id, 1000);
    assert.equal(second.status, 'succeeded'); assert.equal(second.continuedFrom, first.id); assert.equal(l.saved(), l.source());
  } finally { await l.driver.close(); }
});
test('cancellation during app opening schedules no following write', async () => {
  const l = lab();
  const original = l.driver.act.bind(l.driver);
  l.driver.act = async (...args) => { await delay(40); await original(...args); };
  const runner = new TaskRunner(chooser);
  try {
    const task = runner.start(l.driver, taskSchema.parse({ sessionId: l.driver.id, goal: 'Transfer', until: [{ kind: 'text', text: 'Saved' }] }));
    await delay(10); runner.cancel(task.id);
    const result = await runner.wait(task.id, 1000);
    assert.equal(result.status, 'cancelled'); assert.equal(l.saved(), '');
  } finally { await l.driver.close(); }
});
