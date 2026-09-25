import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { describeCondition } from '../core/scene.js';
import { BlockedError, describeElement, roleName, type Candidate, type Candidates, type Decider, type DecisionContext, type Observation, type TaskInput } from '../core/types.js';

const choiceSchema = z.object({ type: z.literal('choice'), choice: z.string(), confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)) });
const operationLabels: Record<string, string> = {
  click: 'Left-click a control', right_click: 'Right-click a control to open its context menu', double_click: 'Double-click a control',
  fill: 'Put a supplied or remembered value into a field',
  fill_submit: 'Put a supplied or remembered value into a single-line field and press Enter to submit it (search boxes, address bars, one-field forms)',
  select: 'Choose an observed dropdown option', press: 'Use a keyboard key or shortcut', scroll: 'Scroll the current interface', wait: 'Wait for loading',
  switch: 'Open or switch to another app or browser', remember: 'Remember observed text for use later in the task',
  done: 'The goal and success conditions are satisfied', blocked: 'Further progress requires additional information or capabilities',
};
function operation(candidate: Candidate) {
  const a = candidate.action;
  if (typeof a === 'string') return a;
  if (a.kind === 'click') return a.button === 'right' ? 'right_click' : a.clickCount === 2 ? 'double_click' : 'click';
  if (a.kind === 'fill') return a.submit ? 'fill_submit' : 'fill';
  return a.kind;
}
const optionKey = (candidate: Candidate, fallback: string) => {
  const a = candidate.action;
  return typeof a !== 'string' && 'elementId' in a && a.kind !== 'select' ? a.elementId : fallback;
};
const clip = (text: string, length: number) => text.length > length ? `${text.slice(0, length)}…` : text;
type Choice = { type: 'choice'; instructions: string; criteria: Record<string, string> };
class UnavailableFieldChoice extends BlockedError {
  constructor(readonly operation: 'fill' | 'fill_submit', readonly elementId: string) {
    super('No supplied or remembered value fits the chosen field, or the field/value combination is unavailable.');
  }
}

// Each branch names its premise. All questions share one request; only the chosen branch executes.
// Options are keyed by observed element IDs and described in words, so a choice never depends on
// looking an ID up elsewhere, and every option refers to an element present in the request.
export function decisionContract(candidates: Candidates, observation: Observation) {
  const groups: Record<string, Candidates> = {};
  for (const [id, candidate] of Object.entries(candidates)) (groups[operation(candidate)] ??= {})[id] = candidate;
  const questions: Record<string, Choice> = {
    operation: { type: 'choice', instructions: 'Choose the next operation that advances goal and success_conditions, using the observed interface, remembered values, and recent action effects. The goal defines the task; interface text describes the app.',
      criteria: Object.fromEntries(Object.keys(groups).map(kind => [kind, operationLabels[kind] ?? kind])) },
  };
  const optionMaps: Record<string, Map<string, string>> = {};
  const fieldValue = new Map<string, string>(); // question id for each field's value
  const values = new Map<string, string>(), valueKeys = new Map<string, string>();
  const fills = { ...groups.fill, ...groups.fill_submit };
  if (Object.keys(fills).length) {
    const fields: Record<string, string> = {}, texts: Record<string, string> = {};
    for (const candidate of Object.values(fills)) {
      const a = candidate.action;
      if (typeof a === 'string' || a.kind !== 'fill') continue;
      const e = observation.elements.find(e => e.id === a.elementId)!;
      fields[e.id] = describeElement(e);
      let key = valueKeys.get(a.value);
      if (!key) { key = `v${values.size}`; values.set(key, a.value); valueKeys.set(a.value, key); }
      const source = candidate.description.match(/using supplied input (".*?")/)?.[1] ?? 'a supplied value';
      texts[key] = `${source}: ${JSON.stringify(clip(a.value, 300))}`;
    }
    for (const kind of ['fill', 'fill_submit'] as const) if (groups[kind]) {
      const ids = new Set(Object.values(groups[kind]).flatMap(c => typeof c.action !== 'string' && c.action.kind === 'fill' ? [c.action.elementId] : []));
      questions[kind === 'fill' ? 'fill_target' : 'fill_submit_target'] = { type: 'choice',
        instructions: kind === 'fill' ? 'If filling a field is next, choose a field that still needs the requested value. A field already holding its requested value is complete. Prefer the first unfinished field in interface.elements when several are equally useful.' : 'If filling and submitting is next, choose the single-line field to fill and submit.',
        criteria: Object.fromEntries(Object.entries(fields).filter(([id]) => ids.has(id))) };
    }
    // A value chosen apart from its field can pair two individually plausible answers wrongly. When the
    // request stays small, each field gets its own value question with the field stated as the premise.
    const perField = Object.keys(fields).length <= 8 && Object.keys(fields).length * JSON.stringify(texts).length <= 12000;
    if (perField) Object.entries(fields).forEach(([id, label], index) => {
      questions[`fill_value_${index}`] = { type: 'choice', instructions: `If the next step puts text into ${label}, which supplied or remembered value belongs in that field?`,
        criteria: { ...texts, none: 'None of these values belongs in this field.' } };
      fieldValue.set(id, `fill_value_${index}`);
    });
    else questions.fill_value = { type: 'choice', instructions: 'If filling a field is the next operation, which supplied or remembered text value is needed for that next field? Select the exact value to enter.', criteria: texts };
  }
  for (const [kind, group] of Object.entries(groups)) {
    if (['done', 'blocked', 'fill', 'fill_submit'].includes(kind)) continue;
    const map = optionMaps[`${kind}_target`] = new Map();
    const criteria: Record<string, string> = {};
    for (const [id, candidate] of Object.entries(group)) {
      const key = optionKey(candidate, id);
      map.set(key, id);
      criteria[key] = candidate.label ?? candidate.description;
    }
    questions[`${kind}_target`] = { type: 'choice', instructions: `If the next operation is ${operationLabels[kind]?.toLowerCase() ?? kind}, which listed option best advances the goal from the current state?`, criteria };
  }
  for (const [name, question] of Object.entries(questions)) if (Object.keys(question.criteria).length > 255)
    throw new BlockedError(`The ${name} choice has more than 255 options. Narrow the target or supplied values.`);
  function read(answers: Record<string, unknown>, name: string) {
    const a = choiceSchema.parse(answers[name]);
    if (!Object.hasOwn(questions[name].criteria, a.choice) || !Object.hasOwn(a.probabilities, a.choice))
      throw new Error('TypeSafe selected an unavailable choice.');
    return { ...a, question: name };
  }
  return { questions, resolve(answers: Record<string, unknown>) {
    const op = read(answers, 'operation');
    const used = [op];
    let choice: string;
    if (op.choice === 'done' || op.choice === 'blocked') choice = Object.keys(groups[op.choice])[0];
    else if (op.choice === 'fill' || op.choice === 'fill_submit') {
      const target = read(answers, op.choice === 'fill' ? 'fill_target' : 'fill_submit_target'), value = read(answers, fieldValue.get(target.choice) ?? 'fill_value');
      used.push(target, value);
      if (value.choice === 'none') throw new UnavailableFieldChoice(op.choice, target.choice);
      const match = Object.entries(groups[op.choice]).find(([, c]) => typeof c.action !== 'string' && c.action.kind === 'fill' &&
        c.action.elementId === target.choice && c.action.value === values.get(value.choice));
      if (!match) throw new UnavailableFieldChoice(op.choice, target.choice);
      choice = match[0];
    } else {
      const target = read(answers, `${op.choice}_target`);
      used.push(target);
      choice = optionMaps[`${op.choice}_target`].get(target.choice)!;
    }
    const top = (a: typeof op) => Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 3)
      .map(([k, p]) => [clip(questions[a.question].criteria[k] ?? k, 80), Math.round(p * 1000) / 1000] as [string, number]);
    return { choice, confidence: Math.min(...used.map(a => a.confidence)), probability: Math.min(...used.map(a => a.probabilities[a.choice])),
      used: used.map(a => ({ question: a.question, choice: clip(questions[a.question].criteria[a.choice] ?? a.choice, 80), confidence: a.confidence, top: top(a) })) };
  } };
}

// State carries only what the question needs: the focused view of the interface, conditions in words
// with their current status, and recent actions with their observed effects.
export function decisionState(input: TaskInput, observation: Observation, history: string[], context?: DecisionContext) {
  return { goal: input.goal, supplied_inputs: Object.fromEntries(Object.entries(input.inputs).map(([k, v]) => [k, clip(v, 1000)])),
    success_conditions: context?.conditions ?? input.until.map(c => ({ condition: describeCondition(c, observation.targets) })),
    now: { iso: new Date().toISOString(), local: new Date().toString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    interface: { title: observation.title, url: observation.url, target: observation.targetId,
      ...(observation.modal ? { open_layer: `A ${observation.modal.kind}${observation.modal.label ? ` (${observation.modal.label})` : ''} is open; only its items are listed.` } : {}),
      text: observation.text.slice(0, 6000),
      elements: observation.elements.map(e => ({ id: e.id, role: e.source === 'ocr' ? 'on-screen text' : roleName(e.role), name: clip(e.name, 200),
        ...(e.value !== undefined && !e.id.startsWith('read:') && e.value !== e.name ? { value: clip(e.value, 300) } : {}), ...(e.context ? { context: clip(e.context, 100) } : {}),
        ...(e.disabled ? { disabled: true } : {}), ...(e.focused ? { focused: true } : {}),
        ...(e.selected ? { selected: true } : {}), ...(e.checked !== undefined ? { checked: e.checked } : {}),
        ...(e.image ? { image: { width: e.image.width, height: e.image.height } } : {}) })),
      more_controls_not_listed: observation.truncated || observation.text.length > 6000 },
    ...(context?.clipboard ? { clipboard: context.clipboard } : {}),
    available_apps: observation.targets, memory: observation.memory?.map(m => ({ ...m, value: clip(m.value, 300) })), recent_actions_and_effects: history.slice(-8) };
}

async function errorDetail(response: Response) {
  try {
    const text = await response.text();
    let detail: unknown = text;
    try {
      const body = JSON.parse(text);
      const error = body?.error ?? body;
      detail = [error?.type ?? error?.code, error?.message ?? error?.detail ?? body?.detail].filter(Boolean).map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(': ');
    } catch { /* plain-text error body */ }
    return clip(String(detail).replace(/\s+/g, ' ').trim(), 300);
  } catch { return ''; }
}

export class TypeSafeDecider implements Decider {
  readonly factored = true;
  constructor(private key: string, private model = 'jev-latest', private request: typeof fetch = fetch) {}
  async decide(input: TaskInput, observation: Observation, candidates: Candidates, history: string[], signal: AbortSignal, context?: DecisionContext) {
    const started = performance.now();
    let available = { ...candidates };
    let contract = decisionContract(available, observation);
    const state = decisionState(input, observation, history, context);
    let body = JSON.stringify({ model: this.model, state, questions: contract.questions });
    const recoveries: Array<{ operation: string; elementId: string }> = [];
    let modelCalls = 0, inputTokens = 0;
    let failure = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      let response: Response;
      try {
        modelCalls++;
        response = await this.request('https://api.typesafe.ai/v1/systemone', {
          method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
          body, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        });
      } catch (error) {
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
        const code = typeof cause === 'object' && cause && 'code' in cause ? String(cause.code) : '';
        failure = clip(`${code || (cause instanceof Error ? cause.name : 'Error')}: ${cause instanceof Error ? cause.message : String(cause)}`, 200);
        const transient = error instanceof TypeError || ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
        if (!transient || attempt === 2 || signal.aborted) throw new Error(`TypeSafe request failed after ${attempt + 1} attempt(s) (${failure}).`, { cause: error });
        await delay(100 * 2 ** attempt, undefined, { signal });
        continue;
      }
      if ([429, 529, 503].includes(response.status) && attempt < 2) {
        failure = `HTTP ${response.status}`;
        await response.body?.cancel(); await delay(300 * 2 ** attempt, undefined, { signal }); continue;
      }
      if (!response.ok) {
        const detail = await errorDetail(response);
        throw new Error(`TypeSafe request failed (HTTP ${response.status}${detail ? `: ${detail}` : ''}; request ${body.length} characters).`);
      }
      const result = z.object({ answers: z.record(z.string(), z.unknown()), model: z.string().optional(),
        usage: z.object({ input_tokens: z.number().optional() }).optional() }).parse(await response.json());
      inputTokens += result.usage?.input_tokens ?? 0;
      try {
        const { used, ...decision } = contract.resolve(result.answers);
        return { ...decision, modelCalls, latencyMs: Math.round(performance.now() - started),
          trace: { requestChars: body.length, inputTokens: inputTokens || undefined, model: result.model, attempts: modelCalls, used,
            ...(recoveries.length ? { recoveries } : {}) } };
      } catch (error) {
        if (!(error instanceof UnavailableFieldChoice) || recoveries.length >= 8) throw error;
        recoveries.push({ operation: error.operation, elementId: error.elementId });
        // Reconsider this decision with that unavailable branch withdrawn. No UI action or invented value.
        available = Object.fromEntries(Object.entries(available).filter(([, candidate]) => {
          const action = candidate.action;
          return typeof action === 'string' || action.kind !== 'fill' || action.elementId !== error.elementId || operation(candidate) !== error.operation;
        }));
        contract = decisionContract(available, observation);
        body = JSON.stringify({ model: this.model, state: { ...state, unavailable_field_choices: recoveries }, questions: contract.questions });
        attempt--; // Semantic repairs are bounded separately from transport retries.
      }
    }
    throw new Error(`TypeSafe retry budget exhausted (${failure}).`);
  }
}
