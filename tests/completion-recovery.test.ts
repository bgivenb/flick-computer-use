import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRunner } from '../src/core/runner.js';
import type { AppGuideStore } from '../src/core/app-guides.js';
import { taskSchema, type Candidates, type DecisionContext, type Driver, type ElementInfo, type Observation, type PlanStepDraft, type TextHelper } from '../src/core/types.js';

const poem = 'A frog beneath the silver moon\nSings to the pond a gentle tune.';
const milestone: PlanStepDraft = {
  objective: 'Ask for a frog poem and verify the reply',
  doneWhen: 'The finished frog poem is visible in the conversation.', uses: [],
};
const choose = (choice: string) => ({ choice, confidence: .99, probability: .99, latencyMs: 0 });
const absentChecks = (candidates: Candidates) => {
  assert.equal(candidates.complete_milestone, undefined, 'Failed milestone verification must be withdrawn');
  assert.equal(candidates.done, undefined, 'The done alias must not bypass the same verification guard');
};

function fixture(id: string) {
  let observations = 0;
  const state = { text: 'Request sent. Waiting for the poem.',
    element: { id: 'prompt', role: 'textbox', name: 'Prompt', value: '', focused: true, disabled: false, actions: ['fill'] } as ElementInfo };
  const actions: string[] = [];
  const driver: Driver = {
    id, kind: 'browser', label: 'Synthetic poem chat',
    observe: async (): Promise<Observation> => ({
      id: `observation-${++observations}`, revision: String(observations), sessionId: id, kind: 'browser',
      title: 'Poem chat', url: 'https://poem.example.test/chat', text: state.text,
      elements: [{ ...structuredClone(state.element), id: `prompt-${observations}` }], truncated: false, capturedAt: Date.now(),
    }),
    act: async (action, _before, signal) => {
      signal.throwIfAborted(); actions.push(action.kind);
      assert.equal(action.kind, 'wait', 'Recovery should wait for the reply, without another submission');
      state.text = poem;
    },
    screenshot: async () => Buffer.alloc(0), close: async () => {},
  };
  const input = taskSchema.parse({ sessionId: id, goal: 'Ask the chat for a frog poem and verify its reply.',
    plan: [milestone], until: [], maxSteps: 12 });
  return { driver, state, actions, input };
}

test('the initial planner and explicit replanner receive the currently matched app guidance', async t => {
  const f = fixture('planner-app-guides');
  const guide = { id: 'poem-chat', name: 'Poem chat', version: 3,
    instructions: ['The composer stays focused after Send; verify completion in the response text.'] };
  const contexts: DecisionContext[] = [];
  const guides = { forObservation: async (observation: Observation) => {
    assert.equal(observation.url, 'https://poem.example.test/chat'); return [guide];
  } } as unknown as AppGuideStore;
  const helper: TextHelper = {
    plan: async (_input, _observation, previous, _reason, _signal, context) => {
      assert.ok(context, 'Planner needs the same app context as the decision and writing helpers');
      assert.deepEqual(context.appGuides, [guide]);
      if (previous) assert.equal(context.taskState?.plan?.revision, previous.revision);
      contexts.push(structuredClone(context)); return { steps: [milestone] };
    },
    compose: async () => { assert.fail('The fixture already contains the reply'); }, repair: async () => '',
  };
  let decisions = 0;
  f.state.text = poem;
  const runner = new TaskRunner({
    decide: async (_input, _observation, candidates) => {
      decisions++;
      const action = decisions === 1 ? 'modify_plan' : 'complete_milestone';
      assert.ok(candidates[action]); return choose(action);
    },
    assessMilestone: async (_input, _observation, _step, evidence) => ({ complete: true, evidenceId: evidence[0].id, confidence: .99 }),
  }, helper, { guides });
  t.after(() => runner.close());
  const input = taskSchema.parse({ ...f.input, plan: undefined });
  const result = await runner.wait(runner.start(f.driver, input).id, 1000);
  assert.equal(result.status, 'succeeded', result.reason);
  assert.equal(contexts.length, 2);
  assert.deepEqual(result.guides, [{ id: guide.id, name: guide.name, version: guide.version }]);
  assert.deepEqual(f.actions, []);
});
