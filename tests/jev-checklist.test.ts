import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskRunner} from '../src/core/runner.js';
import {taskSchema,type Driver} from '../src/core/types.js';
const driver:Driver={id:'checklist',kind:'browser',label:'test',observe:async()=>({id:'o',sessionId:'checklist',kind:'browser',title:'Plans',text:'Plans $20/month',elements:[],truncated:false,capturedAt:Date.now()}),act:async()=>assert.fail('no UI action expected'),close:async()=>{},screenshot:async()=>Buffer.alloc(0)};
test('Jev advances every milestone with missing artifacts and no secondary approval',async()=>{
 let calls=0;
 const runner=new TaskRunner({decide:async()=>{calls++;return {choice:'complete_milestone',confidence:.9,probability:.9,latencyMs:0}},assessMilestone:async()=>assert.fail('Removed verifier must never be called')});
 const task=runner.start(driver,taskSchema.parse({sessionId:driver.id,goal:'Read then draft',plan:[{objective:'Read',doneWhen:'Read',produces:'text',uses:[]},{objective:'Draft',doneWhen:'Draft',uses:['text']}]}));
 const result=await runner.wait(task.id,1000);
 assert.equal(result.status,'succeeded');assert.equal(calls,2);
 assert.equal(result.completionReportedBy,'jev');assert.notEqual(result.wholeGoalVerified,true);
 assert.deepEqual(result.plan?.steps.map(s=>s.status),['complete','complete']);
});
test('Jev completion cannot override an explicit user-supplied until condition',async()=>{
 const runner=new TaskRunner({decide:async()=>({choice:'done',confidence:1,probability:1,latencyMs:0})});
 const result=await runner.wait(runner.start(driver,taskSchema.parse({sessionId:driver.id,goal:'Save',until:[{kind:'text',text:'Saved'}]})).id,1000);
 assert.equal(result.status,'blocked');assert.match(result.reason??'',/user-supplied/);
});
test('emergency stop bypasses confidence and recovery and dispatches no UI action',async()=>{
 let repairs=0;
 const runner=new TaskRunner({decide:async(_i,_o,c)=>{assert.ok(c.emergency_stop);return {choice:'emergency_stop',confidence:.01,probability:.01,latencyMs:0}}},
 {compose:async()=>assert.fail('no writer call'),repair:async()=>{repairs++;return 'retry'}});
 const input=taskSchema.parse({sessionId:driver.id,goal:'Read pricing',until:[{kind:'text',text:'Not yet'}]});
 assert.equal(input.minConfidence,.1);
 const result=await runner.wait(runner.start(driver,input).id,1000);
 assert.equal(result.status,'cancelled');assert.equal(repairs,0);assert.equal(result.steps,0);
 assert.match(result.reason??'',/EMERGENCY STOP/);
});
