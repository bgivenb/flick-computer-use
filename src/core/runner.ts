import { postMortem, type PostMortem } from './post-mortem.js';
import { UserActivityError, UserActivityMonitorError, type ActivityWatch } from './user-activity.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppGuideStore } from './app-guides.js';
import { activeStep, artifactKey, artifactVisible, completeStep, completedPlan, createPlan, expectedResult, isSubmission, milestoneEvidence, retainArtifact, semanticAction, taskInputs } from './task-state.js';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { BlockedError, candidatesFor, RecoverableActionError, StaleObservationError, TextHelperUnavailableError, verify, type TaskArtifact, type TaskPlan, type DecisionContext, type Action, type Condition, type Decider, type DecisionTrace, type Driver, type Observation, type TaskInput, type TextHelper } from './types.js';
import { describeCondition, describeEffect, focusView, progressDigest } from './scene.js';
import { copyObservedText, wantsTextCopy, withCopyableText } from './copy-text.js';

export type Status = 'running' | 'succeeded' | 'blocked' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
export interface Task {
  id: string; sessionId: string; status: Status; startedAt: number; finishedAt?: number;
  steps: number; reason?: string; verification?: ReturnType<typeof verify>;
  request: { goal: string; until: Condition[]; inputNames: string[] };
  lastDecision?: { action: string; confidence: number; probability: number };
  metrics: { elapsedMs: number; observeMs: number; decisionMs: number; executionMs: number; modelCalls: number; helperCalls: number; helperMs: number; staleRetries: number; actionRecoveries: number };
  events: Array<{ step: number; action: string; confidence?: number; durationMs: number; effect?: string }>;
  trace: Array<DecisionTrace & { step: number; latencyMs: number; elements: number }>;
  lastObservation?: Observation;
  memory?: Observation['memory'];
  completionReportedBy?: 'jev';
  continuedFrom?: string;
  plan?: TaskPlan; artifacts: TaskArtifact[]; history: string[];
  guides?: Array<{id:string; name:string; version:number}>;
  handoff?: {kind:'vision'; reason:string};
  interruption?: {kind: 'mouse' | 'keyboard' | 'scroll'; detectedAt:number};
  journal?: string; wholeGoalVerified?: boolean; replanReason?: string;
  postMortem?: PostMortem;
  pendingActions?: Array<{key:string; targetId?:string; stage:string; submission?:boolean}>;
}
export class TaskRunner {
  private tasks = new Map<string, Task>();
  private controllers = new Map<string, AbortController>();
  private completions = new Map<string, Promise<void>>();
  private owners = new Map<string, string>();
  private inputs = new Map<string, TaskInput>();
  constructor(private decider: Decider, private textHelper?: TextHelper, private services: {guides?: AppGuideStore; traceDir?: string; userActivity?: ActivityWatch} = {}) {}
  busy(sessionId: string) { return this.owners.has(sessionId); }
  start(driver: Driver, input: TaskInput, seed?: Pick<Task, 'plan' | 'artifacts' | 'history' | 'pendingActions' | 'wholeGoalVerified' | 'replanReason'>, parentSignal?: AbortSignal) {
    if (this.busy(driver.id)) throw new Error('A task is already running in this session. Cancel it or wait.');
    this.prune();
    const task: Task = { id: randomUUID(), sessionId: driver.id, status: 'running', startedAt: Date.now(), steps: 0,
      request: { goal: input.goal, until: structuredClone(input.until), inputNames: Object.keys(input.inputs) },
      metrics: { elapsedMs: 0, observeMs: 0, decisionMs: 0, executionMs: 0, modelCalls: 0, helperCalls: 0, helperMs: 0, staleRetries: 0, actionRecoveries: 0 }, events: [], trace: [], artifacts: structuredClone(seed?.artifacts ?? []), history: structuredClone(seed?.history ?? []), plan: seed?.plan ? structuredClone(seed.plan) : undefined, pendingActions: structuredClone(seed?.pendingActions ?? []), replanReason: seed?.replanReason };
    const controller = new AbortController();
    this.tasks.set(task.id, task);
    this.inputs.set(task.id, structuredClone(input));
    this.controllers.set(task.id, controller);
    this.owners.set(driver.id, task.id);
    this.completions.set(task.id, this.run(driver, input, task, controller, parentSignal));
    return this.get(task.id);
  }
  continue(driver: Driver, id: string, inputs: Record<string, string>, guidance = '', minConfidence?: number) {
    const previous = this.get(id);
    if (previous.sessionId !== driver.id) throw new Error('Continue in the original session.');
    if (previous.status === 'running' || previous.status === 'succeeded') throw new Error('Only an unfinished, stopped task can be continued.');
    const original = this.inputs.get(id)!;
    const merged = { ...original.inputs, ...inputs };
    if (Object.keys(merged).length > 20) throw new Error('Supply at most 20 input values.');
    const goal = guidance ? `${original.goal}\nAdditional guidance: ${guidance}` : original.goal;
    if (goal.length > 6000) throw new Error('Combined goal and guidance exceed 6000 characters.');
    if ((guidance.trim() || Object.keys(inputs).length) && previous.plan) previous.replanReason = `The user added guidance or changed input values. Preserve completed-action receipts; revise the unfinished work to address this correction explicitly. Use new artifact keys for revised content. New guidance takes precedence. Latest correction: ${guidance.trim() || 'Input values were updated.'}`;
    const result = this.start(driver, { ...original, inputs: merged, goal, minConfidence: minConfidence ?? original.minConfidence }, previous);
    this.tasks.get(result.id)!.continuedFrom = id;
    return this.get(result.id);
  }
  get(id: string, includeObservation = false) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Unknown task ID. Tasks live only for this MCP process.');
    const result = structuredClone(task);
    if(result.status !== 'running') result.postMortem=postMortem(result.status,[result]);
    result.metrics.elapsedMs = (result.finishedAt ?? Date.now()) - result.startedAt;
    if (!includeObservation) delete result.lastObservation;
    return result;
  }
  async wait(id: string, waitMs = 0, includeObservation = false) {
    this.get(id);
    if (waitMs > 0) {
      const timer = new AbortController();
      await Promise.race([this.completions.get(id), delay(Math.min(waitMs, 20000), undefined, { signal: timer.signal }).catch(() => {})]);
      timer.abort();
    }
    return this.get(id, includeObservation);
  }
  cancel(id: string) {
    this.get(id);
    this.controllers.get(id)?.abort(new Error('Task cancelled.'));
    return this.get(id);
  }
  async close() {
    for (const controller of this.controllers.values()) controller.abort(new Error('Server stopping.'));
    await Promise.allSettled(this.completions.values());
  }
  private prune() {
    if (this.tasks.size < 100) return;
    for (const [id, task] of this.tasks) {
      if (task.status !== 'running') { this.tasks.delete(id); this.completions.delete(id); this.inputs.delete(id); }
      if (this.tasks.size < 80) break;
    }
  }
  private async run(driver: Driver, input: TaskInput, task: Task, controller: AbortController, parentSignal?: AbortSignal) {
    let deadline = false;
    let stopActivity: (() => void) | undefined;
    const interrupted = (reason:Error) => {
      if(controller.signal.aborted) return;
      if(reason instanceof UserActivityError) task.interruption={kind:reason.kind,detectedAt:reason.detectedAt};
      controller.abort(reason);
    };
    const parentAborted=()=>interrupted(parentSignal!.reason instanceof Error ? parentSignal!.reason : new Error('Task cancelled.'));
    parentSignal?.addEventListener('abort',parentAborted,{once:true});
    if(parentSignal?.aborted) parentAborted();
    const timeout = setTimeout(() => { deadline = true; controller.abort(new Error('Task deadline exceeded.')); }, input.timeoutMs);
    const signal = controller.signal, started = performance.now(), history = task.history;
    const attempts = new Map<string, number>();
    const failed = new Map<string, {count:number; step:number}>();
    let staleStreak = 0, idle = 0, repairs = 0, expanded = false, initialized = Boolean(task.plan), clipboardStart: number | undefined;
    let pending: Observation | undefined;
    let lastFailure: {guideId:string; instructionId:string} | undefined;
    let previous: {action:Action; key:string; before:Observation; digest:string; event:Task['events'][number]; provisionalReceipt?:NonNullable<Task['pendingActions']>[number]} | undefined;
    const journal: Array<{step:number; action:string; durationMs:number; status?:string; category?:string}> = [];
    const note = (value:string) => { if (history.at(-1) !== value) history.push(value); if (history.length > 80) history.splice(0,history.length - 80); };
    const contextFor = async (observation:Observation):Promise<DecisionContext> => {
      const appGuides = await this.services.guides?.forObservation(observation).catch(() => []) ?? [];
      task.guides = appGuides.map(({id,name,version}) => ({id,name,version}));
      return {conditions: verify(observation,input.until).checks.map(c => ({condition:describeCondition(c.condition,observation.targets),met:c.passed})),
        taskState:{plan:task.plan,artifacts:task.artifacts,activeObjective:activeStep(task.plan)?.objective}, appGuides,
        ...(observation.clipboard ? {clipboard:{hasImage:observation.clipboard.hasImage,changedSinceStart:observation.clipboard.changeCount !== clipboardStart}} : {})};
    };
    const repair = async (observation:Observation, reason:string) => {
      expanded = true; note(reason);
      if (!this.textHelper || repairs >= 4) return false;
      repairs++;
      const t = performance.now(); task.metrics.helperCalls++;
      try {
        const hint = await this.textHelper.repair(taskInputs(input,observation,task.artifacts),observation,history,signal,await contextFor(observation));
        signal.throwIfAborted(); if (hint) note(`Recovery guidance: ${hint}`);
      } catch { signal.throwIfAborted(); }
      finally { task.metrics.helperMs += performance.now() - t; }
      return true;
    };
    const draftPlan = async (observation:Observation, reason?:string) => {
      if (!this.textHelper?.plan) throw new BlockedError('Plan revision needs a configured text helper.');
      const t = performance.now();
      try {
        const result = await this.textHelper.plan(taskInputs(input,observation,task.artifacts),observation,task.plan,reason,signal,await contextFor(observation));
        signal.throwIfAborted(); task.metrics.helperCalls += result.modelCalls ?? 1;
        task.plan = createPlan(result.steps,task.plan,input.inputs); task.wholeGoalVerified = false; note(`Plan revision ${task.plan.revision} adopted. Active outcome: ${activeStep(task.plan)?.objective ?? 'all checked'}`);
      } finally { task.metrics.helperMs += performance.now() - t; }
    };
    const successful = (observation:Observation) => {
      task.verification = verify(observation,input.until);
      return task.plan ? completedPlan(task.plan) && task.completionReportedBy === 'jev' && (!input.until.length || task.verification.passed) : task.verification.passed;
    };
    const completeMilestone = (observation:Observation) => {
      const step = activeStep(task.plan);
      if (!step || !task.plan) return;
      // Jev owns the checklist. Keep a snapshot for inspection, not as an approval gate.
      const records = milestoneEvidence(observation,step);
      if(step.produces && !task.artifacts.some(a=>a.key===step.produces)) {
        const matches=task.artifacts.filter(a=>a.source.includes(`stage:${step.id}`) && artifactVisible(observation,a.value));
        if(matches.length===1) retainArtifact(task.artifacts,step.produces,matches[0].value,matches[0].source,'observed');
        else note(`No unambiguous retained text for ${step.produces}; Jev may capture it when needed.`);
      }
      completeStep(task.plan,`Jev marked complete in ${observation.targetId ?? observation.title}; not independently verified.`,records);
      task.completionReportedBy='jev';
      note(`Jev completed milestone: ${step.objective}. Next: ${activeStep(task.plan)?.objective ?? 'finished'}`);
      attempts.clear(); failed.clear(); idle=0;
    };
    try {
      signal.throwIfAborted();
      // Workflows own one watcher across stages; ordinary tasks arm before observation/planning.
      if(!parentSignal) stopActivity=await this.services.userActivity?.(driver,signal,interrupted);
      signal.throwIfAborted();
      for (let iteration = 0; iteration < input.maxSteps * 2 + 12; iteration++) {
        signal.throwIfAborted();
        let t = performance.now();
        const observation = pending ?? await driver.observe(); pending = undefined;
        signal.throwIfAborted(); task.metrics.observeMs += performance.now() - t;
        task.lastObservation = observation; task.memory = observation.memory; clipboardStart ??= observation.clipboard?.changeCount;
        for (const item of observation.memory ?? []) retainArtifact(task.artifacts,item.key,item.value,item.source,'observed');
        const stage = activeStep(task.plan)?.id ?? 'goal', digest = `${stage}|${progressDigest(observation)}`;
        if (previous) {
          // A fresh post-action observation now replaces the provisional dispatch receipt.
          // Keep it until this point so interruption during observation cannot lose it.
          if(previous.provisionalReceipt) task.pendingActions=task.pendingActions?.filter(p=>p!==previous!.provisionalReceipt);
          const result = expectedResult(previous.action,previous.before,observation);
          const effect = describeEffect(previous.before,observation,previous.action);
          previous.event.effect = `${effect}; ${result.status}: ${result.expected}`;
          note(`${previous.event.action} → ${previous.event.effect}`);
          journal.push({step:task.steps,action:previous.action.kind,durationMs:previous.event.durationMs,status:result.status,category:result.category});
          if (result.status === 'unchanged') {
            idle++; failed.set(`${previous.digest}|${previous.key}`,{count:1,step:task.steps});
            lastFailure=await this.services.guides?.recordFailure(observation,{reason:`Action ${previous.action.kind} had no verified visible effect`,action:previous.action.kind,guidance:'Inspect the current interface and choose a different route or wait for an expected update.'}).catch(()=>undefined);
          } else idle = 0;
          if (previous.action.kind === 'fill' && result.status === 'confirmed') {
            for (const artifact of task.artifacts) if (artifact.value === previous.action.value) artifact.status = 'observed';
          }
          if (result.status === 'uncertain') {
            // Repeating a possibly accepted submit can create duplicates. Reobserve or advance the
            // checkpoint before that exact submission is offered in this state again.
            failed.set(`${digest}|${previous.key}`,{count:2,step:task.steps});
            if (!task.pendingActions?.some(item=>item.key===previous!.key && item.targetId===previous!.before.targetId))
              task.pendingActions?.push({key:previous.key,targetId:previous.before.targetId,stage,submission:isSubmission(previous.action,previous.before)});
          }
          if (lastFailure && result.status === 'confirmed' && !['switch','switch_tab'].includes(previous.action.kind)) {
            await this.services.guides?.recordRecovery(observation,{failureId:lastFailure,action:previous.action.kind,result:'Expected action result independently observed'}).catch(() => {});
            lastFailure = undefined;
          }
          previous = undefined;
        }
        if (task.replanReason && this.textHelper?.plan) {
          await draftPlan(observation,task.replanReason); task.replanReason=undefined;
        }
        if (!initialized) {
          initialized = true;
          if (input.planning !== 'off' && (input.plan || this.textHelper?.plan || !input.until.length)) {
            if (input.plan) task.plan = createPlan(input.plan,undefined,input.inputs);
            else if (this.textHelper?.plan) {
              try { await draftPlan(observation); }
              catch(error) { signal.throwIfAborted(); note(`Planner unavailable (${error instanceof Error ? error.message.slice(0,250) : 'invalid plan'}); retaining the complete user goal as one outcome.`); }
            }
            task.plan ??= createPlan([{objective:input.goal.slice(0,400),doneWhen:input.goal.slice(0,600),uses:[]}]);
          }
          if (!task.plan && !input.until.length) throw new BlockedError('An outcome verifier or explicit completion condition is required. Configure Jev or supply until.');
        }
        if (successful(observation)) { task.status = 'succeeded'; task.reason = task.plan ? 'Jev completed its checklist.' : 'All requested conditions were independently observed.'; return; }
        if (task.steps >= input.maxSteps) throw new BlockedError('Step limit reached before the success conditions were observed. Continue retains the plan and exact content.');
        if (idle >= 3) {
          if (!await repair(observation,'Recent actions had no useful effect. Reinspect the active milestone, use another control, OCR, wait for change, or modify the plan.'))
            throw new BlockedError('Repeated actions made no visible progress after recovery. The plan and content are retained for continuation.');
          idle = 0;
        }
        const mergedInput = taskInputs(input,observation,task.artifacts);
        const focused = focusView(observation,`${activeStep(task.plan)?.objective ?? input.goal} ${Object.keys(input.inputs).join(' ')}`,expanded ? 240 : 120);
        const canCopyText = process.platform === 'darwin' || wantsTextCopy(input.goal), view = canCopyText ? withCopyableText(focused) : focused;
        const candidates = candidatesFor(view,mergedInput.inputs,{factored:this.decider.factored,canCompose:Boolean(this.textHelper),canCopyText});
        if (this.textHelper) candidates.draft = {action:{kind:'draft'},description:'Request candidate prose from the writing helper and let Jev choose text to retain for this objective, without typing or requiring an editor.'};
        if (activeStep(task.plan)) {
          candidates.complete_milestone = {action:{kind:'complete_milestone'},description:`Mark the active milestone complete when you judge its objective finished: ${activeStep(task.plan)!.doneWhen}`};
          candidates.done.description = 'Declare the entire user task finished. You own the completion decision; review the requested endpoint and current state.';
        }
        if (this.textHelper?.plan && task.plan && task.plan.revision < 4)
          candidates.modify_plan = {action:{kind:'modify_plan'},description:'Ask the text helper to revise remaining outcome milestones using the current interface and errors. Keep the user goal and completed work.'};
        if (!expanded) candidates.inspect_more = {action:{kind:'inspect_more'},description:'Inspect more observed controls when the focused view omits a needed target.'};
        if (repairs > 0 || observation.ocr?.used)
          candidates.request_vision = {action:{kind:'request_vision'},description:'Ask the host agent to inspect a screenshot when text and controls cannot resolve a visual question. Preserve the task.'};
        const withdrawn:string[] = []; let hasLoop=false;
        for (const [key,candidate] of Object.entries(candidates)) {
          if (typeof candidate.action === 'string') continue;
          const signature = `${digest}|${semanticAction(candidate.action,observation)}`, failure = failed.get(signature);
          const pendingReceipt=task.pendingActions?.some(item=>item.targetId===observation.targetId && (item.key===semanticAction(candidate.action as Action,observation) || item.submission && isSubmission(candidate.action as Action,observation)));
          if (pendingReceipt || (failure && (failure.count >= 2 || failure.step === task.steps)) || (attempts.get(signature) ?? 0) >= 2) {
            withdrawn.push(candidate.description); delete candidates[key];
            if(!pendingReceipt) hasLoop=true;
          }
        }
        if (withdrawn.length) {
          note(`Already tried without completing this milestone in the same state: ${withdrawn.slice(0,4).join('; ')}. Choose another route or recovery tool.`);
          if (repairs < 2 && hasLoop) await repair(observation,'Repeated actions were withdrawn. Focus on the active outcome; app switching alone does not complete it.');
        }
        if (hasLoop && candidates.scan_screen)
          note('OCR recovery is available: choose scan_screen to look for the missing control in rendered text, then use an observed label to reveal or focus it instead of repeating the same field action.');
        const context = await contextFor(observation);
        const decision = await this.decider.decide(mergedInput,view,candidates,history,signal,context);
        signal.throwIfAborted(); task.metrics.modelCalls += decision.modelCalls ?? 1; task.metrics.decisionMs += decision.latencyMs;
        if (decision.trace) task.trace.push({step:task.steps+1,latencyMs:decision.latencyMs,elements:view.elements.length,...decision.trace});
        task.lastDecision = {action:candidates[decision.choice]?.description ?? 'Unknown action',confidence:decision.confidence,probability:decision.probability};
        const selected = candidates[decision.choice]; if (!selected) throw new Error('Decision did not match an offered action.');
        if (selected.action === 'emergency_stop') {
          task.events.push({step:task.steps,action:'Emergency stop selected by Jev',confidence:decision.confidence,durationMs:0,effect:'Stopped immediately; no recovery or further UI actions'});
          task.status='cancelled';task.reason='Jev selected EMERGENCY STOP. Task stopped; no automatic retry.';return;
        }
        if (decision.confidence < input.minConfidence || selected.action === 'blocked') {
          if (await repair(observation,decision.confidence < input.minConfidence ? 'The last choice was uncertain; inspect the interface and choose a clearer route.' : 'Jev requested help continuing the active milestone.')) continue;
          throw new BlockedError('Recovery exhausted. Continue with additional guidance; the plan and exact content have been retained.');
        }
        if (selected.action === 'done' || selected.action.kind === 'complete_milestone') {
          task.steps++; t = performance.now();
          const settled = await driver.observe(); signal.throwIfAborted(); task.lastObservation = settled;
          if(task.plan) {
            if(selected.action === 'done') while(activeStep(task.plan)) completeMilestone(settled);
            else completeMilestone(settled);
          }
          const explicit = verify(settled,input.until);
          task.verification=explicit;
          task.events.push({step:task.steps,action: selected.action === 'done' ? 'Jev declared the task complete' : 'Jev completed the current milestone',
            confidence:decision.confidence,durationMs:Math.round(performance.now()-t),effect:'Checklist updated by Jev; no secondary approval requested'});
          if((!task.plan || completedPlan(task.plan)) && input.until.length && !explicit.passed)
            throw new BlockedError('Jev reported completion, but the user-supplied success conditions were not observed.');
          if(!task.plan || successful(settled)) {task.status='succeeded';task.completionReportedBy='jev';task.reason='Jev reported completion; any supplied success conditions passed.';return;}
          pending = settled; continue;
        }
        const action = selected.action, key = semanticAction(action,observation), signature = `${digest}|${key}`;
        t = performance.now(); let executed:Action = action;
        // Preserve an uncertain submission even when takeover happens before the next observation.
        let provisionalReceipt: NonNullable<Task['pendingActions']>[number] | undefined;
        if(isSubmission(action,observation) && !task.pendingActions?.some(p=>p.key===key && p.targetId===observation.targetId)) {
          provisionalReceipt={key,targetId:observation.targetId,stage,submission:true};
          task.pendingActions?.push(provisionalReceipt);
        }
        try {
          if (action.kind === 'modify_plan') { await draftPlan(observation,history.slice(-8).join('\n')); attempts.clear();failed.clear(); }
          else if (action.kind === 'inspect_more') { expanded = true; note('Expanded observation requested; inspect the newly offered controls.'); }
          else if (action.kind === 'request_vision') {
            task.handoff = {kind:'vision',reason:'Jev requested visual interpretation of the current surface. Use computer_screenshot, then computer_continue with the observation.'};
            throw new BlockedError(task.handoff.reason);
          } else if (action.kind === 'copy_text') {
            const source = view.elements.find(e => e.id === action.elementId); if (!source) throw new StaleObservationError();
            pending = await copyObservedText(driver,view,source,signal);
            if (source.value) retainArtifact(task.artifacts,activeStep(task.plan)?.produces ?? artifactKey(view,source.id),source.value,`copied from ${observation.targetId ?? observation.title}`,'observed');
          } else if (action.kind === 'compose' || action.kind === 'draft') {
            const field = action.kind === 'draft' ? {id:'task-memory',name:'Task memory draft for the active objective',role:'textbox',multiline:true,disabled:false,actions:['fill'] as Array<'fill'>} : observation.elements.find(e => e.id === action.elementId);
            if (!field || field.disabled || !field.actions.includes('fill')) throw new StaleObservationError();
            const key = `${activeStep(task.plan)?.id ?? 'goal'}:${artifactKey(observation,field.id)}`;
            const existing = task.artifacts.find(a => a.key === key);
            let value = existing?.value;
            if (value === undefined) {
              const helperStarted = performance.now(); let draft:Awaited<ReturnType<TextHelper['compose']>>;
              try { draft = await this.textHelper!.compose(mergedInput,observation,field,signal,context);task.metrics.helperCalls += draft.modelCalls ?? 1; }
              catch (error) {
                task.metrics.helperCalls += error instanceof TextHelperUnavailableError ? error.modelCalls : 1;
                signal.throwIfAborted();
                if (error instanceof TextHelperUnavailableError) throw new BlockedError(`Text helper unavailable: ${error.message}. Continue after the provider recovers; the plan and content are retained.`);
                throw new RecoverableActionError('the writing helper is temporarily unavailable','Try a retained or supplied value, wait, or choose another useful step.','helper_unavailable');
              } finally {task.metrics.helperMs += performance.now()-helperStarted;}
              signal.throwIfAborted();
              if (draft.status === 'need_input') throw new BlockedError(`The text helper still needs an exact value for ${JSON.stringify(field.name || 'unlabeled field')}. Supply the missing fact and continue; the plan and content are retained.`);
              const proposals = [...new Set(draft.candidates?.length ? draft.candidates : [draft.text])].filter(v=>v.trim());
              const choices = Object.fromEntries(proposals.map((text,index)=>[`proposal_${index}`,{action:{kind:'draft' as const},description:`Retain this proposed text for the requested purpose: ${JSON.stringify(text)}`}]));
              choices.reject = {action:{kind:'draft'},description:'Reject all proposals: none satisfies the requested purpose; ask for revised candidates.'};
              const selection = await this.decider.decide({...mergedInput,goal:`Choose the best proposed text for the active objective and destination ${field.name}. Reject all if none fits. Original goal: ${mergedInput.goal}`},observation,choices,history,signal,context);
              task.metrics.modelCalls += selection.modelCalls ?? 1; task.metrics.decisionMs += selection.latencyMs;
              const index = /^proposal_(\d+)$/.exec(selection.choice)?.[1];
              if(index === undefined || !proposals[Number(index)]) throw new RecoverableActionError('Jev rejected the writing proposals','Request revised drafts grounded in the active objective and source evidence.','draft_rejected');
              value = proposals[Number(index)];
              note(`Jev selected writing proposal ${Number(index)+1} of ${proposals.length}.`);
              if (field.inputType === 'number') {
                value=value.replace(/[$,\s]/g,'');const numeric=Number(value);
                if (!value || !Number.isFinite(numeric) || (field.min !== undefined && numeric < Number(field.min)) || (field.max !== undefined && numeric > Number(field.max)))
                  throw new RecoverableActionError('the drafted number does not fit the field','Use an exact valid number.','invalid_value');
              }
              retainArtifact(task.artifacts,key,value,`writer for ${observation.targetId ?? observation.title}; stage:${activeStep(task.plan)?.id ?? 'goal'}`,'drafted');
            }
            if(action.kind === 'draft') {
              retainArtifact(task.artifacts,activeStep(task.plan)?.produces ?? key,value,'Jev-selected writing proposal','drafted');
              note('Selected draft retained in task memory; nothing was typed or sent.');
            } else {
              executed={kind:'fill',elementId:field.id,value};
              pending=await driver.act(executed,observation,signal) ?? undefined;
            }
          } else {
            pending=await driver.act(action,action.kind === 'remember' ? view : observation,signal) ?? undefined;
            signal.throwIfAborted();
            if (action.kind === 'fill' && !action.submit) retainArtifact(task.artifacts,`${activeStep(task.plan)?.id ?? 'goal'}:${artifactKey(observation,action.elementId)}`,action.value,`supplied text; stage:${activeStep(task.plan)?.id ?? 'goal'}`,'drafted');
            if (action.kind === 'remember') {
              const source=view.elements.find(e=>e.id===action.elementId);
              if(source?.value) retainArtifact(task.artifacts,activeStep(task.plan)?.produces ?? artifactKey(observation,source.id),source.value,`observed in ${observation.targetId ?? observation.title}`,'observed');
            }
          }
        } catch (error) {
          if (error instanceof StaleObservationError && staleStreak++ < 3) {
            if(provisionalReceipt) task.pendingActions=task.pendingActions?.filter(p=>p!==provisionalReceipt);
            task.metrics.staleRetries++;continue;
          }
          if (error instanceof RecoverableActionError && task.metrics.actionRecoveries < 16 && !signal.aborted) {
            // The driver reported a recoverable failure rather than an interrupted dispatch.
            // Preserve normal wait-and-retry behavior for controls that were not actionable.
            if(provisionalReceipt) task.pendingActions=task.pendingActions?.filter(p=>p!==provisionalReceipt);
            const durationMs=Math.round(performance.now()-t);task.metrics.executionMs+=durationMs;task.metrics.actionRecoveries++;task.steps++;
            failed.set(signature,{count:(failed.get(signature)?.count ?? 0)+1,step:task.steps});
            const effect=`${error.message} ${error.guidance}`;task.events.push({step:task.steps,action:selected.description,confidence:decision.confidence,durationMs,effect});note(`${selected.description} → ${effect}`);
            journal.push({step:task.steps,action:action.kind,durationMs,status:'failed',category:error.category});
            lastFailure=await this.services.guides?.recordFailure(observation,{reason:`Action ${action.kind} failed (${error.category.replace(/[^a-z_]/g,'').slice(0,50)})`,guidance:'Observe again and compare the requested outcome with the current interface before choosing another route.',action:action.kind}).catch(()=>undefined);
            if(task.metrics.actionRecoveries%2===0) await repair(await driver.observe(),'Choose a recovery using the concrete error and active milestone.');
            staleStreak=0;continue;
          }
          throw error;
        }
        signal.throwIfAborted();staleStreak=0;
        const durationMs=Math.round(performance.now()-t);attempts.set(signature,(attempts.get(signature)??0)+1);
        task.metrics.executionMs+=durationMs;task.steps++;
        const event={step:task.steps,action:selected.description,confidence:decision.confidence,durationMs};task.events.push(event);
        if (!['modify_plan','inspect_more','draft'].includes(action.kind)) {previous={action:executed,key,before:action.kind === 'copy_text' ? view : observation,digest,event,provisionalReceipt};expanded=false;}
      }
      throw new BlockedError('Recovery budget exhausted; continue retains the plan and content.');
    } catch (error) {
      const cause=signal.aborted ? signal.reason : error;
      task.status=cause instanceof UserActivityError ? 'interrupted' : cause instanceof UserActivityMonitorError ? 'blocked'
        : signal.aborted?(deadline?'timed_out':'cancelled'):error instanceof BlockedError?'blocked':'failed';
      task.reason=cause instanceof UserActivityError || cause instanceof UserActivityMonitorError ? cause.message
        : signal.aborted?(deadline?'Task deadline exceeded.':'Task cancelled.'):error instanceof Error?error.message:'Unexpected execution error.';
      if(cause instanceof UserActivityError) {
        task.interruption={kind:cause.kind,detectedAt:cause.detectedAt};
        note('User took control. Observe the current interface before continuing; a dispatched action may have completed.');
      }
    } finally {
      stopActivity?.(); parentSignal?.removeEventListener('abort',parentAborted);
      clearTimeout(timeout);task.finishedAt=Date.now();task.metrics.elapsedMs=Math.round(performance.now()-started);
      task.metrics.observeMs=Math.round(task.metrics.observeMs);task.metrics.executionMs=Math.round(task.metrics.executionMs);task.metrics.helperMs=Math.round(task.metrics.helperMs);
      if(this.services.traceDir) {
        try {
          await mkdir(this.services.traceDir,{recursive:true,mode:0o700});
          const path=join(this.services.traceDir,`${task.id}.json`);
          // Deliberately omit goal, screenshots, page text, field values, recipient identity and
          // model payloads. Host inspection can retrieve task state explicitly while it is alive.
          await writeFile(path,JSON.stringify({id:task.id,status:task.status,startedAt:task.startedAt,metrics:task.metrics,
            plan:task.plan?.steps.map(s=>({id:s.id,status:s.status})),artifacts:task.artifacts.map(a=>({status:a.status,characters:a.value.length})),events:journal},null,2),{mode:0o600});task.journal=path;
        } catch { /* A diagnostic write must not alter the task outcome. */ }
      }
      this.owners.delete(driver.id);this.controllers.delete(task.id);
    }
  }
}
