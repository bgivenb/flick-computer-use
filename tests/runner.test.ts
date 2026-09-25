import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskRunner } from '../src/core/runner.js';
import { taskSchema, type Driver, type Observation, type Decider, type TextHelper, RecoverableActionError, StaleObservationError, TextHelperUnavailableError, candidatesFor, verify } from '../src/core/types.js';

// churn: every observation differs (text, revision) while the task state does not, like a live results page.
function environment(decider: Decider, options: { stale?: boolean; alreadyDone?: boolean; mutate?: boolean; churn?: boolean; challenge?: boolean } = {}) {
  let clicks = 0;
  let attempts = 0;
  let observations = 0;
  const observe = async (): Promise<Observation> => {
    observations++;
    const churn = options.churn ? ` ${observations}` : '';
    return { id: 'o', revision: String(options.mutate === false ? 0 : clicks) + churn, sessionId: 's', kind: 'browser', title: '', text: (options.alreadyDone || (options.mutate !== false && clicks) ? 'Saved' : 'Ready') + churn,
      elements: [{ id: 'button', role: 'button', name: 'Save', disabled: false, actions: ['click'] },
        ...(options.challenge ? [{ id: 'robot', role: 'checkbox', name: "I'm not a robot", disabled: false, actions: ['click' as const] }] : [])], truncated: false, capturedAt: Date.now() };
  };
  const driver: Driver = { id: 's', kind: 'browser', label: 'test', observe,
    act: async (_, __, signal) => { signal.throwIfAborted(); if (options.stale && attempts++ === 0) throw new StaleObservationError(); clicks++; },
    screenshot: async () => Buffer.alloc(0), close: async () => {} };
  const runner = new TaskRunner(decider);
  return { runner, driver, clicks: () => clicks, input: taskSchema.parse({ sessionId: 's', goal: 'Save', until: [{ kind: 'text', text: 'Saved' }] }) };
}
// A withdrawn click leaves nothing to click; a real decider would choose another option, this one gives up.
const click: Decider = { decide: async (_, __, candidates) => ({ choice: Object.keys(candidates).find(k => candidates[k].description.startsWith('Click')) ?? 'blocked', confidence: .99, probability: .99, latencyMs: 1 }) };

test('Jev can choose Groq drafting for an observed field without pre-supplied text', async () => {
  let value = '', compositions = 0;
  const driver: Driver = { id: 's', kind: 'browser', label: 'fixture',
    observe: async () => ({ id: 'o', revision: value || 'empty', sessionId: 's', kind: 'browser', title: 'Search', text: 'Search the site',
      elements: [{ id: 'q', role: 'textbox', name: 'Search', value, disabled: false, actions: ['fill'] }], truncated: false, capturedAt: Date.now() }),
    act: async action => { assert.equal(action.kind, 'fill'); if (action.kind === 'fill') value = action.value; },
    screenshot: async () => Buffer.alloc(0), close: async () => {} };
  const helper: TextHelper = { compose: async (_input, _observation, field) => {
    compositions++; assert.equal(field.name, 'Search'); return { status: 'text', text: 'evrylo mortgage software' }; },
    repair: async () => { throw new Error('No repair needed'); } };
  const decider: Decider = { decide: async (_input, _observation, candidates) => {
    assert.ok(candidates['compose:q']);
    return { choice: 'compose:q', confidence: .99, probability: .99, latencyMs: 1 };
  } };
  const runner = new TaskRunner(decider, helper);
  const input = taskSchema.parse({ sessionId: 's', goal: 'Search for evryLO mortgage software',
    until: [{ kind: 'field', name: 'Search', value: 'evrylo mortgage software' }] });
  const result = await runner.wait(runner.start(driver, input).id, 1000);
  assert.equal(result.status, 'succeeded', result.reason);
  assert.equal(value, 'evrylo mortgage software'); assert.equal(compositions, 1);
  assert.equal(result.metrics.helperCalls, 1);
  assert.equal(result.events[0].effect, 'the field holds drafted text');
});

test('Qwen asking for a missing exact fact does not write to the interface', async () => {
  let writes = 0;
  const field = { id: 'account', role: 'textbox', name: 'Account number', disabled: false, actions: ['fill' as const] };
  const driver: Driver = { id: 's', kind: 'browser', label: 'fixture',
    observe: async () => ({ id: 'o', revision: 'r', sessionId: 's', kind: 'browser', title: 'Account', text: 'Account form', elements: [field], truncated: false, capturedAt: Date.now() }),
    act: async () => { writes++; }, screenshot: async () => Buffer.alloc(0), close: async () => {} };
  const runner = new TaskRunner({ decide: async () => ({ choice: 'compose:account', confidence: 1, probability: 1, latencyMs: 1 }) },
    { compose: async () => ({ status: 'need_input', text: '' }), repair: async () => '' });
  const input = taskSchema.parse({ sessionId: 's', goal: 'Fill account number', until: [{ kind: 'text', text: 'Saved' }] });
  const result = await runner.wait(runner.start(driver, input).id, 1000);
  assert.equal(result.status, 'blocked'); assert.equal(writes, 0); assert.match(result.reason ?? '', /exact value/);
});

test('a text-provider outage stops with its provider error instead of burning eight actions', async () => {
  const field = { id: 'search', role: 'combobox', name: 'Search', disabled: false, actions: ['fill' as const] };
  const driver: Driver = { id: 's', kind: 'browser', label: 'fixture',
    observe: async () => ({ id: 'o', revision: 'r', sessionId: 's', kind: 'browser', title: 'Search', text: '', elements: [field],
      truncated: false, capturedAt: Date.now() }),
    act: async () => { throw new Error('No action should execute.'); }, screenshot: async () => Buffer.alloc(0), close: async () => {} };
  const helper: TextHelper = { compose: async () => { throw new TextHelperUnavailableError('cerebras compose returned HTTP 503; groq compose returned HTTP 503', 2); },
    repair: async () => '' };
  const runner = new TaskRunner({ decide: async () => ({ choice: 'compose:search', confidence: 1, probability: 1, latencyMs: 1 }) }, helper);
  const input = taskSchema.parse({ sessionId: 's', goal: 'Search for evrylo.com', until: [{ kind: 'text', text: 'Found' }] });
  const result = await runner.wait(runner.start(driver, input).id, 1000);
  assert.equal(result.status, 'blocked'); assert.equal(result.steps, 0);
  assert.equal(result.metrics.helperCalls, 2); assert.equal(result.metrics.actionRecoveries, 0);
  assert.match(result.reason ?? '', /cerebras.*HTTP 503; groq.*HTTP 503/);
});

test('a composed sample amount is normalized for a numeric form field', async () => {
  let value = '';
  const field = { id: 'income', role: 'textbox', name: 'Monthly income', inputType: 'number', min: '0', disabled: false, actions: ['fill' as const] };
  const driver: Driver = { id: 's', kind: 'browser', label: 'fixture',
    observe: async () => ({ id: 'o', revision: value || 'r', sessionId: 's', kind: 'browser', title: 'Calculator', text: 'Income calculator',
      elements: [{ ...field, value }], truncated: false, capturedAt: Date.now() }),
    act: async action => { assert.equal(action.kind, 'fill'); if (action.kind === 'fill') value = action.value; },
    screenshot: async () => Buffer.alloc(0), close: async () => {} };
  const runner = new TaskRunner({ decide: async () => ({ choice: 'compose:income', confidence: 1, probability: 1, latencyMs: 1 }) },
    { compose: async () => ({ status: 'text', text: '$5,000' }), repair: async () => '' });
  const input = taskSchema.parse({ sessionId: 's', goal: 'Try the calculator with sample income numbers',
    until: [{ kind: 'field', name: 'Monthly income', value: '5000' }] });
  const result = await runner.wait(runner.start(driver, input).id, 1000);
  assert.equal(result.status, 'succeeded', result.reason); assert.equal(value, '5000');
});

test('after repeated action errors Groq guidance is passed to Jev without executing its suggestion', async () => {
  let saved = false, attempts = 0, repairs = 0;
  const driver: Driver = { id: 's', kind: 'browser', label: 'fixture',
    observe: async () => ({ id: 'o', revision: saved ? 'saved' : 'ready', sessionId: 's', kind: 'browser', title: 'Fixture',
      text: saved ? 'Saved' : 'Ready', elements: ['bad', 'good'].map(id => ({ id, role: 'button', name: id, disabled: false, actions: ['click'] })),
      truncated: false, capturedAt: Date.now() }),
    act: async action => { if ('elementId' in action && action.elementId === 'bad') { attempts++; throw new RecoverableActionError('covered', 'Try another visible route.'); }
      if ('elementId' in action && action.elementId === 'good') saved = true; },
    screenshot: async () => Buffer.alloc(0), close: async () => {} };
  const helper: TextHelper = { compose: async () => { throw new Error('No draft needed'); }, repair: async () => { repairs++; return 'Try the good button.'; } };
  const decider: Decider = { decide: async (_input, _observation, candidates, history) => ({
    choice: history.some(line => line.includes('Text helper recovery hint')) ? 'click:good' : candidates['click:bad'] ? 'click:bad' : 'wait',
    confidence: .99, probability: .99, latencyMs: 1,
  }) };
  const runner = new TaskRunner(decider, helper);
  const input = taskSchema.parse({ sessionId: 's', goal: 'Save', until: [{ kind: 'text', text: 'Saved' }] });
  const result = await runner.wait(runner.start(driver, input).id, 1000);
  assert.equal(result.status, 'succeeded', result.reason);
  assert.equal(attempts, 2); assert.equal(repairs, 1);
  assert.equal(result.metrics.helperCalls, 1);
});

test('a focus-only click loop withdraws the click, asks for a recovery hint, and lets Jev choose text composition', async () => {
  let focusedId = 'search', value = '', clicks = 0, repairs = 0, drafts = 0;
  const histories: string[][] = [];
  const driver: Driver = { id: 's', kind: 'browser', label: 'fixture',
    observe: async () => ({ id: `o${clicks}`, revision: `r${clicks}`, sessionId: 's', kind: 'browser', title: 'Search', text: 'Search the web',
      focusedId, elements: [
        { id: 'search', role: 'combobox', name: 'Search', value, focused: focusedId === 'search', disabled: false, actions: ['click', 'fill'] },
        { id: 'button', role: 'button', name: 'Google Search', focused: focusedId === 'button', disabled: false, actions: ['click'] },
      ], truncated: false, capturedAt: Date.now() }),
    act: async action => {
      if (action.kind === 'click') { clicks++; focusedId = focusedId === 'search' ? 'button' : 'search'; }
      if (action.kind === 'fill') value = action.value;
    }, screenshot: async () => Buffer.alloc(0), close: async () => {} };
  const helper: TextHelper = { compose: async () => { drafts++; return { status: 'text', text: 'evrylo.com' }; },
    repair: async () => { repairs++; return 'The search field is empty; enter the site name from the goal.'; } };
  const decider: Decider = { decide: async (_input, _observation, candidates, history) => {
    histories.push([...history]);
    return { choice: candidates['click:search'] ? 'click:search' : 'compose:search', confidence: .99, probability: .99, latencyMs: 1 };
  } };
  const runner = new TaskRunner(decider, helper);
  const input = taskSchema.parse({ sessionId: 's', goal: 'Search for evrylo.com', until: [{ kind: 'field', name: 'Search', value: 'evrylo.com' }] });
  const result = await runner.wait(runner.start(driver, input).id, 1000);
  assert.equal(result.status, 'succeeded', result.reason);
  assert.equal(clicks, 2); assert.equal(repairs, 1); assert.equal(drafts, 1);
  assert.match(histories.at(-1)!.join(' '), /same task state.*Text helper recovery hint/);
  assert.equal(result.metrics.helperCalls, 2);
});

test('clipboard completion requires a newly copied image rather than existing clipboard contents', async () => {
  const observation = await environment(click).driver.observe();
  const conditions = [{ kind: 'clipboard_image' as const, afterChangeCount: 42 }];
  assert.equal(verify(observation, conditions).passed, false);
  assert.equal(verify({ ...observation, clipboard: { changeCount: 42, hasImage: true } }, conditions).passed, false);
  assert.equal(verify({ ...observation, clipboard: { changeCount: 43, hasImage: false } }, conditions).passed, false);
  assert.equal(verify({ ...observation, clipboard: { changeCount: 43, hasImage: true } }, conditions).passed, true);
});

test('verifies the actual result after execution, including the final allowed step', async () => {
  const e = environment(click); e.input.maxSteps = 1;
  const task = e.runner.start(e.driver, e.input);
  const result = await e.runner.wait(task.id, 1000);
  assert.equal(result.status, 'succeeded'); assert.equal(result.steps, 1); assert.equal(result.verification?.passed, true);
});
test('an already completed task costs no model call', async () => {
  const e = environment(click, { alreadyDone: true });
  const result = await e.runner.wait(e.runner.start(e.driver, e.input).id, 1000);
  assert.equal(result.status, 'succeeded'); assert.equal(result.metrics.modelCalls, 0);
});
test('a model DONE claim cannot create a false success', async () => {
  const e = environment({ decide: async () => ({ choice: 'done', confidence: 1, probability: 1, latencyMs: 1 }) });
  const result = await e.runner.wait(e.runner.start(e.driver, e.input).id, 1000);
  assert.equal(result.status, 'blocked'); assert.equal(e.clicks(), 0);
});
test('cancellation during a decision prevents the following action', async () => {
  const e = environment({ decide: async (...args) => { await delay(70); return click.decide(...args); } });
  const task = e.runner.start(e.driver, e.input);
  await delay(10); e.runner.cancel(task.id);
  assert.throws(() => e.runner.start(e.driver, e.input), /already running/);
  const result = await e.runner.wait(task.id, 1000);
  assert.equal(result.status, 'cancelled'); assert.equal(e.clicks(), 0); assert.equal(e.runner.busy('s'), false);
});
test('stale decisions are discarded and re-observed', async () => {
  const e = environment(click, { stale: true });
  const result = await e.runner.wait(e.runner.start(e.driver, e.input).id, 1000);
  assert.equal(result.status, 'succeeded'); assert.equal(e.clicks(), 1); assert.equal(result.metrics.staleRetries, 1);
});
test('a failed browser action gives Jev its reason and a fresh alternative', async () => {
  let saved = false, badAttempts = 0;
  const histories: string[][] = [];
  const driver: Driver = { id: 's', kind: 'browser', label: 'test',
    observe: async () => ({ id: 'o', revision: saved ? 'saved' : 'ready', sessionId: 's', kind: 'browser', title: 'Fixture',
      text: saved ? 'Saved' : 'Ready', capturedAt: Date.now(), truncated: false,
      elements: ['bad', 'good'].map(id => ({ id, role: 'button', name: id, disabled: false, actions: ['click'] })) }),
    act: async action => {
      if ('elementId' in action && action.elementId === 'bad') { badAttempts++; throw new RecoverableActionError('another element covered the target', 'Choose another visible route.'); }
      saved = true;
    },
    screenshot: async () => Buffer.alloc(0), close: async () => {} };
  const decider: Decider = { decide: async (_input, _observation, candidates, history) => {
    histories.push([...history]);
    return { choice: candidates['click:bad'] ? 'click:bad' : 'click:good', confidence: .99, probability: .99, latencyMs: 1 };
  } };
  const runner = new TaskRunner(decider);
  const input = taskSchema.parse({ sessionId: 's', goal: 'Save', until: [{ kind: 'text', text: 'Saved' }] });
  const result = await runner.wait(runner.start(driver, input).id, 1000);
  assert.equal(result.status, 'succeeded', result.reason);
  assert.equal(badAttempts, 1);
  assert.equal(result.metrics.actionRecoveries, 1);
  assert.match(histories[1].join(' '), /another element covered the target.*Choose another visible route/);
  assert.match(result.events[0].effect ?? '', /Browser action failed/);
});
test('Jev may retry a transient failure after choosing to wait', async () => {
  let attempts = 0, done = false;
  const driver: Driver = { id: 's', kind: 'browser', label: 'test',
    observe: async () => ({ id: 'o', revision: 'same', sessionId: 's', kind: 'browser', title: 'Fixture',
      text: done ? 'Saved' : 'Ready', capturedAt: Date.now(), truncated: false,
      elements: [{ id: 'save', role: 'button', name: 'Save', disabled: false, actions: ['click'] }] }),
    act: async action => {
      if (action.kind !== 'click') return;
      if (++attempts === 1) throw new RecoverableActionError('the target did not become actionable in time', 'Wait for loading or choose another control.');
      done = true;
    },
    screenshot: async () => Buffer.alloc(0), close: async () => {} };
  const decider: Decider = { decide: async (_input, _observation, candidates) => ({
    choice: candidates['click:save'] ? 'click:save' : 'wait', confidence: .99, probability: .99, latencyMs: 1,
  }) };
  const runner = new TaskRunner(decider);
  const input = taskSchema.parse({ sessionId: 's', goal: 'Save', until: [{ kind: 'text', text: 'Saved' }] });
  const result = await runner.wait(runner.start(driver, input).id, 1000);
  assert.equal(result.status, 'succeeded', result.reason);
  assert.equal(attempts, 2);
  assert.equal(result.metrics.actionRecoveries, 1);
  assert.deepEqual(result.events.map(event => event.action.startsWith('Click') ? 'click' : 'wait'), ['click', 'wait', 'click']);
});
test('a task stops instead of repeatedly clicking an unchanged interface', async () => {
  const e = environment(click, { mutate: false });
  const result = await e.runner.wait(e.runner.start(e.driver, e.input).id, 1000);
  assert.equal(result.status, 'blocked'); assert.equal(e.clicks(), 2);
  assert.deepEqual(result.events.map(event => event.effect), ['no visible effect', 'no visible effect']);
});
test('a constantly changing page cannot hide a repeated no-progress click or cause stale rejections', async () => {
  const e = environment(click, { mutate: false, churn: true });
  const result = await e.runner.wait(e.runner.start(e.driver, e.input).id, 1000);
  assert.equal(result.status, 'blocked', result.reason); assert.equal(e.clicks(), 2); assert.equal(result.metrics.staleRetries, 0);
  assert.equal(result.events[0].effect, 'some text changed');
});
test('unrelated verification-widget text does not prevent an otherwise valid task', async () => {
  const e = environment(click, { challenge: true });
  const result = await e.runner.wait(e.runner.start(e.driver, e.input).id, 1000);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.metrics.modelCalls, 1); assert.equal(e.clicks(), 1);
});
test('a task records its request, each decision trace, and each action effect', async () => {
  const traced: Decider = { decide: async (...args) => ({ ...await click.decide(...args),
    trace: { requestChars: 1234, inputTokens: 321, model: 'jev-test', attempts: 1, used: [{ question: 'operation', choice: 'Left-click a control', confidence: .99, top: [['Left-click a control', .99]] }] } }) };
  const e = environment(traced);
  const result = await e.runner.wait(e.runner.start(e.driver, e.input).id, 1000);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.request.goal, 'Save'); assert.deepEqual(result.request.inputNames, []);
  assert.equal(result.trace[0].requestChars, 1234); assert.equal(result.trace[0].inputTokens, 321); assert.equal(result.trace[0].step, 1);
  assert.equal(result.events[0].effect, 'some text changed');
});
test('low confidence cannot cause an action', async () => {
  const e = environment({ decide: async (...args) => ({ ...await click.decide(...args), confidence: .2 }) });
  const result = await e.runner.wait(e.runner.start(e.driver, e.input).id, 1000);
  assert.equal(result.status, 'blocked'); assert.equal(e.clicks(), 0);
});
test('continuing a confidence block can use a lower threshold', async () => {
  const e = environment({ decide: async (...args) => ({ ...await click.decide(...args), confidence: .2 }) });
  e.input.minConfidence = .3;
  const first = await e.runner.wait(e.runner.start(e.driver, e.input).id, 1000);
  assert.equal(first.status, 'blocked'); assert.equal(e.clicks(), 0);
  const continued = e.runner.continue(e.driver, first.id, {}, '', 0);
  const result = await e.runner.wait(continued.id, 1000);
  assert.equal(result.status, 'succeeded', result.reason);
  assert.equal(result.continuedFrom, first.id);
  assert.equal(e.clicks(), 1);
});
test('input choices never invent text, include disabled options, or silently truncate candidates', async () => {
  const e = environment(click);
  const o = await e.driver.observe();
  o.elements = [{ id: 'field', role: 'textbox', name: 'Email', disabled: false, actions: ['fill'] }];
  const candidates = candidatesFor(o, { email: 'demo@example.com' });
  const fills = Object.values(candidates).flatMap(c => typeof c.action !== 'string' && c.action.kind === 'fill' ? [c.action] : []);
  assert.deepEqual(fills, [{ kind: 'fill', elementId: 'field', value: 'demo@example.com' }, { kind: 'fill', elementId: 'field', value: 'demo@example.com', submit: true }]);
  o.elements[0].multiline = true;
  assert.equal(Object.values(candidatesFor(o, { email: 'demo@example.com' })).filter(c => typeof c.action !== 'string' && c.action.kind === 'fill').length, 1);
  o.elements = Array.from({ length: 260 }, (_, i) => ({ id: String(i), role: 'button', name: String(i), disabled: false, actions: ['click'] }));
  assert.throws(() => candidatesFor(o, {}), /255/);
});
