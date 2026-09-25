import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { BlockedError, candidatesFor, RecoverableActionError, StaleObservationError, verify, type Action, type Condition, type Decider, type DecisionTrace, type Driver, type Observation, type TaskInput, type TextHelper } from './types.js';
import { describeCondition, describeEffect, focusView, progressDigest } from './scene.js';

export type Status = 'running' | 'succeeded' | 'blocked' | 'failed' | 'cancelled' | 'timed_out';
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
  continuedFrom?: string;
}
const actionKey = (action: Action) => JSON.stringify(action);
export class TaskRunner {
  private tasks = new Map<string, Task>();
  private controllers = new Map<string, AbortController>();
  private completions = new Map<string, Promise<void>>();
  private owners = new Map<string, string>();
  private inputs = new Map<string, TaskInput>();
  constructor(private decider: Decider, private textHelper?: TextHelper) {}
  busy(sessionId: string) { return this.owners.has(sessionId); }
  start(driver: Driver, input: TaskInput) {
    if (this.busy(driver.id)) throw new Error('A task is already running in this session. Cancel it or wait.');
    this.prune();
    const task: Task = { id: randomUUID(), sessionId: driver.id, status: 'running', startedAt: Date.now(), steps: 0,
      request: { goal: input.goal, until: structuredClone(input.until), inputNames: Object.keys(input.inputs) },
      metrics: { elapsedMs: 0, observeMs: 0, decisionMs: 0, executionMs: 0, modelCalls: 0, helperCalls: 0, helperMs: 0, staleRetries: 0, actionRecoveries: 0 }, events: [], trace: [] };
    const controller = new AbortController();
    this.tasks.set(task.id, task);
    this.inputs.set(task.id, structuredClone(input));
    this.controllers.set(task.id, controller);
    this.owners.set(driver.id, task.id);
    this.completions.set(task.id, this.run(driver, input, task, controller));
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
    const result = this.start(driver, { ...original, inputs: merged, goal, minConfidence: minConfidence ?? original.minConfidence });
    this.tasks.get(result.id)!.continuedFrom = id;
    return this.get(result.id);
  }
  get(id: string, includeObservation = false) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Unknown task ID. Tasks live only for this MCP process.');
    const result = structuredClone(task);
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
  private async run(driver: Driver, input: TaskInput, task: Task, controller: AbortController) {
    let deadline = false;
    const timeout = setTimeout(() => { deadline = true; controller.abort(new Error('Task deadline exceeded.')); }, input.timeoutMs);
    const signal = controller.signal;
    const started = performance.now();
    const history: string[] = [];
    // Progress is judged on task state, not on every pixel or focus change. Repeated actions are
    // withdrawn before the next Jev choice so a loop can recover through another available route.
    const attempts = new Map<string, number>(), futile = new Map<string, number>();
    const failed = new Map<string, { count: number; step: number }>();
    let idle = 0, staleStreak = 0;
    let repairCount = 0, lastLoopRepairDigest: string | undefined;
    let pending: Observation | undefined;
    let previous: { action: Action; key: string; description: string; before: Observation; digest: string; event: Task['events'][number] } | undefined;
    let clipboardStart: number | undefined;
    try {
      for (let iteration = 0; iteration < input.maxSteps + 8; iteration++) {
        signal.throwIfAborted();
        let t = performance.now();
        const observation = pending ?? await driver.observe();
        pending = undefined;
        signal.throwIfAborted();
        task.metrics.observeMs += performance.now() - t;
        task.lastObservation = observation;
        task.memory = observation.memory;
        clipboardStart ??= observation.clipboard?.changeCount;
        const digest = progressDigest(observation);
        if (previous) {
          const effect = describeEffect(previous.before, observation, previous.action);
          previous.event.effect = effect;
          history.push(`${previous.description} → ${effect}${observation.title !== previous.before.title ? `; now ${observation.title}` : ''}`);
          // Opening controls is progress even if the compact task digest did not change.
          const unchanged = digest === previous.digest && !/\b[1-9]\d* controls appeared\b/.test(effect);
          if (unchanged) futile.set(`${previous.digest}|${previous.key}`, (futile.get(`${previous.digest}|${previous.key}`) ?? 0) + 1);
          idle = effect === 'no visible effect' ? idle + 1 : 0;
          previous = undefined;
        }
        task.verification = verify(observation, input.until);
        if (task.verification.passed) { task.status = 'succeeded'; task.reason = 'All requested conditions were independently observed.'; return; }
        if (task.steps >= input.maxSteps) throw new BlockedError('Step limit reached before the success conditions were observed.');
        if (idle >= 3) throw new BlockedError('The last three actions had no visible effect. Returning control to the assistant.');
        const inputs = { ...input.inputs, ...Object.fromEntries((observation.memory ?? []).map(f => [`memory:${f.key} (${f.source})`, f.value])) };
        const view = focusView(observation, `${input.goal} ${Object.keys(input.inputs).join(' ')}`);
        const surface = JSON.stringify(view.elements.map(e => [e.id, e.actions]));
        const candidates = candidatesFor(view, inputs, { factored: this.decider.factored, canCompose: Boolean(this.textHelper) });
        const withdrawn: string[] = [], unavailable: string[] = [];
        for (const [key, candidate] of Object.entries(candidates)) {
          if (typeof candidate.action === 'string') continue;
          const failure = failed.get(`${digest}|${surface}|${actionKey(candidate.action)}`);
          if (failure && (failure.count >= 2 || failure.step === task.steps)) { unavailable.push(candidate.description); delete candidates[key]; }
          else if ((attempts.get(`${digest}|${actionKey(candidate.action)}`) ?? 0) >= 2 ||
            (futile.get(`${digest}|${actionKey(candidate.action)}`) ?? 0) >= 2) { withdrawn.push(candidate.description); delete candidates[key]; }
        }
        const note = withdrawn.length ? `These actions were tried twice in the same task state without advancing the goal and are unavailable for now: ${withdrawn.slice(0, 5).join('; ')}` : '';
        if (note && history.at(-1) !== note) history.push(note);
        if (withdrawn.length && this.textHelper && repairCount < 2 && lastLoopRepairDigest !== digest) {
          lastLoopRepairDigest = digest;
          repairCount++;
          const helperStarted = performance.now();
          task.metrics.helperCalls++;
          try {
            const hint = await this.textHelper.repair(input, observation, history, signal);
            if (hint) history.push(`Text helper recovery hint: ${hint}`);
          } catch { signal.throwIfAborted(); }
          finally { task.metrics.helperMs += performance.now() - helperStarted; }
        }
        const failureNote = unavailable.length ? `Not offered again while the interface is unchanged because these actions failed: ${unavailable.slice(0, 5).join('; ')}` : '';
        if (failureNote && history.at(-1) !== failureNote) history.push(failureNote);
        const context = { conditions: task.verification.checks.map(c => ({ condition: describeCondition(c.condition, observation.targets), met: c.passed })),
          ...(observation.clipboard ? { clipboard: { hasImage: observation.clipboard.hasImage, changedSinceStart: observation.clipboard.changeCount !== clipboardStart } } : {}) };
        const decision = await this.decider.decide({ ...input, inputs }, view, candidates, history, signal, context);
        signal.throwIfAborted();
        task.metrics.modelCalls += decision.modelCalls ?? 1;
        task.metrics.decisionMs += decision.latencyMs;
        if (decision.trace) task.trace.push({ step: task.steps + 1, latencyMs: decision.latencyMs, elements: view.elements.length, ...decision.trace });
        task.lastDecision = { action: candidates[decision.choice]?.description ?? 'Unknown action', confidence: decision.confidence, probability: decision.probability };
        if (decision.confidence < input.minConfidence) throw new BlockedError('Jev confidence is below this task’s threshold. Inspect the interface or narrow the task.');
        const selected = candidates[decision.choice];
        if (!selected) throw new Error('Decision did not match an offered action.');
        if (selected.action === 'blocked') throw new BlockedError('Jev needs a missing value, unavailable control, or additional guidance.');
        if (selected.action === 'done') {
          // A native animation may finish after the action returns. Recheck once without another model round trip.
          const settleStarted = performance.now();
          await delay(120, undefined, { signal });
          const settled = await driver.observe();
          signal.throwIfAborted();
          task.metrics.observeMs += performance.now() - settleStarted;
          task.lastObservation = settled;
          task.verification = verify(settled, input.until);
          if (task.verification.passed) { task.status = 'succeeded'; task.reason = 'All requested conditions were independently observed.'; return; }
          throw new BlockedError('Jev reported completion, but the explicit success conditions were not observed.');
        }
        const key = actionKey(selected.action);
        const signature = `${digest}|${key}`;
        t = performance.now();
        try {
          const action = selected.action;
          if (action.kind === 'compose') {
            const field = observation.elements.find(e => e.id === action.elementId);
            if (!field || field.disabled || !field.actions.includes('fill')) throw new StaleObservationError();
            const helperStarted = performance.now();
            let draft: Awaited<ReturnType<TextHelper['compose']>>;
            try { draft = await this.textHelper!.compose(input, observation, field, signal); task.metrics.helperCalls += draft.modelCalls ?? 1; }
            catch (error) {
              task.metrics.helperCalls += error instanceof Error && 'modelCalls' in error && typeof error.modelCalls === 'number' ? error.modelCalls : 1;
              signal.throwIfAborted();
              throw new RecoverableActionError('the text helper could not draft this field', 'Use a supplied value or another route; the helper may be temporarily unavailable.');
            } finally { task.metrics.helperMs += performance.now() - helperStarted; }
            signal.throwIfAborted();
            if (draft.status === 'need_input') throw new BlockedError(`The field ${JSON.stringify(field.name)} needs an exact value the task has not supplied.`);
            let value = draft.text;
            if (field.inputType === 'number') {
              value = value.replace(/[$,\s]/g, '');
              const numeric = Number(value);
              if (!value || !Number.isFinite(numeric) ||
                (field.min !== undefined && numeric < Number(field.min)) || (field.max !== undefined && numeric > Number(field.max)))
                throw new RecoverableActionError('the drafted number did not fit the field', 'Choose another value or use an exact supplied number.');
            }
            pending = await driver.act({ kind: 'fill', elementId: field.id, value }, observation, signal) ?? undefined;
          } else pending = await driver.act(action, observation, signal) ?? undefined;
        }
        catch (error) {
          // A stale target is re-observed and re-decided. Only a streak of them means the interface is unusable.
          if (error instanceof StaleObservationError && staleStreak++ < 3) { task.metrics.staleRetries++; continue; }
          if (error instanceof RecoverableActionError && task.metrics.actionRecoveries < 8 && !signal.aborted) {
            const durationMs = Math.round(performance.now() - t);
            task.metrics.executionMs += durationMs;
            task.metrics.actionRecoveries++;
            task.steps++;
            const failedKey = `${digest}|${surface}|${key}`;
            failed.set(failedKey, { count: (failed.get(failedKey)?.count ?? 0) + 1, step: task.steps });
            const effect = `${error.message} ${error.guidance}`;
            task.events.push({ step: task.steps, action: selected.description, confidence: decision.confidence, durationMs, effect });
            history.push(`${selected.description} → ${effect}`);
            if (this.textHelper && task.metrics.actionRecoveries >= 2 && repairCount < 2) {
              repairCount++;
              const helperStarted = performance.now();
              task.metrics.helperCalls++;
              try {
                const current = await driver.observe();
                const hint = await this.textHelper.repair(input, current, history, signal);
                if (hint) history.push(`Text helper recovery hint: ${hint}`);
              } catch { signal.throwIfAborted(); }
              finally { task.metrics.helperMs += performance.now() - helperStarted; }
            }
            staleStreak = 0;
            continue;
          }
          if (error instanceof RecoverableActionError && task.metrics.actionRecoveries >= 8)
            throw new BlockedError('Eight browser actions failed; inspect the latest page state before continuing.');
          throw error;
        }
        signal.throwIfAborted();
        staleStreak = 0;
        const durationMs = Math.round(performance.now() - t);
        attempts.set(signature, (attempts.get(signature) ?? 0) + 1);
        task.metrics.executionMs += durationMs;
        task.steps++;
        const event = { step: task.steps, action: selected.description, confidence: decision.confidence, durationMs };
        task.events.push(event);
        previous = { action: selected.action, key, description: selected.description, before: observation, digest, event };
      }
      throw new BlockedError('Too many interface changes to safely finish this task.');
    } catch (error) {
      task.status = signal.aborted ? (deadline ? 'timed_out' : 'cancelled') : error instanceof BlockedError ? 'blocked' : 'failed';
      task.reason = signal.aborted ? (deadline ? 'Task deadline exceeded.' : 'Task cancelled.') : error instanceof Error ? error.message : 'Unexpected execution error.';
    } finally {
      clearTimeout(timeout);
      task.finishedAt = Date.now();
      task.metrics.elapsedMs = Math.round(performance.now() - started);
      task.metrics.observeMs = Math.round(task.metrics.observeMs);
      task.metrics.executionMs = Math.round(task.metrics.executionMs);
      task.metrics.helperMs = Math.round(task.metrics.helperMs);
      this.owners.delete(driver.id);
      this.controllers.delete(task.id);
    }
  }
}
