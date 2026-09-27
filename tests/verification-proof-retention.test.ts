import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRunner } from '../src/core/runner.js';
import { taskSchema, type Driver, type Observation } from '../src/core/types.js';

test('Jev completion preserves an observation snapshot without calling a separate verifier',async()=>{
  const observation:Observation={id:'o',sessionId:'proof',kind:'browser',title:'Fixture',text:'A new response is visible.',elements:[{id:'response',role:'text',name:'Assistant response',value:'Frogs sing softly beside the pond.',disabled:false,actions:[]}],truncated:false,capturedAt:Date.now()};
  const driver:Driver={id:'proof',kind:'browser',label:'Fixture',observe:async()=>observation,act:async()=>assert.fail('no action needed'),close:async()=>{},screenshot:async()=>Buffer.alloc(0)};
  let finalChecks=0;
  const runner=new TaskRunner({decide:async()=>({choice:'complete_milestone',confidence:1,probability:1,latencyMs:0}),assessMilestone:async(_input,_obs,_step,evidence,_signal,scope)=>{
    if(scope==='whole_goal') {
      finalChecks++;
      const prior=evidence.find(e=>e.id.startsWith('verified:'))!;
      assert.match(prior.text,/Observed window title: Fixture/);
      assert.match(prior.text,/Frogs sing softly beside the pond/);
      return {complete:true,confidence:1,evidenceId:prior.id};
    }
    return {complete:true,confidence:1,evidenceId:'title',evidenceIds:['title','element:response']};
  }});
  const task=await runner.wait(runner.start(driver,taskSchema.parse({sessionId:driver.id,goal:'Observe the poem response',plan:[{objective:'Observe the response in Fixture',doneWhen:'The response is visible in Fixture',uses:[]}]})).id,1000);
  assert.equal(task.status,'succeeded',task.reason);assert.equal(finalChecks,0);
  assert.ok(task.plan!.steps[0].evidenceRecords!.some(e=>e.text.includes('Frogs sing softly')));
});
