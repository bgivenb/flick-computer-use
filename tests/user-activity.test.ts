import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskRunner } from '../src/core/runner.js';
import { UserActivityError, UserActivityMonitorError, watchUserActivity, desktopActivityWatch, type ActivityWatch } from '../src/core/user-activity.js';
import { taskSchema, type Driver, type Observation, type Decider, type TextHelper } from '../src/core/types.js';
import { WorkflowRunner, workflowSchema } from '../src/core/workflow.js';
const choice=(choice:string)=>({choice,confidence:1,probability:1,latencyMs:1});
function latch<T=void>() {let resolve!:(x:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
function fixture() {
  let value='',writes=0;
  const driver:Driver={id:'d',kind:'macos',userActivityScope:'desktop',label:'fixture',
    observe:async():Promise<Observation>=>({id:'o',revision:value,sessionId:'d',kind:'macos',targetId:'fixture',title:'Fixture',text:value,elements:[
      {id:'field',role:'textbox',name:'Body',value,multiline:true,actions:['fill'],disabled:false},
      {id:'send',role:'button',name:'Send',actions:['click'],disabled:false}],truncated:false,capturedAt:Date.now()}),
    act:async action=>{writes++;if(action.kind==='fill')value=action.value;},screenshot:async()=>Buffer.alloc(0),close:async()=>{}};
  const input=taskSchema.parse({sessionId:'d',goal:'Write known text',inputs:{body:'Frog poem'},until:[{kind:'field',name:'Body',value:'Frog poem'}]});
  let interrupt:(reason:Error)=>void=()=>{throw Error('not armed');};let stops=0,starts=0;
  const watch:ActivityWatch=async(_driver,_signal,notify)=>{starts++;interrupt=notify;return()=>{stops++;};};
  return {driver,input,watch,interrupt:()=>interrupt(new UserActivityError('mouse')),writes:()=>writes,starts:()=>starts,stops:()=>stops};
}

test('takeover during a model request aborts it, emits no input, and explicit Continue rearms',async()=>{
  const e=fixture(),entered=latch();let count=0;
  const decider:Decider={decide:async(_i,_o,c,_h,signal)=>{
    if(count++===0){entered.resolve();await new Promise<void>((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}
    return choice(Object.keys(c).find(k=>k.startsWith('fill:'))!);
  }};
  const runner=new TaskRunner(decider,undefined,{userActivity:e.watch});
  const start=runner.start(e.driver,e.input);await entered.promise;e.interrupt();
  const stopped=await runner.wait(start.id,1000);
  assert.equal(stopped.status,'interrupted');assert.equal(e.writes(),0);assert.equal(e.stops(),1);
  await delay(15);assert.equal(e.starts(),1,'never auto-resume');
  const next=runner.continue(e.driver,start.id,{});const result=await runner.wait(next.id,1000);
  assert.equal(result.status,'succeeded',result.reason);assert.equal(e.starts(),2);assert.equal(e.writes(),1);
});

test('a writing helper that returns late cannot write after human interruption',async()=>{
  const e=fixture(),entered=latch(),release=latch();
  const helper:TextHelper={compose:async()=>{entered.resolve();await release.promise;return{status:'text',text:'Frog poem'};},repair:async()=>''};
  const runner=new TaskRunner({decide:async()=>choice('compose:field')},helper,{userActivity:e.watch});
  const start=runner.start(e.driver,e.input);await entered.promise;e.interrupt();
  assert.equal(runner.busy(e.driver.id),true);release.resolve();
  const result=await runner.wait(start.id,1000);assert.equal(result.status,'interrupted');assert.equal(e.writes(),0);
});

test('interruption during dispatched Send preserves ownership and pending receipt across Continue',async()=>{
  const e=fixture(),entered=latch(),release=latch();let sends=0;
  e.driver.act=async()=>{sends++;entered.resolve();await release.promise;};
  const runner=new TaskRunner({decide:async(_i,_o,c)=>choice(c['click:send']?'click:send':'blocked')},undefined,{userActivity:e.watch});
  const start=runner.start(e.driver,e.input);await entered.promise;e.interrupt();
  assert.equal(runner.busy(e.driver.id),true);assert.throws(()=>runner.start(e.driver,e.input),/already running/);
  release.resolve();const result=await runner.wait(start.id,1000);
  assert.equal(result.status,'interrupted');assert.equal(result.pendingActions?.length,1);
  const again=runner.continue(e.driver,start.id,{});assert.equal((await runner.wait(again.id,1000)).status,'blocked');
  assert.equal(sends,1,'no duplicate submit after takeover');
});

test('interruption during the observation after Send also preserves its receipt',async()=>{
  const e=fixture(),entered=latch(),release=latch();let sends=0,held=false;
  const observe=e.driver.observe;
  e.driver.act=async()=>{sends++;};
  e.driver.observe=async()=>{
    if(sends && !held) {held=true;entered.resolve();await release.promise;}
    return observe();
  };
  const runner=new TaskRunner({decide:async(_i,_o,c)=>choice(c['click:send']?'click:send':'blocked')},undefined,{userActivity:e.watch});
  const start=runner.start(e.driver,e.input);await entered.promise;e.interrupt();release.resolve();
  const result=await runner.wait(start.id,1000);assert.equal(result.status,'interrupted');assert.equal(result.pendingActions?.length,1);
  const next=runner.continue(e.driver,start.id,{});await runner.wait(next.id,1000);assert.equal(sends,1);
});

test('monitor must be ready before observation and startup failure starts no action',async()=>{
  const e=fixture(),ready=latch();let observed=0;e.driver.observe=async()=>{observed++;throw Error('must not observe');};
  const runner=new TaskRunner({decide:async()=>choice('done')},undefined,{userActivity:async()=>{await ready.promise;throw new UserActivityMonitorError('permission required');}});
  const start=runner.start(e.driver,e.input);assert.equal(observed,0);ready.resolve();
  const result=await runner.wait(start.id,1000);assert.equal(result.status,'blocked');assert.match(result.reason!,/permission/);assert.equal(observed,0);
});

test('whole workflow is monitored before opening its first app',async()=>{
  const ready=latch();let opened=0;let notify!:(e:Error)=>void;
  const watch:ActivityWatch=async(_d,_s,n)=>{notify=n;await ready.promise;return()=>{};};
  const workflows=new WorkflowRunner(new TaskRunner({decide:async()=>choice('done')}),async()=>{opened++;throw Error('must not open');},watch);
  const input=workflowSchema.parse({stages:[{bundleId:'fixture',goal:'Do a task',until:[{kind:'text',text:'done'}]}]});
  const task=workflows.start(input);notify(new UserActivityError('keyboard'));ready.resolve();
  const result=await workflows.wait(task.id,1000);assert.equal(result.status,'interrupted');assert.equal(opened,0);
});

test('workflow takeover aborts its current model call and prevents the next app switch',async()=>{
  const e=fixture(),entered=latch();let notify!:(e:Error)=>void;
  let switched=0,closed=0,stopped=0,childWatches=0;
  const driver={...e.driver,switchApp:async()=>{switched++;},close:async()=>{closed++;}};
  const tasks=new TaskRunner({decide:async(_i,_o,_c,_h,signal)=>{
    entered.resolve();await new Promise<void>((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    return choice('done');
  }},undefined,{userActivity:async()=>{childWatches++;return()=>{};}});
  const workflows=new WorkflowRunner(tasks,async()=>driver,async(_d,_s,n)=>{notify=n;return()=>{stopped++;};});
  const task=workflows.start(workflowSchema.parse({stages:[
    {bundleId:'first',goal:'Fill the body',until:[{kind:'text',text:'done'}]},
    {bundleId:'second',goal:'Another stage',until:[{kind:'text',text:'finished'}]},
  ]}));
  await entered.promise;notify(new UserActivityError('keyboard'));
  const result=await workflows.wait(task.id,1000);
  assert.equal(result.status,'interrupted');assert.equal(result.stages[0].result.status,'interrupted');
  assert.equal(e.writes(),0);assert.equal(switched,0);assert.equal(closed,1);assert.equal(stopped,1);
  assert.equal(childWatches,0,'one monitor spans the whole workflow');assert.equal(workflows.busy(),false);
});

test('a monitor failure during a running task stops the model and reports a recoverable block',async()=>{
  const e=fixture(),entered=latch();let notify!:(e:Error)=>void;
  const runner=new TaskRunner({decide:async(_i,_o,_c,_h,signal)=>{
    entered.resolve();await new Promise<void>((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));return choice('done');
  }},undefined,{userActivity:async(_d,_s,n)=>{notify=n;return()=>{};}});
  const task=runner.start(e.driver,e.input);await entered.promise;notify(new UserActivityMonitorError('Monitor stopped.'));
  const result=await runner.wait(task.id,1000);assert.equal(result.status,'blocked');assert.equal(result.reason,'Monitor stopped.');
  assert.equal(e.writes(),0);assert.equal(runner.busy(e.driver.id),false);
});

async function fakeMonitor(t:any,body:string) {
  const dir=await mkdtemp(join(tmpdir(),'flick-activity-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'monitor');await writeFile(path,`#!${process.execPath}\n${body}\n`);await chmod(path,0o700);return path;
}
test('watcher reports only activity metadata and cleans up after user input',async t=>{
  const path=await fakeMonitor(t,`console.log(JSON.stringify({type:'ready'}));setTimeout(()=>{console.log(JSON.stringify({type:'activity',kind:'keyboard',key:'never retain me'}));},30);process.stdin.resume();`);
  const detected=latch<Error>(),controller=new AbortController();
  const stop=await watchUserActivity(path,controller.signal,error=>{detected.resolve(error);controller.abort(error);});
  const error=await detected.promise;assert.ok(error instanceof UserActivityError);assert.equal(error.kind,'keyboard');assert.ok(!JSON.stringify(error).includes('never retain'));stop();
});
test('unexpected monitor exit after readiness interrupts the task',async t=>{
  const path=await fakeMonitor(t,`console.log(JSON.stringify({type:'ready'}));setTimeout(()=>process.exit(2),30);`);
  const fault=latch<Error>();const stop=await watchUserActivity(path,new AbortController().signal,e=>fault.resolve(e));
  assert.ok(await fault.promise instanceof UserActivityMonitorError);stop();
});
test('headless automation does not spawn the desktop monitor',async()=>{
  const stop=await desktopActivityWatch('/does/not/exist')({kind:'browser',userActivityScope:'headless'},new AbortController().signal,()=>assert.fail());stop();
});
test('missing native watcher fails before readiness',async()=>{
  await assert.rejects(watchUserActivity('/does/not/exist',new AbortController().signal,()=>assert.fail()),UserActivityMonitorError);
});
