import test from 'node:test';
import assert from 'node:assert/strict';
import { completeStep, createPlan, milestoneEvidence } from '../src/core/task-state.js';
import type { Observation, PlanStepDraft } from '../src/core/types.js';

const milestone: PlanStepDraft = {objective:'Open the chat app',doneWhen:'The chat app exposes an enabled editable Prompt field.',uses:[]};
const observed = ():Observation => ({id:'o',revision:'r',sessionId:'s',kind:'desktop',targetId:'com.example.chat',
  targets:[{id:'com.example.chat',name:'Chat App',kind:'macos'}], title:'Chat',text:'Prompt',capturedAt:0,truncated:false,
  focusedId:'prompt',elements:[{id:'prompt',role:'textbox',name:'Prompt',value:'',actions:['fill'],disabled:false}]});

test('an empty composer supplies app identity, enabled, editable, and observed focus evidence',()=>{
  const evidence=milestoneEvidence(observed(),milestone), snapshot=evidence.find(item=>item.id==='current_snapshot')!.text;
  assert.match(snapshot,/Observed app target: com\.example\.chat \(Chat App\)/);
  for(const proof of [snapshot,evidence.find(item=>item.id==='element:prompt')!.text]) {
    assert.match(proof,/enabled=true; disabled=false; editable=true; fill_supported=true; focused=true/);
    assert.match(proof,/actions=\["fill"\]/);
  }
  assert.doesNotMatch(snapshot,/Active app|foreground/i);
});

test('disabled and read-only controls do not become editable from their textbox role or label',()=>{
  const view=observed();view.focusedId=undefined;
  view.elements[0].disabled=true;
  view.elements.push({id:'readonly',role:'textbox',name:'Prompt read-only',value:'Prior response',actions:[],disabled:false,focused:false});
  const evidence=milestoneEvidence(view,milestone);
  assert.match(evidence.find(item=>item.id==='element:prompt')!.text,/enabled=false; disabled=true; editable=false; fill_supported=true; focused=unknown/);
  assert.match(evidence.find(item=>item.id==='element:readonly')!.text,/enabled=true; disabled=false; editable=false; fill_supported=false; focused=false/);
});

test('an app catalog is not proof that its listed apps or controls were observed',()=>{
  const view=observed();view.targetId=undefined;
  assert.deepEqual(milestoneEvidence(view,milestone),[]);
});

test('completed milestones retain exact reviewed records beyond the short display excerpt',()=>{
  const plan=createPlan([milestone]);
  const records=[{id:'app',text:'Observed app: com.example.chat'},
    {id:'composer',text:`Prompt: ${'x'.repeat(1700)}\nenabled=true; editable=true`}];
  completeStep(plan,records.map(item=>item.text).join('\n'),records);
  assert.match(plan.steps[0].evidence!,/Evidence excerpt truncated/);
  assert.deepEqual(plan.steps[0].evidenceRecords,records);
  const revised=createPlan([milestone,{objective:'Write a poem',doneWhen:'A new poem is visible',uses:[]}],plan);
  assert.deepEqual(revised.steps[0].evidenceRecords,records);
});

test('stored verification records stay bounded without labeling a truncated record as complete proof',()=>{
  const plan=createPlan([milestone]);
  const records=[{id:'oversize',text:'x'.repeat(8001)}, {id:'one',text:'x'.repeat(7000)},
    {id:'one',text:'unreviewed replacement'}, {id:'two',text:'y'.repeat(1000)}, {id:'three',text:'z'}];
  completeStep(plan,'Display only',records);
  assert.deepEqual(plan.steps[0].evidenceRecords,[records[1],records[3]]);
  const many=createPlan([milestone]);
  completeStep(many,'Display only',Array.from({length:20},(_,i)=>({id:`e${i}`,text:`Exact record ${i}`})));
  assert.equal(many.steps[0].evidenceRecords?.length,16);
});
