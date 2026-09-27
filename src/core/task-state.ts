import { createHash } from 'node:crypto';
import { planStepSchema, type Action, type Observation, type PlanStepDraft, type TaskArtifact, type TaskInput, type TaskPlan } from './types.js';

export const activeStep = (plan?: TaskPlan) => plan?.steps.find(s => s.status !== 'complete');
export const completedPlan = (plan?: TaskPlan) => Boolean(plan?.steps.length && plan.steps.every(s => s.status === 'complete'));
export function createPlan(drafts: PlanStepDraft[], previous?: TaskPlan, supplied: Record<string,string> = {}): TaskPlan {
  if (!drafts.length || drafts.length > 8) throw new Error('A plan needs 1–8 outcome milestones.');
  const parsed = drafts.map(d => planStepSchema.parse(d));
  const produced = new Set<string>([...Object.keys(supplied),...Object.values(supplied)]);
  for (const step of parsed) {
    if (step.uses.some(key => !produced.has(key))) throw new Error('Artifact dependencies must refer to an earlier output.');
    if (step.produces) {
      if (produced.has(step.produces)) throw new Error('Each named output must have one producing milestone.');
      produced.add(step.produces);
    }
  }
  const completed = previous?.steps.filter(s => s.status === 'complete') ?? [];
  for (let i = 0; i < completed.length; i++) {
    const { id, status, evidence, evidenceRecords, ...draft } = completed[i];
    if (JSON.stringify(planStepSchema.parse(draft)) !== JSON.stringify(parsed[i]))
      throw new Error('A revision must preserve completed milestones in order.');
  }
  const revision = (previous?.revision ?? 0) + 1;
  return { revision, steps: parsed.map((step, index) => index < completed.length ? completed[index] : {
    ...step, id: previous?.steps.find(old => old.status !== 'complete' && old.objective === step.objective && old.doneWhen === step.doneWhen && old.produces === step.produces && JSON.stringify(old.uses) === JSON.stringify(step.uses))?.id ?? `r${revision}_s${index + 1}`, status: index === completed.length ? 'active' : 'pending',
  }) };
}
export function completeStep(plan: TaskPlan, evidence: string, records?: Array<{id:string; text:string}>) {
  const step = activeStep(plan);
  if (!step) return;
  step.status = 'complete'; step.evidence = evidence.length > 1600 ? `${evidence.slice(0,1600)}\n[Evidence excerpt truncated]` : evidence;
  if (records) {
    // Retain the exact reviewed records for final verification. The short evidence field is only
    // a display excerpt and can omit conjunctive proof that appeared in another record.
    const selected: Array<{id:string; text:string}> = [], seen = new Set<string>();
    let budget = 8000;
    for (const record of records) {
      if (!record.id || !record.text.trim() || seen.has(record.id) || record.text.length > budget) continue;
      if (selected.length >= 16) break;
      selected.push({id:record.id,text:record.text});seen.add(record.id);budget -= record.text.length;
    }
    step.evidenceRecords = selected;
  }
  const next = activeStep(plan); if (next) next.status = 'active';
}
const secret = /password|passcode|otp|secret|token|api.?key|\bpin\b/i;
export function retainArtifact(artifacts: TaskArtifact[], key: string, value: string, source: string, status: TaskArtifact['status']) {
  if (!value.trim() || value === '[redacted]' || secret.test(key)) return;
  const previous = artifacts.find(a => a.key === key);
  // Named output is immutable until explicitly re-created under a new key. Retrying a writer must
  // not silently replace a poem/document already used in a different app.
  if (previous) { if (previous.value === value && status === 'observed') previous.status = status; return previous; }
  const item = { key: key.slice(0, 100), value: value.slice(0, 10000), source: source.slice(0, 200), status };
  if (artifacts.length >= 24) return;
  artifacts.push(item); return item;
}
export function taskInputs(input: TaskInput, observation: Observation, artifacts: TaskArtifact[]) {
  return { ...input, inputs: { ...input.inputs,
    ...Object.fromEntries((observation.memory ?? []).map(f => [`memory:${f.key} (${f.source})`, f.value])),
    ...Object.fromEntries(artifacts.map(f => [`artifact:${f.key}`, f.value])),
  } };
}
const clipEvidence = (text:string, max:number) => text.length > max ? `${text.slice(0,max)}\n[Observation excerpt truncated]` : text;
const normalize = (text: string) => text.replace(/\r\n/g, '\n').trim();
export function artifactVisible(observation: Observation, value: string) {
  const exact = normalize(value);
  return observation.elements.some(e => normalize(e.value ?? '') === exact || normalize(e.name) === exact)
    || normalize(observation.text).includes(exact);
}
export function missingArtifacts(step: PlanStepDraft, observation: Observation, artifacts: TaskArtifact[]) {
  return (step.produces ? [step.produces] : []).filter(key => {
    const artifact = artifacts.find(a => a.key === key);
    return !artifact || !artifactVisible(observation, artifact.value);
  });
}
// Only actual surface content is eligible evidence. A past action, generated draft, plan text, app
// catalog or helper's assertion cannot prove an outcome. The separate verifier judges these spans.
export function milestoneEvidence(observation: Observation, step: PlanStepDraft) {
  if (observation.kind === 'desktop' && !observation.targetId) return [];
  const evidence: Array<{id: string; text: string}> = [];
  const tokens = new Set(`${step.objective} ${step.doneWhen}`.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const score = (text: string) => [...tokens].filter(t => text.toLowerCase().includes(t)).length;
  if (observation.url) evidence.push({id:'url', text:`Observed URL: ${observation.url.slice(0, 1000)}`});
  if (observation.title) evidence.push({id:'title', text:`Observed window title: ${observation.title.slice(0, 500)}; app: ${observation.targetId ?? observation.kind}`});
  const chunks = observation.text.split(/\n/).map(s => s.trim()).filter(Boolean);
  // Retain surrounding context (recipient header next to conversation, field labels next to values).
  const windows = chunks.map((_, i) => ({id:`text:${i}`, text: clipEvidence(chunks.slice(Math.max(0,i - 1),i + 3).join('\n'),1600)}));
  const elements = observation.elements.filter(e => e.value !== '[redacted]' && (e.value || e.name)).map(e => {
    // Keep capabilities as observed facts: an empty field still proves that writing is available.
    // Missing focus is unknown, not false; these facts describe the observed surface, not which
    // application is physically in the foreground (a browser tab can be observed in the background).
    const focused = e.focused ?? (observation.focusedId ? observation.focusedId === e.id : 'unknown');
    const states = `enabled=${!e.disabled}; disabled=${e.disabled}; editable=${!e.disabled && e.actions.includes('fill')}; fill_supported=${e.actions.includes('fill')}; focused=${focused}; actions=${JSON.stringify(e.actions)}`;
    return { id:`element:${e.id}`, text: clipEvidence(`${e.role}: ${e.name}\n${states}\n${e.context ?? ''}\n${e.value ?? ''}${e.checked !== undefined ? `\nchecked=${e.checked}` : ''}${e.selected !== undefined ? `\nselected=${e.selected}` : ''}`.trim(),1800) };
  });
  const ranked = [...elements, ...windows].sort((a,b) => score(b.text) - score(a.text));
  const targetName = observation.targets?.find(target => target.id === observation.targetId)?.name;
  let snapshot = `Observed app target: ${observation.targetId ?? observation.kind}${targetName ? ` (${targetName})` : ''}; title: ${observation.title}; URL: ${observation.url ?? 'none'}\n`;
  for(const item of elements.sort((a,b)=>score(b.text)-score(a.text)).slice(0,20)) {
    if(snapshot.length + item.text.length > 6000) continue;
    snapshot += `${item.id}: ${item.text}\n`;
  }
  const textBudget=6000-snapshot.length;
  if(textBudget>150) snapshot+=`\nVisible text: ${clipEvidence(observation.text,Math.min(1500,textBudget-60))}`;
  evidence.unshift({id:'current_snapshot',text:snapshot});
  const seen = new Set<string>();
  for (const item of ranked) {
    if (seen.has(item.text)) continue;
    if (evidence.length >= 16 || evidence.reduce((n,e) => n+e.text.length,0) + item.text.length > 10000) break;
    seen.add(item.text); evidence.push(item);
  }
  return evidence;
}
export function semanticElement(observation: Observation, id: string) {
  const element = observation.elements.find(e => e.id === id);
  if (!element) return id;
  return [element.role, element.actions.includes('fill') && element.name === element.value ? '' : element.name,
    element.context ?? '', element.bounds ? [Math.round(element.bounds.x/8),Math.round(element.bounds.y/8)] : ''];
}
export function semanticAction(action: Action, observation: Observation) {
  if(action.kind === 'press' && ['Tab','ArrowDown','ArrowUp','ArrowLeft','ArrowRight'].includes(action.key))
    return JSON.stringify({...action,focus:observation.focusedId ? semanticElement(observation,observation.focusedId) : null});
  return JSON.stringify('elementId' in action ? { ...action, elementId: semanticElement(observation,action.elementId) } : action);
}
export function artifactKey(observation: Observation, elementId: string) {
  return `text_${createHash('sha256').update(JSON.stringify([observation.targetId,observation.url,semanticElement(observation,elementId)])).digest('hex').slice(0,12)}`;
}
export interface ActionResult { status: 'confirmed' | 'changed' | 'unchanged' | 'uncertain'; expected: string; category?: string }
export function expectedResult(action: Action, before: Observation, after: Observation): ActionResult {
  const unchanged: ActionResult = { status:'unchanged', expected:'A visible effect of the selected action', category:'no_visible_effect' };
  if (action.kind === 'fill') {
    const old = before.elements.find(e => e.id === action.elementId);
    const field = after.elements.find(e => e.id === action.elementId) ?? after.elements.find(e =>
      e.role === old?.role && e.name === old?.name && e.context === old?.context);
    if (action.submit) return {status:'uncertain', expected:'The requested submission has an observed receipt; a filled field alone does not prove acceptance', category:'submission_unverified'};
    if (field?.value === action.value) return {status:'confirmed',expected:'The chosen field contains the exact text'};
    return {status: action.submit ? 'uncertain' : 'unchanged', expected: 'The chosen field contains the exact text', category:'value_not_verified'};
  }
  if (action.kind === 'switch') return {status: after.targetId === action.targetId ? 'confirmed' : 'unchanged',expected:`The requested app is active`};
  if (action.kind === 'switch_tab') return {status:after.activeTabId === action.tabId?'confirmed':'unchanged',expected:'The requested tab is active'};
  if (action.kind === 'copy_text') {
    const value = before.elements.find(e => e.id === action.elementId)?.value;
    return {status: value?.trim() && value !== '[redacted]' && after.clipboard?.copiedText === value ? 'confirmed' : 'uncertain',
      expected:'The clipboard contains the exact selected text'};
  }
  if (action.kind === 'remember') return {status:'confirmed',expected:'Observed text retained in task memory'};
  if (isSubmission(action,before)) return {status:'uncertain',expected:'The intended confirmation is visible; inspect before repeating a possible submission',category:'submission_unverified'};
  if (before.text !== after.text || before.url !== after.url || before.title !== after.title ||
    before.scroll?.y !== after.scroll?.y || before.modal?.kind !== after.modal?.kind ||
    JSON.stringify(before.elements.map(e => [e.role,e.name,e.value,e.checked,e.selected,e.focused])) !==
    JSON.stringify(after.elements.map(e => [e.role,e.name,e.value,e.checked,e.selected,e.focused])))
    return {status:'changed',expected:'A visible effect; milestone completion still needs evidence'};
  return unchanged;
}

// A possibly accepted submission needs an observed receipt before using another submission route.
export function isSubmission(action:Action, observation:Observation) {
  if(action.kind==='fill' && action.submit) return true;
  if(action.kind==='press' && action.key==='Enter') {
    const focused=observation.elements.find(e=>e.id===observation.focusedId || e.focused);
    if(focused && (/combobox|AXComboBox|AXPopUpButton|AXMenuItem|^option$|^menuitem$|search/i.test(focused.role) || /search/i.test(focused.name))) return false;
    return true;
  }
  if(action.kind!=='click') return false;
  const label=observation.elements.find(e=>e.id===action.elementId)?.name.trim() ?? '';
  return /^(send|submit|publish|post|pay|purchase|place order|delete|save)(?:$|\s)/i.test(label);
}
