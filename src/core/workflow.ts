import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { conditionSchema, type Driver, type Observation } from './types.js';
import { TaskRunner, type Task, type Status } from './runner.js';

export const workflowSchema = z.object({
  stages: z.array(z.object({
    bundleId: z.string().min(1).max(200),
    goal: z.string().min(1).max(6000),
    inputs: z.record(z.string().max(100), z.string().max(10000)).default({}),
    inputsFrom: z.record(z.string().max(100), z.object({
      stage: z.number().int().min(0), field: z.string().min(1),
    })).default({}),
    until: z.array(conditionSchema).min(1).max(12),
    maxSteps: z.number().int().min(1).max(100).default(25),
  })).min(1).max(10),
  ocr: z.enum(['auto', 'always', 'off']).default('auto'),
  timeoutMs: z.number().int().min(1000).max(300000).default(60000),
  minConfidence: z.number().min(0).max(1).default(0.55),
}).superRefine((value, context) => {
  value.stages.forEach((stage, index) => {
    if (new Set([...Object.keys(stage.inputs), ...Object.keys(stage.inputsFrom)]).size > 20)
      context.addIssue({ code: 'custom', message: 'Supply at most 20 input values per stage.', path: ['stages', index, 'inputs'] });
    for (const [name, source] of Object.entries(stage.inputsFrom)) {
      if (source.stage >= index) context.addIssue({ code: 'custom', message: 'Input sources must refer to an earlier stage.', path: ['stages', index, 'inputsFrom', name] });
    }
  });
});
export type WorkflowInput = z.infer<typeof workflowSchema>;
export interface WorkflowDriver extends Driver { switchApp(bundleId: string): Promise<void> }
export interface Workflow {
  id: string; kind: 'workflow'; status: Status; startedAt: number; finishedAt?: number;
  stage: number; stageCount: number; reason?: string;
  stages: Array<{ bundleId: string; result: Task }>;
  metrics: { elapsedMs: number; modelCalls: number; steps: number };
}

// Holds one desktop driver/lock across all stages; the host is not called between apps.
export class WorkflowRunner {
  private records = new Map<string, Workflow>();
  private completions = new Map<string, Promise<void>>();
  private active?: { id: string; controller: AbortController; taskId?: string };
  constructor(private tasks: TaskRunner,
    private open: (bundleId: string, ocr: WorkflowInput['ocr']) => Promise<WorkflowDriver>) {}
  busy() { return Boolean(this.active); }
  has(id: string) { return this.records.has(id); }
  start(input: WorkflowInput) {
    if (this.active) throw new Error('A native workflow already owns the desktop.');
    if (this.records.size >= 50) {
      const oldest = this.records.keys().next().value!;
      this.records.delete(oldest); this.completions.delete(oldest);
    }
    const workflow: Workflow = { id: randomUUID(), kind: 'workflow', status: 'running', startedAt: Date.now(),
      stage: 0, stageCount: input.stages.length, stages: [], metrics: { elapsedMs: 0, modelCalls: 0, steps: 0 } };
    this.records.set(workflow.id, workflow);
    const active = { id: workflow.id, controller: new AbortController(), taskId: undefined as string | undefined };
    this.active = active;
    this.completions.set(workflow.id, this.run(workflow, input, active));
    return this.get(workflow.id);
  }
  get(id: string, includeObservation = false) {
    const stored = this.records.get(id);
    if (!stored) throw new Error('Unknown workflow ID.');
    const value = structuredClone(stored);
    if (this.active?.id === id && this.active.taskId) {
      const current = value.stages[value.stage];
      if (current) current.result = this.tasks.get(this.active.taskId, includeObservation);
    }
    value.metrics = { elapsedMs: (value.finishedAt ?? Date.now()) - value.startedAt,
      modelCalls: value.stages.reduce((sum, s) => sum + s.result.metrics.modelCalls, 0),
      steps: value.stages.reduce((sum, s) => sum + s.result.steps, 0) };
    if (!includeObservation) for (const stage of value.stages) delete stage.result.lastObservation;
    return value;
  }
  async wait(id: string, waitMs: number, includeObservation = false) {
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
    if (this.active?.id === id) {
      this.active.controller.abort();
      if (this.active.taskId) this.tasks.cancel(this.active.taskId);
    }
    return this.get(id);
  }
  async close() {
    if (this.active) this.cancel(this.active.id);
    await Promise.allSettled(this.completions.values());
  }
  private async run(workflow: Workflow, input: WorkflowInput, active: NonNullable<WorkflowRunner['active']>) {
    let driver: WorkflowDriver | undefined;
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; this.cancel(workflow.id); }, input.timeoutMs);
    const signal = active.controller.signal;
    const observations: Observation[] = [];
    try {
      driver = await this.open(input.stages[0].bundleId, input.ocr);
      for (const [index, stage] of input.stages.entries()) {
        signal.throwIfAborted();
        workflow.stage = index;
        if (index > 0 && stage.bundleId !== input.stages[index - 1].bundleId) await driver.switchApp(stage.bundleId);
        signal.throwIfAborted();
        const inputs = { ...stage.inputs };
        for (const [name, source] of Object.entries(stage.inputsFrom)) {
          const matches = observations[source.stage]?.elements.filter(e => e.name === source.field && e.value !== undefined);
          if (matches?.length !== 1 || matches[0].value === '[redacted]')
            throw new Error(`Stage ${index + 1} needs one unambiguous observed field: ${source.field}.`);
          inputs[name] = matches[0].value!;
        }
        const task = this.tasks.start(driver, { sessionId: driver.id, goal: stage.goal, inputs, until: stage.until,
          maxSteps: stage.maxSteps, minConfidence: input.minConfidence,
          timeoutMs: Math.max(1, input.timeoutMs - (Date.now() - workflow.startedAt)) });
        active.taskId = task.id;
        workflow.stages.push({ bundleId: stage.bundleId, result: task });
        let result: Task;
        do { result = await this.tasks.wait(task.id, 20000, true); } while (result.status === 'running');
        workflow.stages[index].result = result;
        active.taskId = undefined;
        signal.throwIfAborted();
        if (result.status !== 'succeeded') { workflow.status = result.status; workflow.reason = result.reason; return; }
        observations.push(result.lastObservation!);
      }
      workflow.status = 'succeeded';
      workflow.reason = 'Every stage completed its observable conditions.';
    } catch (error) {
      workflow.status = signal.aborted ? (timedOut ? 'timed_out' : 'cancelled') : 'failed';
      workflow.reason = signal.aborted ? (timedOut ? 'Workflow deadline exceeded.' : 'Workflow cancelled.') : error instanceof Error ? error.message : 'Workflow failed.';
    } finally {
      clearTimeout(deadline);
      try { await driver?.close(); }
      finally { workflow.finishedAt = Date.now(); this.active = undefined; }
    }
  }
}
