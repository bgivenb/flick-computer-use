import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskRunner} from '../src/core/runner.js';
import {taskSchema, type Driver, type TextHelper} from '../src/core/types.js';
test('Jev chooses the second LLM proposal; drafting to memory never types',async()=>{
 let writes=0, selected=false;
 const driver:Driver={id:'s',kind:'browser',label:'test',observe:async()=>({id:'o',sessionId:'s',kind:'browser',title:'Source',text:'Source facts',elements:[],truncated:false,capturedAt:Date.now()}),
 act:async()=>{writes++},close:async()=>{},screenshot:async()=>Buffer.alloc(0)};
 const helper:TextHelper={compose:async()=>({status:'text',text:'Wrong first draft',candidates:['Wrong first draft','Source-grounded second draft']}),repair:async()=>''};
 const runner=new TaskRunner({decide:async(_i,_o,c)=>{
   const choice=c.proposal_1?'proposal_1':selected?'blocked':'draft';
   if(choice==='proposal_1')selected=true;
   return {choice,confidence:1,probability:1,latencyMs:0};
 }},helper);
 const r=await runner.wait(runner.start(driver,taskSchema.parse({sessionId:'s',goal:'Draft a summary',planning:'off',until:[{kind:'text',text:'Never visible'}]})).id,1000);
 assert.ok(r.artifacts.some(a=>a.value==='Source-grounded second draft'));
 assert.ok(!r.artifacts.some(a=>a.value==='Wrong first draft'));
 assert.equal(writes,0);
});

test('rejecting every proposal retains and types none',async()=>{
 let writes=0;
 const driver:Driver={id:'s',kind:'browser',label:'test',observe:async()=>({id:'o',sessionId:'s',kind:'browser',title:'Source',text:'Source facts',elements:[],truncated:false,capturedAt:Date.now()}),
 act:async()=>{writes++},close:async()=>{},screenshot:async()=>Buffer.alloc(0)};
 const helper:TextHelper={compose:async()=>({status:'text',text:'Unsupported claim',candidates:['Unsupported claim','Another unsupported claim']}),repair:async()=>''};
 const runner=new TaskRunner({decide:async(_i,_o,c)=>({choice:c.reject?'reject':'draft',confidence:1,probability:1,latencyMs:0})},helper);
 const r=await runner.wait(runner.start(driver,taskSchema.parse({sessionId:'s',goal:'Draft a factual summary',maxSteps:2,planning:'off',until:[{kind:'text',text:'Never visible'}]})).id,1000);
 assert.equal(r.artifacts.length,0);assert.equal(writes,0);
 assert.ok(r.events.some(e=>e.effect?.includes('rejected')));
});
