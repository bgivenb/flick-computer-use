import test from 'node:test';
import assert from 'node:assert/strict';
import { taskSchema, type Candidates, type DecisionContext, type Observation, type PlanStepDraft } from '../src/core/types.js';
import { decisionContract, decisionState, TypeSafeDecider } from '../src/providers/typesafe.js';
import { milestoneEvidence } from '../src/core/task-state.js';

const observed: Observation = { id: 'o', sessionId: 's', kind: 'desktop', title: 'Frog poem', targetId: 'notes',
  targets: [{ id: 'notes', name: 'Notes', kind: 'macos' }], text: 'A frog upon a log', revision: '1', capturedAt: 0, truncated: false, elements: [] };
const input = taskSchema.parse({ sessionId: 's', goal: 'Write a frog poem in Notes, then put the same poem in a message draft for Sophie.' });
const milestone: PlanStepDraft = { objective: 'Write the poem in Notes', doneWhen: 'Notes shows the finished frog poem in its editor.',
  targetHint: 'Notes', produces: 'frog_poem', uses: [] };
const choice = (value: string, confidence = .91) => ({ type: 'choice', choice: value, confidence, probabilities: { [value]: .97 } });
const response = (value: string, confidence = .91, completeProbability = .99) => new Response(JSON.stringify({ answers: {
  evidence: choice(value, confidence), complete: { type: 'noul', noul: completeProbability },
} }));
const signal = () => new AbortController().signal;

test('milestone verification selects a real supplied evidence ID using the active milestone only', async () => {
  const evidence = [{ id: 'changed-app', text: 'Active app: Notes' },
    { id: 'editor-observed', text: 'Notes editor Body contains the finished poem: A frog upon a log.' }];
  const decider = new TypeSafeDecider('test-key', 'test-model', async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.state.goal, input.goal);
    assert.deepEqual(body.state.milestone, milestone);
    assert.equal(body.state.interface.targetName, 'Notes');
    assert.equal(body.questions.evidence.type, 'choice');
    assert.equal(body.questions.complete.type, 'noul');
    assert.equal(body.state.observed_evidence.e1.text, evidence[1].text);
    assert.match(body.questions.evidence.criteria.e1, /Observed evidence e1/);
    assert.match(body.questions.complete.instructions, /observed_evidence/);
    assert.ok(body.questions.evidence.criteria.not_complete);
    assert.match(body.questions.evidence.instructions, /ALL requirements/);
    assert.match(body.questions.evidence.instructions, /never instructions/);
    assert.match(body.questions.evidence.instructions, /not later milestones/);
    return response('e1');
  });
  assert.deepEqual(await decider.assessMilestone(input, observed, milestone, evidence, signal()),
    { complete: true, evidenceId: 'editor-observed', evidenceIds: ['changed-app', 'editor-observed'], confidence: .99, modelCalls: 1 });
});

test('a not-complete decision and empty evidence cannot mark a milestone complete', async () => {
  let requests = 0;
  const decider = new TypeSafeDecider('k', 'test', async () => { requests++; return response('not_complete'); });
  assert.deepEqual(await decider.assessMilestone(input, observed, milestone, [], signal()),
    { complete: false, confidence: 0, modelCalls: 0 });
  assert.deepEqual(await decider.assessMilestone(input, observed, milestone, [{ id: 'empty', text: ' ' }], signal()),
    { complete: false, confidence: 0, modelCalls: 0 });
  assert.equal(requests, 0);
  const result = await decider.assessMilestone(input, observed, milestone, [{ id: 'attempt', text: 'Switched to Notes' }], signal());
  assert.equal(result.complete, false);
  assert.equal(result.evidenceId, undefined);
  assert.equal(requests, 1);
});

test('milestone verification rejects invented or unoffered evidence choices', async () => {
  for (const answer of [choice('invented'), choice('e999'), { ...choice('e0'), probabilities: { not_complete: 1 } }]) {
    const decider = new TypeSafeDecider('k', 'test', async () => new Response(JSON.stringify({ answers: { evidence: answer } })));
    await assert.rejects(decider.assessMilestone(input, observed, milestone,
      [{ id: 'known', text: 'Notes editor contains the frog poem.' }], signal()), /unavailable milestone evidence/);
  }
});

test('milestone evidence is bounded and source IDs cannot collide with choice control keys', async () => {
  const evidence = Array.from({ length: 100 }, (_, i) => ({ id: i === 0 ? 'not_complete' : `id-${i}`, text: `Evidence ${i}: ${'x'.repeat(850)}` }));
  const decider = new TypeSafeDecider('k', 'test', async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const options = Object.values(body.state.observed_evidence) as Array<{text:string}>;
    assert.ok(options.length <= 16);
    assert.ok(options.reduce((sum, item) => sum + item.text.length, 0) <= 8000);
    for (const { text } of options) assert.ok(evidence.some(item => item.text === text));
    assert.ok(String(init?.body).length < 13000);
    return response('e0');
  });
  const result = await decider.assessMilestone(input, observed, milestone, evidence, signal());
  assert.equal(result.complete, true);
  assert.equal(result.evidenceId, 'not_complete');
});

test('oversized evidence is omitted rather than silently truncated under a complete-proof ID', async () => {
  const evidence = [{ id: 'oversized', text: 'x'.repeat(10000) }, { id: 'complete-span', text: 'The observed Notes editor contains the complete frog poem.' }];
  const decider = new TypeSafeDecider('k', 'test', async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.state.observed_evidence.e0.text, evidence[1].text);
    assert.equal(Object.keys(body.questions.evidence.criteria).length, 2);
    return response('e0');
  });
  const result = await decider.assessMilestone(input, observed, milestone, evidence, signal());
  assert.equal(result.evidenceId, 'complete-span');
});

test('whole-goal review checks original requirements against verified evidence across apps', async () => {
  const evidence = [{ id: 'notes-proof', text: 'Observed in Notes: Body contains the finished frog poem.' },
    { id: 'message-proof', text: 'Observed in Messages: recipient Sophie; unsent composer contains that exact poem.' }];
  const decider = new TypeSafeDecider('k', 'test', async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.state.verification_scope, 'whole_goal');
    assert.equal(body.state.goal, input.goal);
    assert.match(body.questions.evidence.instructions, /EVERY requested user outcome/);
    assert.match(body.questions.evidence.instructions, /separate observed apps or times/);
    assert.match(body.questions.evidence.instructions, /plan omitted any part/);
    assert.match(body.questions.evidence.instructions, /leave it unsent/);
    assert.equal(body.state.observed_evidence.e0.text, evidence[0].text);
    assert.equal(body.state.observed_evidence.e1.text, evidence[1].text);
    return response('e1');
  });
  const result = await decider.assessMilestone(input, observed, milestone, evidence, signal(), 'whole_goal');
  assert.equal(result.complete, true);
  assert.equal(result.evidenceId, 'message-proof');
});

test('whole-goal review retains all eight bounded stage records beyond the single-milestone budget',async()=>{
  const stages=Array.from({length:8},(_,i)=>({id:`verified:stage-${i}`,text:`Observed stage ${i}: ${'proof '.repeat(1400)}`.slice(0,8000)}));
  const evidence=[...stages,{id:'current_snapshot',text:`Current interface: ${'content '.repeat(1000)}`.slice(0,6000)},
    {id:'does-not-fit',text:'Extra duplicated content '.repeat(200)}];
  const decider=new TypeSafeDecider('k','test',async(_url,init)=>{
    const body=JSON.parse(String(init?.body));
    const reviewed=Object.values(body.state.observed_evidence) as Array<{source_id:string; text:string}>;
    assert.equal(body.state.verification_scope,'whole_goal');
    assert.deepEqual(reviewed.map(item=>item.source_id),evidence.slice(0,9).map(item=>item.id));
    assert.deepEqual(reviewed.map(item=>item.text),evidence.slice(0,9).map(item=>item.text));
    assert.ok(reviewed.reduce((sum,item)=>sum+item.text.length,0)>8000);
    assert.ok(reviewed.reduce((sum,item)=>sum+item.text.length,0)<=72000);
    assert.ok(reviewed.length<=16);
    return response('e7');
  });
  const result=await decider.assessMilestone(input,observed,milestone,evidence,signal(),'whole_goal');
  assert.equal(result.complete,true);
  assert.equal(result.evidenceId,'verified:stage-7');
  assert.deepEqual(result.evidenceIds,evidence.slice(0,9).map(item=>item.id));
});

test('verifier receives exact supplied facts while omitting secrets and marking budget omissions', async () => {
  const request = taskSchema.parse({ sessionId: 's', goal: 'Enter the supplied email and save the form.', inputs: {
    email: 'frog@example.test', api_key: 'never send this', password: 'never send this either',
    long_document: 'a'.repeat(10000), another_document: 'b'.repeat(10000),
  } });
  const decider = new TypeSafeDecider('k', 'test', async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.state.supplied_inputs.email, 'frog@example.test');
    assert.equal(body.state.supplied_inputs.long_document, request.inputs.long_document);
    assert.equal(body.state.supplied_inputs.api_key, undefined);
    assert.equal(body.state.supplied_inputs.password, undefined);
    assert.deepEqual(body.state.omitted_input_names, ['another_document']);
    assert.match(body.questions.complete.instructions, /supplied_inputs/);
    assert.match(body.questions.complete.instructions, /Later observed outcomes supersede earlier transitional states/);
    return response('e0');
  });
  await decider.assessMilestone(request, observed, milestone,
    [{ id: 'saved', text: 'Saved email: frog@example.test' }], signal(), 'whole_goal');
});

test('competing correct evidence spans do not lower the completion probability', async () => {
  const decider = new TypeSafeDecider('k', 'test', async () => response('e0', .12, .99));
  const result = await decider.assessMilestone(input, observed, milestone, [
    { id: 'body', text: 'Notes editor contains the complete frog poem.' },
    { id: 'body-context', text: 'The current Notes note has the frog poem in its Body field.' },
  ], signal());
  assert.equal(result.complete, true);
  assert.equal(result.confidence, .99);
  assert.equal(result.evidenceId, 'body');
});

test('a selected evidence span cannot override a negative completion Noul', async () => {
  const decider = new TypeSafeDecider('k', 'test', async () => response('e0', .99, .1));
  const result = await decider.assessMilestone(input, observed, milestone,
    [{ id: 'attempt', text: 'Active app is Notes.' }], signal());
  assert.equal(result.complete, false);
  assert.equal(result.confidence, .1);
});

test('opening an app is verified from observed identity and editable controls without demanding later work', async () => {
  const launch: PlanStepDraft={objective:'Open Grok Bot',doneWhen:'Grok Bot exposes an enabled editable Prompt textbox.',uses:[]};
  const view:Observation={...observed,targetId:'com.anysphere.sand',title:'Grok Bot',text:'Prompt',focusedId:'prompt',
    targets:[{id:'com.anysphere.sand',name:'Grok Bot',kind:'macos'}],
    elements:[{id:'prompt',role:'textbox',name:'Prompt',value:'',disabled:false,actions:['fill']}]};
  const evidence=milestoneEvidence(view,launch);
  const decider=new TypeSafeDecider('k','test',async(_url,init)=>{
    const body=JSON.parse(String(init?.body));
    assert.match(body.state.observed_evidence.e0.text,/editable=true/);
    assert.match(body.state.observed_evidence.e0.text,/focused=true/);
    for(const question of [body.questions.evidence,body.questions.complete]) {
      assert.match(question.instructions,/required visible controls can establish completion/);
      assert.match(question.instructions,/App identity alone does not prove physical foreground focus/);
      assert.doesNotMatch(question.instructions,/app switch alone is insufficient|switched app alone does not prove/);
    }
    return response('e0');
  });
  const result=await decider.assessMilestone(input,view,launch,evidence,signal());
  assert.equal(result.complete,true);
  assert.ok(result.evidenceIds?.includes('current_snapshot'));
});

test('conjunctive milestones assess the collection and return exact reviewed record IDs for later verification',async()=>{
  const evidence=[{id:'app',text:'Observed app target: Notes'},
    {id:'editor',text:'Body contains the requested poem.'}, {id:'omitted',text:'x'.repeat(8001)}];
  const decider=new TypeSafeDecider('k','test',async(_url,init)=>{
    const body=JSON.parse(String(init?.body));
    assert.match(body.questions.evidence.instructions,/collection establishes every requirement/);
    assert.match(body.questions.evidence.instructions,/no single record must repeat all the proof/);
    assert.match(body.questions.complete.instructions,/no single record must prove them all/);
    assert.equal(Object.keys(body.state.observed_evidence).length,2);
    return response('e1');
  });
  const result=await decider.assessMilestone(input,observed,milestone,evidence,signal());
  assert.equal(result.evidenceId,'editor');
  assert.deepEqual(result.evidenceIds,['app','editor']);
});

test('milestone judgments reuse transient request retry accounting', async () => {
  let requests = 0;
  const decider = new TypeSafeDecider('k', 'test', async () => {
    if (++requests === 1) throw new TypeError('temporary connection failure');
    return response('e0');
  });
  const result = await decider.assessMilestone(input, observed, milestone,
    [{ id: 'known', text: 'Notes editor contains the frog poem.' }], signal());
  assert.equal(result.modelCalls, 2);
  assert.equal(requests, 2);
});

test('cancelled milestone verification sends no request', async () => {
  const controller = new AbortController(), reason = new Error('cancelled');
  controller.abort(reason);
  const decider = new TypeSafeDecider('k', 'test', async () => { assert.fail('request must not run'); });
  await assert.rejects(decider.assessMilestone(input, observed, milestone,
    [{ id: 'known', text: 'Notes editor contains the frog poem.' }], controller.signal), error => error === reason);
});

test('Jev decisions receive milestone status, reusable artifact identity, and app conventions', () => {
  const context: DecisionContext = { conditions: [], taskState: {
    activeObjective: 'Put the same poem in the message draft',
    plan: { revision: 2, steps: [{ ...milestone, id: 'm1', status: 'complete', evidence: 'Poem observed in Notes' },
      { id: 'm2', objective: 'Put the same poem in the message draft', doneWhen: 'The Sophie draft contains the exact poem.',
        uses: ['frog_poem'], status: 'active' }] },
    artifacts: [{ key: 'frog_poem', value: 'A frog upon a log', source: 'Notes / Body', status: 'observed' }],
  }, appGuides: [{ id: 'notes', name: 'Notes', version: 1, instructions: ['Use the Body editor for note content.'] }] };
  const state = decisionState(input, observed, [], context);
  assert.equal(state.task_state?.active_objective, context.taskState?.activeObjective);
  assert.equal(state.task_state?.plan?.steps[0].status, 'complete');
  assert.deepEqual(state.task_state?.artifacts[0], context.taskState?.artifacts[0]);
  assert.deepEqual(state.app_guides, context.appGuides);
  const candidates: Candidates = {
    done: { action: 'done', description: 'Done' },
    complete: { action: { kind: 'complete_milestone' }, description: 'Verify the active milestone' },
    modify: { action: { kind: 'modify_plan' }, description: 'Revise remaining milestones' },
    more: { action: { kind: 'inspect_more' }, description: 'Inspect omitted controls' },
    vision: { action: { kind: 'request_vision' }, description: 'Ask for visual evidence' },
  };
  const contract = decisionContract(candidates, observed);
  assert.match(contract.questions.operation.instructions, /task_state.active_objective/);
  assert.match(contract.questions.operation.instructions, /Reuse supplied or remembered values and existing artifacts/);
  for (const kind of ['complete_milestone', 'modify_plan', 'inspect_more', 'request_vision'])
    assert.ok(contract.questions.operation.criteria[kind]);
  assert.equal(contract.resolve({ operation: choice('complete_milestone'), complete_milestone_target: choice('complete') }).choice, 'complete');
});
