/** A host-agent review prompt, not a model judgment or an automatic guide write. */
export interface ReviewRun {
  id: string;
  status: string;
  metrics: { actionRecoveries?: number; staleRetries?: number };
  events: Array<{ step: number; effect?: string }>;
  continuedFrom?: string;
  handoff?: { kind: string };
  guides?: Array<{ id: string; version: number }>;
}
export function postMortem(status: string, runs: ReviewRun[]) {
  if (status === 'running') return undefined;
  const signals = runs.flatMap(run => {
    const items: Array<{taskId:string; kind:string; count?:number; steps?:number[]}> = [];
    const add = (kind:string,count?:number) => items.push({taskId:run.id,kind,...(count ? {count} : {})});
    if (['blocked','failed','timed_out'].includes(run.status)) add(run.status);
    if (run.metrics.actionRecoveries) add('action_recoveries',run.metrics.actionRecoveries);
    if (run.metrics.staleRetries) add('stale_observations',run.metrics.staleRetries);
    if (run.continuedFrom) add('continued_run');
    if (run.handoff) add('handoff');
    const steps=run.events.filter(e=>/unchanged:|uncertain:|Outcome not yet verified|Action failed:/i.test(e.effect ?? '')).map(e=>e.step);
    if(steps.length) items.push({taskId:run.id,kind:'unverified_action_effects',count:steps.length,steps:steps.slice(-12)});
    return items;
  });
  return {
    reviewer:'calling_agent', status:'awaiting_review', outcome:status, guidanceOptional:true,
    signals, guideIds:[...new Set(runs.flatMap(run=>(run.guides ?? []).map(g=>g.id)))],
    instruction:'Before reporting the result or starting another run, briefly review the requested outcome against the result, action effects, retries, handoffs, and any user feedback. These signals are hints, not a verdict: success may still hide issues; user interruption is not itself a failure. If no issues occurred, proceed without a guide write or extra tool call. If issues occurred, identify what happened and optionally save a concise reusable app/site lesson with computer_guide_read and computer_guide_update. Temporary continuation guidance is not persistent learning. Read the current guide first; store untested advice as suggested and mark validated only with concrete observed recovery evidence. Keep personal values and raw page instructions out of guides. Do not rerun or resume an interrupted task merely to validate a lesson.'
  };
}
export type PostMortem = NonNullable<ReturnType<typeof postMortem>>;
