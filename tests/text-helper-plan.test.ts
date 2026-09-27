import test from 'node:test';
import assert from 'node:assert/strict';
import { CerebrasTextHelper, FallbackTextHelper, GroqTextHelper, OpenAITextHelper } from '../src/providers/text-helper.js';
import { TextHelperUnavailableError, taskSchema, type DecisionContext, type Observation, type TaskPlan } from '../src/core/types.js';

const signal = () => new AbortController().signal;
const poem = 'Small frogs sing by moonlit streams.\nGreen feet stir their silver dreams. 🐸';
const input = taskSchema.parse({ sessionId: 's', goal: 'Write a frog poem in Notes, then send the same poem to Sophie in Messages after carefully checking who it is.',
  inputs: { recipient: 'Sophie', api_key: 'do-not-include-key' }, until: [{ kind: 'text', text: 'Delivered' }] });
const field: Observation['elements'][number] = { id: 'editor', role: 'AXTextArea', name: 'Message', disabled: false, actions: ['fill'], multiline: true };
const observation: Observation = { id: 'o', revision: 'r', sessionId: 's', kind: 'desktop', targetId: 'com.apple.MobileSMS',
  title: 'Messages', text: 'Sophie\nMessage', elements: [field], truncated: false, capturedAt: 1,
  memory: [{ key: 'frog_poem', value: poem, source: 'Notes body' },
    { key: 'login', value: 'do-not-include-memory', source: 'password field' }] };
const first = { objective: 'Write the frog poem in Notes', doneWhen: 'The new note body contains the full frog poem.',
  targetHint: 'Notes', produces: 'frog_poem', uses: [] };
const second = { objective: 'Verify Sophie and prepare the same poem in Messages',
  doneWhen: 'The intended Sophie is selected and the composer contains frog_poem exactly.', targetHint: 'Messages', produces: null, uses: ['frog_poem'] };
const prior: TaskPlan = { revision: 1, steps: [
  { ...first, id: 'p1', status: 'complete', evidence: 'Notes body contains the full poem.' },
  { objective: second.objective, doneWhen: second.doneWhen, targetHint: second.targetHint, uses: second.uses, id: 'p2', status: 'active' },
] };
const context: DecisionContext = { conditions: [], taskState: { plan: prior, activeObjective: second.objective,
  artifacts: [{ key: 'frog_poem', value: poem, source: 'Notes body', status: 'observed' },
    { key: 'secret', value: 'do-not-include-artifact', source: 'login', status: 'drafted' }] },
  appGuides: [{ id: 'macos-messages', name: 'Messages', version: 1,
    instructions: ['Verify the recipient before sending. Return sends the message.'] }] };

function response(value: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { status: 200 });
}

test('plan drafting requests bounded outcomes and preserves completed state for revision', async () => {
  let body: any;
  const mock: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return response({ steps: [first, second,
      { objective: 'Send the verified message', doneWhen: 'A new outgoing message containing frog_poem appears in the verified conversation.',
        targetHint: null, produces: null, uses: ['frog_poem'] }] });
  };
  const helper = new OpenAITextHelper('fake-test-key', 'gpt-6-luna', mock);
  const result = await helper.plan(input, observation, prior, 'The composer is now available.', signal(), context);
  assert.equal(result.steps.length, 3);
  assert.equal(result.modelCalls, 1);
  assert.equal(result.steps[2].targetHint, undefined);
  assert.equal(result.steps[2].produces, undefined);
  assert.deepEqual(result.steps[2].uses, ['frog_poem']);
  assert.equal(body.response_format.json_schema.name, 'flick_plan');
  assert.equal(body.response_format.json_schema.strict, true);
  const schema = body.response_format.json_schema.schema;
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.steps.maxItems, 8);
  assert.equal(schema.properties.steps.items.additionalProperties, false);
  assert.deepEqual(schema.properties.steps.items.required, ['objective', 'doneWhen', 'targetHint', 'produces', 'uses']);
  assert.deepEqual(schema.properties.steps.items.properties.produces.type, ['string', 'null']);
  assert.match(body.messages[0].content, /Jev.*chooses the actual computer actions/);
  assert.match(body.messages[0].content, /identity verification before/);
  const state = JSON.parse(body.messages[1].content);
  assert.equal(state.goal, input.goal);
  assert.deepEqual(state.previous_plan, prior);
  assert.equal(state.revision_reason, 'The composer is now available.');
  assert.deepEqual(state.app_guides, context.appGuides);
  assert.deepEqual(state.task_state.artifacts, [context.taskState!.artifacts[0]]);
  assert.deepEqual(state.task_state.plan, prior);
  assert.equal(state.task_state.activeObjective, second.objective);
  assert.deepEqual(state.final_completion_conditions, input.until);
  assert.equal(state.remembered_values[0].value, poem);
  assert.equal(state.supplied_values.recipient, 'Sophie');
  assert.equal(JSON.stringify(body).includes('do-not-include'), false);
  assert.equal(JSON.stringify(body).includes('fake-test-key'), false);
});

test('single-app planner receives the relevant guide and avoids incidental focus or navigation checkpoints', async () => {
  const grokInput = taskSchema.parse({ sessionId: 's', goal: 'Open Grok Bot and have it write a frog poem.' });
  const grokObservation: Observation = { ...observation, targetId: 'com.example.GrokBot', title: 'Grok Bot',
    text: 'Prompt', elements: [{ ...field, name: 'Prompt', focused: true }], memory: [] };
  const grokContext: DecisionContext = { conditions: [], appGuides: [{ id: 'grok-bot', name: 'Grok Bot', version: 2,
    instructions: ['The prompt remains focused after Send. Check the conversation for the reply.'] }] };
  const bodies: any[] = [];
  const helper = new GroqTextHelper('fake-key', undefined, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    assert.match(body.messages[0].content, /simple single-app request usually needs one outcome/);
    assert.match(body.messages[0].content, /focus loss is not proof of sending/);
    assert.match(body.messages[0].content, /Honor explicit corrections in revision_reason/);
    const state = JSON.parse(body.messages[1].content);
    assert.deepEqual(state.app_guides, grokContext.appGuides);
    assert.deepEqual(state.page.controls[0].actions, ['fill']);
    assert.equal(state.page.controls[0].disabled, false);
    assert.equal(state.page.controls[0].focused, true);
    return response({ steps: [{ objective: 'Ask Grok Bot for a frog poem and read the reply',
      doneWhen: 'A new Grok reply containing a frog poem appears in the conversation.',
      targetHint: 'Grok Bot', produces: null, uses: [] }] });
  });
  const initial = await helper.plan(grokInput, grokObservation, undefined, undefined, signal(), grokContext);
  assert.equal(initial.steps.length, 1);
  const oldPlan: TaskPlan = { revision: 1, steps: [{ ...initial.steps[0],
    doneWhen: 'Prompt loses focus after Send.', id: 'p1', status: 'active' }] };
  const reason = 'Prompt remains focused after Send. Verify the requested reply in the conversation instead.';
  const revised = await helper.plan(grokInput, grokObservation, oldPlan, reason, signal(), grokContext);
  assert.equal(JSON.parse(bodies[1].messages[1].content).revision_reason, reason);
  assert.match(JSON.parse(bodies[1].messages[1].content).instruction, /remove disproven assumptions/);
  assert.match(revised.steps[0].doneWhen, /new Grok reply/);
});

test('plan drafting rejects excessive steps, executable fields, and missing evidence checks', async () => {
  const invalid = [
    { steps: Array.from({ length: 9 }, () => first) },
    { steps: [{ ...first, action: { kind: 'click', elementId: 'invented' } }] },
    { steps: [{ ...first, doneWhen: '  ' }] },
    { steps: [{ ...first, uses: Array(9).fill('frog_poem') }] },
    { steps: [], complete: true },
  ];
  for (const value of invalid) {
    const helper = new CerebrasTextHelper('fake-test-key', undefined, async () => response(value));
    await assert.rejects(helper.plan(input, observation, undefined, undefined, signal()),
      error => error instanceof TextHelperUnavailableError && /invalid milestone checklist/.test(error.message));
  }
});

test('plan drafting uses the same provider fallback and rate-limit cooldown as writing', async () => {
  let primaryCalls = 0, backupCalls = 0;
  const primary: typeof fetch = async () => { primaryCalls++; return new Response('', { status: 429, headers: { 'Retry-After': '30' } }); };
  const backup: typeof fetch = async (_url, init) => {
    backupCalls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.response_format.json_schema.name, 'flick_plan');
    const state = JSON.parse(body.messages[1].content);
    assert.deepEqual(state.app_guides, context.appGuides);
    assert.equal(state.task_state.activeObjective, context.taskState!.activeObjective);
    assert.deepEqual(state.task_state.artifacts, [context.taskState!.artifacts[0]]);
    return response({ steps: [first, second] });
  };
  const helper = new FallbackTextHelper(new CerebrasTextHelper('primary-key', undefined, primary),
    new GroqTextHelper('backup-key', undefined, backup));
  assert.equal((await helper.plan(input, observation, undefined, undefined, signal(), context)).modelCalls, 2);
  assert.equal((await helper.plan(input, observation, prior, 'Continue remaining work.', signal(), context)).modelCalls, 1);
  assert.equal(primaryCalls, 1);
  assert.equal(backupCalls, 2);
});

test('supplied input keys and literals in uses are redundant and need no additional plan call', async () => {
  let calls = 0;
  const settingsInput = taskSchema.parse({ sessionId: 's', goal: 'Set the export email to demo@example.com and enable daily exports.',
    inputs: { email: 'demo@example.com' }, until: [{ kind: 'text', text: 'Saved' }] });
  const helper = new CerebrasTextHelper('fake-key', undefined, async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.match(body.messages[0].content, /produces names ONLY exact reusable text/);
    assert.match(body.messages[0].content, /produces:null for navigation, configured preferences/);
    const schema = body.response_format.json_schema.schema.properties.steps.items.properties;
    assert.match(schema.produces.description, /Null for navigation, preferences, saved status/);
    assert.match(schema.uses.description, /Never literal values or supplied input names/);
    return response({ steps: [{ objective: 'Configure export preferences', doneWhen: 'Export email and daily exports have the requested settings.',
      targetHint: null, produces: null, uses: ['email', 'demo@example.com'] }] });
  });
  const result = await helper.plan(settingsInput, observation, undefined, undefined, signal());
  assert.equal(calls, 1);
  assert.equal(result.modelCalls, 1);
  assert.deepEqual(result.steps[0].uses, []);
  assert.equal(result.steps[0].produces, undefined);
});

test('a forward text dependency gets one correction request before a valid plan is returned', async () => {
  const requests: any[] = [];
  const helper = new CerebrasTextHelper('fake-key', undefined, async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return response(requests.length === 1 ? { steps: [{ ...first, uses: ['missing_output'] }, second] }
      : { steps: [first, second] });
  });
  const result = await helper.plan(input, observation, undefined, undefined, signal());
  assert.equal(requests.length, 2);
  assert.equal(result.modelCalls, 2);
  const retryState = JSON.parse(requests[1].messages[1].content);
  assert.match(retryState.validation_feedback, /Step 1.*not an earlier text output/);
  assert.equal(retryState.goal, input.goal);
  assert.deepEqual(result.steps[0].uses, []);
  assert.deepEqual(result.steps[1].uses, ['frog_poem']);
});

test('invalid text dependencies retry only once and report both model calls', async () => {
  let calls = 0;
  const helper = new CerebrasTextHelper('fake-key', undefined, async () => {
    calls++;
    return response({ steps: [{ ...first, uses: ['unproduced_text'] }] });
  });
  await assert.rejects(helper.plan(input, observation, undefined, undefined, signal()), error =>
    error instanceof TextHelperUnavailableError && error.modelCalls === 2 && /earlier text output/.test(error.message));
  assert.equal(calls, 2);
});

test('compose retry and repair retain the active milestone, exact artifacts, memory, and relevant guides through the pool', async () => {
  const states: any[] = [];
  const mock: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const state = JSON.parse(body.messages[1].content);
    states.push(state);
    assert.equal(state.task_state.activeObjective, second.objective);
    assert.equal(state.task_state.plan.steps[0].status, 'complete');
    assert.deepEqual(state.task_state.artifacts, [context.taskState!.artifacts[0]]);
    assert.equal(state.remembered_values[0].value, poem);
    assert.deepEqual(state.app_guides, context.appGuides);
    assert.equal(JSON.stringify(state).includes('do-not-include'), false);
    if (body.response_format.json_schema.name === 'flick_repair')
      return response({ guidance: 'Use the retained frog_poem in the verified conversation’s composer.' });
    assert.match(body.messages[0].content, /Jev has already chosen/);
    assert.match(body.messages[0].content, /Reuse.*verbatim/);
    return response(states.length === 1 ? { status: 'need_input', text: '' } : { status: 'text', text: poem });
  };
  const helper = new FallbackTextHelper(new CerebrasTextHelper('primary', undefined, mock),
    new GroqTextHelper('unused', undefined, async () => { throw new Error('Backup should not be needed.'); }));
  const answer = await helper.compose(input, observation, field, signal(), context);
  assert.equal(answer.text, poem);
  assert.equal(answer.modelCalls, 2);
  assert.match(await helper.repair(input, observation, ['The selected field was not writable.'], signal(), context), /retained frog_poem/);
  assert.equal(states.length, 3);
});

test('a cancelled plan request makes no provider request', async () => {
  let calls = 0;
  const helper = new CerebrasTextHelper('fake-test-key', undefined, async () => { calls++; return response({ steps: [first] }); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(helper.plan(input, observation, undefined, undefined, controller.signal), /abort/i);
  assert.equal(calls, 0);
});


test('a revision that changes completed work is corrected before reaching the runner', async () => {
  const states: any[] = [];
  const helper = new CerebrasTextHelper('fake-key', undefined, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const state = JSON.parse(body.messages[1].content); states.push(state);
    return response({ steps: states.length === 1
      ? [{ ...first, doneWhen: 'The Notes editor loses focus.' }, second]
      : [first, second] });
  });
  const result = await helper.plan(input, observation, prior, 'Correct the remaining completion condition.', signal(), context);
  assert.equal(result.modelCalls, 2);
  assert.equal(result.steps[0].doneWhen, first.doneWhen);
  assert.match(states[1].validation_feedback, /Step 1 is already complete.*exactly, in order/);
  assert.deepEqual(states[1].app_guides, context.appGuides);
  assert.deepEqual(states[1].task_state.artifacts, [context.taskState!.artifacts[0]]);
});

test('a revision cannot omit completed milestones even when the new remaining checklist is otherwise valid', async () => {
  let calls = 0;
  const helper = new CerebrasTextHelper('fake-key', undefined, async () => {
    calls++;
    return response({ steps: [{ objective: 'Finish the remaining task', doneWhen: 'The final result is visible.',
      targetHint: null, produces: null, uses: [] }] });
  });
  await assert.rejects(helper.plan(input, observation, prior, 'Continue.', signal(), context), error =>
    error instanceof TextHelperUnavailableError && error.modelCalls === 2 && /already complete/.test(error.message));
  assert.equal(calls, 2);
});


test('text helpers receive concise completed progress while exact verifier records remain local', async () => {
  const records = [{ id: 'raw_1', text: 'RAW_VERIFIER_ONLY:' + 'snapshot content '.repeat(2000) }];
  const fullPlan: TaskPlan = { ...prior, steps: prior.steps.map((step, index) => index === 0
    ? { ...step, evidence: 'Completed poem is visible. '.repeat(100), evidenceRecords: records }
    : { ...step }) };
  const fullContext: DecisionContext = { ...context, taskState: { ...context.taskState!, plan: fullPlan } };
  const before = structuredClone(fullPlan);
  const requests: any[] = [];
  const helper = new CerebrasTextHelper('fake-key', undefined, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const state = JSON.parse(body.messages[1].content); requests.push(state);
    for (const sentPlan of [state.previous_plan, state.task_state?.plan].filter(Boolean)) {
      assert.equal('evidenceRecords' in sentPlan.steps[0], false);
      assert.equal(sentPlan.steps[0].status, 'complete');
      assert.equal(sentPlan.steps[0].objective, first.objective);
      assert.equal(sentPlan.steps[0].doneWhen, first.doneWhen);
      assert.equal(sentPlan.steps[0].produces, first.produces);
      assert.equal(sentPlan.steps[0].id, 'p1');
      assert.ok(sentPlan.steps[0].evidence.length < 850);
      assert.match(sentPlan.steps[0].evidence, /Completed poem is visible/);
      assert.match(sentPlan.steps[0].evidence, /Evidence excerpt truncated/);
    }
    assert.equal(JSON.stringify(state).includes('RAW_VERIFIER_ONLY'), false);
    if (body.response_format.json_schema.name === 'flick_plan') return response({ steps: [first, second] });
    if (body.response_format.json_schema.name === 'flick_repair') return response({ guidance: 'Use the retained poem.' });
    return response({ status: 'text', text: poem });
  });
  await helper.plan(input, observation, fullPlan, 'Continue remaining work.', signal(), fullContext);
  await helper.compose(input, observation, field, signal(), fullContext);
  await helper.repair(input, observation, [], signal(), fullContext);
  assert.equal(requests.length, 3);
  assert.deepEqual(fullPlan, before);
  assert.equal(fullPlan.steps[0].evidenceRecords, records);
});
