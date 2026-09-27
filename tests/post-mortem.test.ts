import test from 'node:test';
import assert from 'node:assert/strict';
import { postMortem, type ReviewRun } from '../src/core/post-mortem.js';
import { TaskRunner } from '../src/core/runner.js';
import { WorkflowRunner, workflowSchema } from '../src/core/workflow.js';
import { taskSchema, type Driver } from '../src/core/types.js';
const run=(overrides:Partial<ReviewRun>={}):ReviewRun=>({id:'task',status:'succeeded',metrics:{},events:[],...overrides});
test('running snapshots have no postmortem; clean terminal runs request review without a guide write',()=>{
  assert.equal(postMortem('running',[run()]),undefined);
  const review=postMortem('succeeded',[run()])!;
  assert.deepEqual(review.signals,[]);assert.equal(review.guidanceOptional,true);
  assert.match(review.instruction,/without a guide write or extra tool call/);
});
test('success still exposes recovery and verification issues without retaining personal action text',()=>{
  const review=postMortem('succeeded',[run({metrics:{actionRecoveries:2,staleRetries:1},continuedFrom:'old',handoff:{kind:'vision'},events:[{step:3,effect:'SECRET unchanged: result'},{step:4,effect:'uncertain: sent'}],guides:[{id:'chat',version:2}]})])!;
  assert.deepEqual(review.signals.map(s=>s.kind),['action_recoveries','stale_observations','continued_run','handoff','unverified_action_effects']);
  assert.deepEqual(review.signals.at(-1)?.steps,[3,4]);assert.deepEqual(review.guideIds,['chat']);
  assert.ok(!JSON.stringify(review).includes('SECRET'));
});
test('interruption alone is not labeled an issue; workflow signals retain stage task identity',()=>{
  assert.deepEqual(postMortem('interrupted',[run({status:'interrupted'})])!.signals,[]);
  const review=postMortem('blocked',[run(),run({id:'second',status:'blocked'})])!;
  assert.deepEqual(review.signals,[{taskId:'second',kind:'blocked'}]);
});
test('runner and workflow return the review in terminal snapshots without additional decisions',async()=>{
  let calls=0;
  const runner=new TaskRunner({decide:async()=>{calls++;throw Error('not needed');}});
  const driver:Driver={id:'fixture',kind:'macos',label:'Fixture',observe:async()=>({id:'o',sessionId:'fixture',kind:'macos',title:'Fixture',text:'Done',elements:[],truncated:false,capturedAt:Date.now()}),act:async()=>{},close:async()=>{},screenshot:async()=>Buffer.alloc(0)};
  const input=taskSchema.parse({sessionId:driver.id,goal:'Observe Done',until:[{kind:'text',text:'Done'}]});
  const task=await runner.wait(runner.start(driver,input).id,1000);
  assert.equal(task.status,'succeeded');assert.equal(task.postMortem?.reviewer,'calling_agent');
  assert.deepEqual(runner.get(task.id).postMortem,task.postMortem);
  const workflows=new WorkflowRunner(runner,async()=>({...driver,switchApp:async()=>{}}));
  const flow=workflows.start(workflowSchema.parse({stages:[{bundleId:'fixture',goal:'Observe Done',until:[{kind:'text',text:'Done'}]}]}));
  const result=await workflows.wait(flow.id,1000);
  assert.equal(result.status,'succeeded');assert.equal(result.postMortem?.reviewer,'calling_agent');assert.equal(calls,0);
});
