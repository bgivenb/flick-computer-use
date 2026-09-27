import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRunner } from './writing-fixture-runner.js';
import { activeStep, completeStep, createPlan } from '../src/core/task-state.js';
import { StaleObservationError, taskSchema, verify, type Decider, type DecisionContext, type Driver, type Observation, type PlanStepDraft, type TextHelper } from '../src/core/types.js';

const poem = 'Frogs gather where the moonlight gleams,\nAnd stitch the reeds with silver dreams. 🐸\n';
const milestones: PlanStepDraft[] = [
  { objective: 'Write the frog poem in Notes', doneWhen: 'The Notes body contains the full frog poem.', targetHint: 'Notes', produces: 'frog_poem', uses: [] },
  { objective: 'Prepare the same poem in the verified Messages conversation',
    doneWhen: 'The intended Sophie Example conversation is open and the message composer contains frog_poem exactly.',
    targetHint: 'Messages', uses: ['frog_poem'] },
];
const decision = (choice: string) => ({ choice, confidence: .99, probability: .99, latencyMs: 0 });

function crossAppFixture() {
  let active = 'notes', note = '', message = '', revision = 0;
  const writes: Array<{ app: string; text: string }> = [];
  const helperContexts: DecisionContext[] = [];
  const remembered = [{ key: 'recipient', value: 'Sophie Example', source: 'verified contact details' }];
  const driver: Driver = {
    id: 'cross-app', kind: 'desktop', label: 'Synthetic Notes and Messages',
    observe: async (): Promise<Observation> => ({
      id: `o${revision}`, revision: String(revision), sessionId: 'cross-app', kind: 'desktop',
      targetId: active, title: active === 'notes' ? 'Notes' : 'Messages',
      targets: [{ id: 'notes', name: 'Notes', kind: 'macos' }, { id: 'messages', name: 'Messages', kind: 'macos' }],
      memory: structuredClone(remembered),
      text: active === 'notes' ? `Note body\n${note}` : `Sophie Example\nMessage\n${message}`,
      elements: [{ id: 'body', role: 'AXTextArea', name: active === 'notes' ? 'Note body' : 'Message',
        value: active === 'notes' ? note : message, multiline: true, disabled: false, actions: ['fill'] }],
      truncated: false, capturedAt: Date.now(),
    }),
    act: async (action, _observation, signal) => {
      signal.throwIfAborted();
      if (action.kind === 'switch') active = action.targetId;
      else if (action.kind === 'fill') {
        assert.equal(action.elementId, 'body');
        writes.push({ app: active, text: action.value });
        if (active === 'notes') note = action.value;
        else message = action.value;
      } else assert.fail(`Unexpected synthetic UI action: ${action.kind}`);
      revision++;
    },
    screenshot: async () => Buffer.alloc(0), close: async () => {},
  };
  const decider: Decider = {
    decide: async (input, observation, candidates, _history, _signal, context) => {
      assert.ok(context?.taskState?.plan);
      const step = activeStep(context.taskState.plan)!;
      let choice: string;
      if (step.produces === 'frog_poem') choice = note ? 'complete_milestone' : 'compose:body';
      else if (observation.targetId !== 'messages') choice = 'switch:messages';
      else {
        assert.equal(input.inputs['artifact:frog_poem'], poem);
        choice = message ? 'complete_milestone' : 'compose:body';
      }
      assert.ok(candidates[choice], `${choice} must be grounded in the current interface`);
      return decision(choice);
    },
    assessMilestone: async (_input, observation, step, evidence, _signal, scope) => {
      if (scope === 'whole_goal') {
        const proof = evidence.find(item => item.id === 'whole_task');
        assert.ok(proof, 'Whole-goal verification needs the cross-app evidence record');
        assert.ok(proof.text.includes(milestones[0].objective));
        assert.ok(proof.text.includes(milestones[1].objective));
        assert.ok(proof.text.includes(poem.trim()));
        return { complete: note === poem && message === poem, evidenceId: proof.id, confidence: .99 };
      }
      const correctApp = step.produces === 'frog_poem' ? observation.targetId === 'notes' : observation.targetId === 'messages';
      const exact = observation.elements[0].value === poem;
      const proof = evidence.find(item => item.id === 'element:body');
      assert.ok(proof, 'Verification must receive actual observed field content');
      return { complete: correctApp && exact, evidenceId: proof.id, confidence: .99 };
    },
  };
  const helper: TextHelper = {
    compose: async (input, observation, _field, _signal, context) => {
      assert.ok(context?.taskState?.plan);
      helperContexts.push(structuredClone(context));
      assert.deepEqual(observation.memory, remembered);
      assert.equal(input.inputs['memory:recipient (verified contact details)'], 'Sophie Example');
      if (observation.targetId === 'notes') {
        assert.equal(context.taskState.activeObjective, milestones[0].objective);
        assert.equal(context.taskState.artifacts.some(a => a.key === 'frog_poem'), false);
        return { status: 'text', text: poem };
      }
      assert.equal(context.taskState.activeObjective, milestones[1].objective);
      assert.equal(context.taskState.plan.steps[0].status, 'complete');
      const artifact = context.taskState.artifacts.find(a => a.key === 'frog_poem');
      assert.ok(artifact);
      assert.equal(artifact.status, 'observed');
      assert.equal(artifact.value, poem);
      assert.equal(input.inputs['artifact:frog_poem'], poem);
      return { status: 'text', text: artifact.value };
    },
    repair: async () => { assert.fail('The deterministic cross-app task should not need recovery'); },
  };
  const runner = new TaskRunner(decider, helper);
  const input = taskSchema.parse({ sessionId: driver.id, goal: 'Write a frog poem in Notes and prepare that exact poem in Sophie Example’s Messages conversation. Leave it unsent.',
    plan: milestones, until: [], maxSteps: 12 });
  return { runner, driver, input, writes, helperContexts, content: () => ({ note, message }) };
}

test('plan revisions preserve completed outcomes and reject rewriting or dropping their prefix', () => {
  const initial = createPlan(milestones);
  const evidence = 'The actual Notes body contains the full poem.';
  completeStep(initial, evidence);
  const replacement = { ...milestones[1], doneWhen: 'Verified recipient details and the exact full poem are visible.' };
  const revised = createPlan([milestones[0], replacement], initial);
  assert.equal(revised.revision, 2);
  assert.deepEqual(revised.steps[0], initial.steps[0]);
  assert.equal(revised.steps[0].evidence, evidence);
  assert.equal(revised.steps[0].status, 'complete');
  assert.equal(revised.steps[1].status, 'active');
  assert.notEqual(revised.steps[1].id, initial.steps[1].id);
  assert.throws(() => createPlan([{ ...milestones[0], doneWhen: 'Assume the poem is written.' }, replacement], initial), /preserve completed milestones/);
  const independentRemaining = { ...replacement, uses: [] };
  assert.throws(() => createPlan([independentRemaining], initial), /preserve completed milestones/);
  assert.throws(() => createPlan([independentRemaining, milestones[0]], initial), /preserve completed milestones/);
});

test('Jev can complete an automatically created checklist without a verifier', async t => {
  const observation: Observation = { id: 'o', revision: 'r', sessionId: 'empty', kind: 'browser', title: 'Ready', text: 'Ready',
    elements: [], truncated: false, capturedAt: Date.now() };
  assert.equal(verify(observation, []).passed, false);
  let uiActions = 0, decisions = 0;
  const driver: Driver = { id: 'empty', kind: 'browser', label: 'Fixture', observe: async () => observation,
    act: async () => { uiActions++; }, screenshot: async () => Buffer.alloc(0), close: async () => {} };
  const runner = new TaskRunner({ decide: async () => { decisions++; return decision('done'); } });
  t.after(() => runner.close());
  assert.throws(() => taskSchema.parse({ sessionId: driver.id, goal: 'Finish the task', planning: 'off', until: [] }), /explicit completion condition/);
  const input = taskSchema.parse({ sessionId: driver.id, goal: 'Finish the task', until: [] });
  const result = await runner.wait(runner.start(driver, input).id, 1000);
  assert.equal(result.status, 'succeeded', result.reason);
  assert.equal(result.completionReportedBy, 'jev');
  assert.equal(decisions, 1);
  assert.equal(uiActions, 0);
});

test('a generated poem is retained exactly and reused across apps with milestone and memory context', async t => {
  const fixture = crossAppFixture();
  t.after(() => fixture.runner.close());
  const result = await fixture.runner.wait(fixture.runner.start(fixture.driver, fixture.input).id, 1000);
  assert.equal(result.status, 'succeeded', result.reason);
  assert.deepEqual(fixture.writes, [{ app: 'notes', text: poem }, { app: 'messages', text: poem }]);
  assert.deepEqual(fixture.content(), { note: poem, message: poem });
  assert.equal(fixture.helperContexts.length, 2);
  assert.equal(result.artifacts.find(a => a.key === 'frog_poem')?.value, poem);
  assert.equal(result.artifacts.find(a => a.key === 'frog_poem')?.status, 'observed');
  assert.deepEqual(result.plan?.steps.map(step => step.status), ['complete', 'complete']);
  assert.equal(result.completionReportedBy, 'jev');
  assert.ok(result.plan?.steps.every(step => step.evidence?.includes('Jev marked complete')));
});

test('continue keeps completed milestones and exact artifacts instead of recreating the source text', async t => {
  const fixture = crossAppFixture();
  t.after(() => fixture.runner.close());
  fixture.input.maxSteps = 3;
  const first = await fixture.runner.wait(fixture.runner.start(fixture.driver, fixture.input).id, 1000);
  assert.equal(first.status, 'blocked', first.reason);
  assert.match(first.reason ?? '', /Step limit/);
  assert.deepEqual(first.plan?.steps.map(step => step.status), ['complete', 'active']);
  assert.equal(first.artifacts.find(a => a.key === 'frog_poem')?.value, poem);
  assert.equal(fixture.helperContexts.length, 1);
  const resumed = fixture.runner.continue(fixture.driver, first.id, {});
  const result = await fixture.runner.wait(resumed.id, 1000);
  assert.equal(result.status, 'succeeded', result.reason);
  assert.equal(result.continuedFrom, first.id);
  assert.equal(result.plan?.revision, first.plan?.revision);
  assert.deepEqual(result.plan?.steps[0], first.plan?.steps[0]);
  assert.equal(result.artifacts.find(a => a.key === 'frog_poem')?.value, poem);
  assert.deepEqual(fixture.writes, [{ app: 'notes', text: poem }, { app: 'messages', text: poem }]);
  assert.equal(fixture.helperContexts.length, 2);
  assert.deepEqual(fixture.runner.get(first.id).plan, first.plan, 'Continuation must not mutate the stopped task snapshot');
});

test('cancelling while the planner is pending prevents its late answer from causing UI actions', async t => {
  let announcePlanning!: () => void, resolvePlan!: (value: { steps: PlanStepDraft[] }) => void;
  const planningStarted = new Promise<void>(resolve => { announcePlanning = resolve; });
  const plannerResult = new Promise<{ steps: PlanStepDraft[] }>(resolve => { resolvePlan = resolve; });
  let uiActions = 0, decisions = 0;
  const driver: Driver = { id: 'cancel-planner', kind: 'browser', label: 'Fixture',
    observe: async () => ({ id: 'o', revision: 'r', sessionId: 'cancel-planner', kind: 'browser', title: 'Ready', text: 'Ready',
      elements: [], truncated: false, capturedAt: Date.now() }),
    act: async () => { uiActions++; }, screenshot: async () => Buffer.alloc(0), close: async () => {} };
  const helper: TextHelper = { plan: async () => { announcePlanning(); return plannerResult; },
    compose: async () => { assert.fail('No text request should follow cancellation'); }, repair: async () => '' };
  const runner = new TaskRunner({ decide: async () => { decisions++; return decision('wait'); },
    assessMilestone: async () => ({ complete: false, confidence: .99 }) }, helper);
  t.after(() => runner.close());
  const input = taskSchema.parse({ sessionId: driver.id, goal: 'Write a poem', until: [] });
  const started = runner.start(driver, input);
  await planningStarted;
  runner.cancel(started.id);
  resolvePlan({ steps: milestones });
  const result = await runner.wait(started.id, 1000);
  assert.equal(result.status, 'cancelled', result.reason);
  assert.equal(result.plan, undefined);
  assert.equal(decisions, 0);
  assert.equal(uiActions, 0);
  assert.equal(runner.busy(driver.id), false);
});

test('continuation never resubmits an uncertain Enter or Send through regenerated controls', async t => {
  for (const firstRoute of ['enter', 'send'] as const) await t.test(firstRoute, async t => {
    let observations = 0, submissions = 0;
    const offeredRoutes: string[][] = [];
    const driver: Driver = { id: `uncertain-${firstRoute}`, kind: 'desktop', label: 'Synthetic Messages',
      observe: async () => {
        observations++;
        return { id: `o${observations}`, revision: `r${observations}`, sessionId: `uncertain-${firstRoute}`,
          kind: 'desktop', targetId: 'messages', title: 'Messages', text: 'Sophie Example\nDraft: Ribbit',
          elements: [
            { id: `editor-${observations}`, role: 'AXTextArea', name: 'Message', value: 'Ribbit', multiline: true, focused: true, disabled: false, actions: ['fill'] },
            { id: `send-${observations}`, role: 'AXButton', name: 'Send', disabled: false, actions: ['click'] },
          ], truncated: false, capturedAt: Date.now() };
      },
      act: async action => {
        assert.ok(action.kind === 'press' && action.key === 'Enter' || action.kind === 'click' && action.elementId.startsWith('send-'));
        submissions++;
        // The app may have accepted the message, but it has not exposed an outgoing receipt.
      },
      screenshot: async () => Buffer.alloc(0), close: async () => {},
    };
    const decider: Decider = {
      decide: async (_input, observation, candidates) => {
        const sendId = observation.elements.find(element => element.name === 'Send')!.id;
        const sendChoice = `click:${sendId}`;
        const routes = [candidates.enter && 'enter', candidates[sendChoice] && sendChoice].filter((key): key is string => Boolean(key));
        offeredRoutes.push(routes);
        const preferred = firstRoute === 'enter' ? 'enter' : sendChoice;
        return decision(candidates[preferred] ? preferred : routes[0] ?? 'blocked');
      },
      assessMilestone: async () => ({ complete: false, confidence: .99 }),
    };
    const runner = new TaskRunner(decider);
    t.after(() => runner.close());
    const input = taskSchema.parse({ sessionId: driver.id, goal: 'Send Ribbit to the verified Sophie Example conversation.', maxSteps: 1,
      plan: [{ objective: 'Send the message once', doneWhen: 'A new outgoing Ribbit message is visible in Sophie Example’s conversation.', uses: [] }], until: [] });
    const first = await runner.wait(runner.start(driver, input).id, 1000);
    assert.equal(first.status, 'blocked', first.reason);
    assert.equal(submissions, 1);
    assert.equal(first.pendingActions?.length, 1);
    assert.equal(first.pendingActions?.[0].submission, true);
    const resumed = await runner.wait(runner.continue(driver, first.id, {}).id, 1000);
    assert.equal(resumed.status, 'blocked', resumed.reason);
    assert.equal(submissions, 1, 'Neither the same submission nor an alternate Send/Enter route may duplicate it');
    assert.ok(observations >= 3, 'Continuation must inspect newly generated element IDs');
    assert.deepEqual(offeredRoutes[1], []);
    assert.deepEqual(resumed.pendingActions, first.pendingActions);
  });
});

test('separate fields retain distinct drafts without guessing which one names a milestone output', async t => {
  const values = { summary: '', body: '' };
  const expectedSummary = 'A short summary of the frog poem.';
  const draftedFields: string[] = [];
  const driver: Driver = { id: 'multiline', kind: 'desktop', label: 'Synthetic document editor',
    observe: async () => ({ id: 'o', revision: `${values.summary}|${values.body}`, sessionId: 'multiline', kind: 'desktop',
      targetId: 'editor', title: 'Poem editor', text: `Summary\n${values.summary}\nBody\n${values.body}`,
      elements: Object.entries(values).map(([id, value]) => ({ id, role: 'AXTextArea', name: id === 'summary' ? 'Summary' : 'Body',
        value, multiline: true, disabled: false, actions: ['fill'] })), truncated: false, capturedAt: Date.now() }),
    act: async action => {
      assert.equal(action.kind, 'fill');
      if (action.kind === 'fill') {
        assert.ok(action.elementId === 'summary' || action.elementId === 'body');
        values[action.elementId as keyof typeof values] = action.value;
      }
    }, screenshot: async () => Buffer.alloc(0), close: async () => {},
  };
  const helper: TextHelper = {
    compose: async (_input, _observation, field, _signal, context) => {
      draftedFields.push(field.id);
      assert.equal(context?.taskState?.artifacts.some(item => item.key === 'frog_poem'), false,
        'Generated text should only acquire the named output after its evidence is verified');
      return { status: 'text', text: field.id === 'summary' ? expectedSummary : poem };
    }, repair: async () => { assert.fail('Both distinct editors can be filled without recovery'); },
  };
  const decider: Decider = {
    decide: async () => decision(!values.summary ? 'compose:summary' : !values.body ? 'compose:body' : 'complete_milestone'),
    assessMilestone: async (_input, _observation, _step, evidence, _signal, scope) => ({
      complete: values.summary === expectedSummary && values.body === poem,
      evidenceId: evidence.find(item => item.id === (scope === 'whole_goal' ? 'whole_task' : 'element:body'))!.id,
      confidence: .99,
    }),
  };
  const runner = new TaskRunner(decider, helper);
  t.after(() => runner.close());
  const input = taskSchema.parse({ sessionId: driver.id, goal: 'Write a short summary in Summary and a full frog poem in Body.', maxSteps: 5,
    plan: [{ objective: 'Write the summary and full poem', doneWhen: 'Both summary and full poem are present in their matching editors.', produces: 'frog_poem', uses: [] }], until: [] });
  const result = await runner.wait(runner.start(driver, input).id, 1000);
  assert.equal(result.status, 'succeeded', result.reason);
  assert.deepEqual(draftedFields, ['summary', 'body']);
  assert.equal(values.summary, expectedSummary);
  assert.equal(values.body, poem);
  assert.ok(result.artifacts.some(item => item.value === poem));
  assert.ok(result.artifacts.some(item => item.value === expectedSummary));
  assert.equal(result.artifacts.find(item => item.key === 'frog_poem'), undefined);
});

test('a stale remember action cannot insert a named output into retained task artifacts', async t => {
  let observations = 0, rememberAttempts = 0;
  const driver: Driver = { id: 'stale-remember', kind: 'desktop', label: 'Synthetic Notes',
    observe: async () => ({ id: `o${++observations}`, revision: String(observations), sessionId: 'stale-remember', kind: 'desktop',
      targetId: 'notes', title: 'Notes', text: `Excerpt\n${poem}`,
      elements: [{ id: `excerpt-${observations}`, role: 'AXTextArea', name: 'Excerpt', value: poem,
        disabled: false, actions: [] }], truncated: false, capturedAt: Date.now() }),
    act: async action => {
      assert.equal(action.kind, 'remember');
      rememberAttempts++;
      throw new StaleObservationError();
    }, screenshot: async () => Buffer.alloc(0), close: async () => {},
  };
  const decider: Decider = {
    decide: async (_input, observation, candidates) => {
      const choice = `remember:${observation.elements[0].id}`;
      assert.ok(candidates[choice]);
      return decision(choice);
    },
    assessMilestone: async () => ({ complete: false, confidence: .99 }),
  };
  const runner = new TaskRunner(decider);
  t.after(() => runner.close());
  const input = taskSchema.parse({ sessionId: driver.id, goal: 'Remember the exact excerpt from Notes.', maxSteps: 1,
    plan: [{ objective: 'Retain the excerpt', doneWhen: 'The exact observed excerpt is retained.', produces: 'excerpt', uses: [] }], until: [] });
  const result = await runner.wait(runner.start(driver, input).id, 1000);
  assert.equal(result.status, 'failed', result.reason);
  assert.equal(rememberAttempts, 4);
  assert.equal(result.metrics.staleRetries, 3);
  assert.deepEqual(result.artifacts, []);
  assert.equal(result.plan?.steps[0].status, 'active');
});
