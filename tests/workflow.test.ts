import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskRunner } from '../src/core/runner.js';
import { WorkflowRunner, workflowSchema, type WorkflowDriver } from '../src/core/workflow.js';
import type { Action, Decider, Observation } from '../src/core/types.js';

function fixture(decider?: Decider) {
  let app = 'notes', saved = '', closed = 0;
  const switches: string[] = [], actions: Action[] = [];
  const observe = async (): Promise<Observation> => ({ id: 'o', sessionId: 's', kind: 'macos', capturedAt: Date.now(),
    revision: app + saved, title: app, text: app === 'notes' ? 'Note ready' : saved ? 'Saved' : 'Empty', truncated: false,
    elements: [{ id: 'f', role: 'textbox', name: app === 'notes' ? 'Note' : 'Event notes', value: app === 'notes' ? 'Exact note from source' : saved,
      disabled: false, actions: ['fill'] }] });
  const driver: WorkflowDriver = { id: 's', kind: 'macos', label: 'fixture', observe,
    act: async action => { actions.push(action); if (action.kind === 'fill') saved = action.value; },
    switchApp: async bundleId => { switches.push(bundleId); app = bundleId; },
    screenshot: async () => Buffer.alloc(0), close: async () => { closed++; } };
  const tasks = new TaskRunner(decider ?? { decide: async (_, __, candidates) => ({
    choice: Object.keys(candidates).find(key => candidates[key].description.startsWith('Fill'))!, confidence: 1, probability: 1, latencyMs: 1,
  }) });
  const workflows = new WorkflowRunner(tasks, async () => driver);
  const input = workflowSchema.parse({ ocr: 'off', stages: [
    { bundleId: 'notes', goal: 'Read the note', until: [{ kind: 'text', text: 'Note ready' }] },
    { bundleId: 'calendar', goal: 'Copy the note', inputsFrom: { note: { stage: 0, field: 'Note' } }, until: [{ kind: 'text', text: 'Saved' }] },
  ] });
  return { workflows, input, actions, switches, closed: () => closed };
}

test('workflow switches apps under one owner and copies exactly the observed source field', async () => {
  const e = fixture();
  const started = e.workflows.start(e.input);
  assert.throws(() => e.workflows.start(e.input), /already owns/);
  const result = await e.workflows.wait(started.id, 1000);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(e.switches, ['calendar']);
  assert.deepEqual(e.actions, [{ kind: 'fill', elementId: 'f', value: 'Exact note from source' }]);
  assert.equal(result.metrics.steps, 1);
  assert.equal(result.stages.length, 2);
  assert.equal(result.stages[0].result.lastObservation, undefined);
  assert.equal(e.closed(), 1); assert.equal(e.workflows.busy(), false);
});

test('cancelling a workflow during a Jev decision prevents its write and releases ownership', async () => {
  const e = fixture({ decide: async () => { await delay(80); return { choice: 'done', confidence: 1, probability: 1, latencyMs: 80 }; } });
  const started = e.workflows.start(e.input);
  await delay(10); e.workflows.cancel(started.id);
  const result = await e.workflows.wait(started.id, 1000);
  assert.equal(result.status, 'cancelled'); assert.equal(e.actions.length, 0);
  assert.equal(e.closed(), 1); assert.equal(e.workflows.busy(), false);
});

test('an unavailable source field stops a workflow before the destination is edited', async () => {
  const e = fixture(); e.input.stages[1].inputsFrom.note.field = 'Missing';
  const result = await e.workflows.wait(e.workflows.start(e.input).id, 1000);
  assert.equal(result.status, 'failed'); assert.match(result.reason!, /unambiguous/);
  assert.equal(e.actions.length, 0); assert.equal(e.closed(), 1);
});

test('a failed stage stops the workflow before switching to the next app', async () => {
  const e = fixture({ decide: async () => ({ choice: 'blocked', confidence: 1, probability: 1, latencyMs: 1 }) });
  e.input.stages[0].until = [{ kind: 'text', text: 'Unavailable' }];
  const result = await e.workflows.wait(e.workflows.start(e.input).id, 1000);
  assert.equal(result.status, 'blocked'); assert.deepEqual(e.switches, []); assert.equal(e.closed(), 1);
});

test('workflow bindings cannot reference a future stage', () => {
  const e = fixture(); e.input.stages[1].inputsFrom.note.stage = 1;
  assert.equal(workflowSchema.safeParse(e.input).success, false);
});
